# ADR-001: Architecture and security decisions for the Merchant Operations API

- **Status:** Accepted
- **Scope:** authorization model, application lifecycle, asynchronous risk review, sensitive-data handling, persistence

## Context

The API onboards merchants. Three roles (ADMIN, REVIEWER, SALES) interact with applications that contain personal data
and trigger a third-party risk check. The priorities, in order, are: no authorization bypass, correct state
transitions under concurrency, reliable async processing, and protection of PII. The time-box is a few hours, so each
decision below also states what was deliberately left for later.

## Decisions

### 1. Object-level authorization lives in one pure policy, enforced inside the transaction

`ApplicationPolicy` (`canView`, `canEdit`, `canDecide`) is a set of pure functions. The service loads the row
`SELECT … FOR UPDATE` inside a transaction and applies the policy to that locked row before doing anything else.

- Route-level `@Roles` is only a coarse first gate (and is global via `APP_GUARD`, with `@Public()` as the explicit opt-out,
  so a forgotten decorator fails closed).
- Checking against the locked row means a concurrent reassignment cannot let a former reviewer slip through
  (time-of-check/time-of-use).
- List endpoints apply the same scope in SQL (`createdById` / `assignedReviewerId`), so forbidden rows are never loaded.
- Pure functions are unit tested exhaustively and are the single place to read the rules.

**Alternatives:** CASL / a policy engine (more machinery than three roles justify); per-route guards that load the entity
(duplicates the load and can't share the lock).

### 2. Return 404, not 403, for objects the caller may not see

A 403 confirms the id exists. A SALES user probing UUIDs, or a reviewer who is not assigned, receives the same 404 as
for a non-existent id (a test asserts the bodies are identical). 403 is reserved for role-level denial, where no object
is involved.

### 2a. SALES do not see the detailed risk result

`riskResult` carries provider reasons (e.g. `WATCHLIST_MATCH`). Showing that to the sales rep who owns the application risks
tipping off the merchant, so SALES receives `riskStatus` (they need it to know whether the application is progressing) but
`riskResult: null`. ADMIN and the assigned REVIEWER receive the detail. Implemented as one pure function
(`application.view.ts`) applied to every response shape and unit/e2e tested; response DTOs would be the next step.

### 3. ADMIN cannot record a decision

The brief says *only the assigned REVIEWER may record a risk decision* and also that ADMIN has *full operational
access*. These conflict only if "full access" includes decisions. I resolved it in favour of the explicit rule: an
admin can do everything operational (create, edit, assign, reassign, read, audit) but cannot approve or reject,
which preserves separation of duties (the person who manages assignments cannot also approve). The break-glass path
is reassigning to a different reviewer, which is audited.

**Consequence:** if the business wants admin override, it is a one-line change in `ApplicationPolicy.canDecide` plus
an audit flag; the tests document the current stance.

### 4. Lifecycle is an explicit state machine; risk is a separate axis

Workflow status (`DRAFT → SUBMITTED → IN_REVIEW → APPROVED | REJECTED | NEEDS_INFORMATION`) and risk status
(`NOT_STARTED → PENDING → CLEAR | FLAGGED | FAILED`) are separate columns, because the risk result arrives
asynchronously and independently of workflow actions.

- Invariant: `IN_REVIEW` means "submitted **and** has an assigned reviewer".
- Approval requires `riskStatus = CLEAR`; rejecting or requesting information does not (a reviewer must be able to
  reject a flagged or failed application).
- Invalid transitions are `409 Conflict`. Rules are pure functions (`application-lifecycle.ts`).
- A risk result never changes workflow status on its own — only humans do.
- Concurrent actions serialise on the row lock, and the transition is validated against the latest committed state
  (tested with parallel submits and parallel decisions).

### 4a. Decimal money as strings

`requestedMonthlyVolume` / `requestedAverageTransaction` are `numeric(14,2)` / `numeric(12,2)` and travel as
validated decimal strings, avoiding binary floating point. The DTO regex rejects negatives, zero, exponent notation and
more than two fraction digits.

### 5. Async risk review: at-least-once delivery made idempotent

BullMQ is at-least-once, so correctness comes from the handler, not the transport:

- **Enqueue-side dedupe:** job id `risk-<applicationId>-<submissionVersion>`; the same submission can't create two jobs.
- **Consume-side idempotency:** the result is written only if the row is still `PENDING` for the same
  `submissionVersion`, re-checked under `FOR UPDATE`. Redelivery, crash-after-write-before-ack, or a stale job from a
  previous submission become no-ops (tested, including concurrent delivery of the same job).
- **No lock during the slow call:** the provider is called outside any transaction so a slow vendor cannot hold row locks.
- **Retries:** 4 attempts, exponential backoff from 1s (env-configurable). Provider errors propagate so BullMQ retries.
- **Exhaustion:** the `failed` event handler sets `riskStatus = FAILED` (guarded by the same stale check) and audits it, so an
  application never sits in `PENDING` forever. Recovery is *request information → resubmit*, which bumps the version and
  creates a fresh job. I chose that over a dedicated "retry risk" endpoint to avoid a second way to re-enter `PENDING`.
- **Data minimisation:** the provider receives business facts only; job payloads contain ids only.
- **Provider boundary:** `RiskProvider` is an interface bound by DI token; the simulated implementation is deterministic
  so tests and demos are reproducible, and a real vendor adapter is a drop-in.

### 6. Enqueue after commit, compensate on failure (instead of an outbox)

Writing to Postgres and Redis is a dual write. I commit first (so the worker never reads an uncommitted row), then
enqueue. If enqueue throws, a second transaction restores the previous state, audits `RISK_ENQUEUE_FAILED`, and the API
returns 503 so the client can retry. `submissionVersion` is intentionally **not** decremented so job ids are never reused.

**Gap and mitigation:** a process crash *between* commit and enqueue would leave `SUBMITTED/PENDING` with no job. This is
mitigated by `RiskReconciler`, a periodic sweeper that re-enqueues `PENDING` applications older than
`RISK_RECONCILE_STALE_MS` when their job is missing, or is parked in BullMQ's `failed` set because the worker could not persist
`FAILED`. Safe because job ids are deterministic and the worker is idempotent. Recovery latency is bounded by the stale
threshold plus the sweep interval, not instant. A transactional outbox (row written in the same transaction, relayed by a
poller) would remove the window entirely and remains the production answer.

### 7. Authentication

- JWT (HS256, explicit algorithm allow-list) carrying **only `sub`**. The role and `isActive` flag are loaded from the
  database on each request, so deactivation and role changes apply immediately instead of after token expiry. Cost: one
  indexed primary-key lookup per request.
- bcrypt cost 12; password hash is `select: false`; a dummy hash comparison equalises timing for unknown emails; unknown
  email and wrong password return the same message.
- **Not done:** refresh tokens, revocation list, login throttling/lockout, MFA. Listed as next steps.

### 8. Sensitive data

- **Encrypted at rest (field level):** `ownerName`, `contactEmail`, with AES-256-GCM (random 96-bit IV, auth tag,
  `v1:` version prefix) through a TypeORM `ValueTransformer`. Chosen because these are the only direct identifiers collected.
  **Trade-off:** encrypted columns cannot be filtered, sorted or uniquely indexed; if search by owner email is needed
  later, add a keyed HMAC "blind index" column.
- **Key management:** one key from the environment, validated at startup. Production should use KMS envelope encryption
  with rotation; the version prefix supports lazy re-encryption.
- **Would also require field-level encryption if collected:** government/tax ID, date of birth, bank account/IBAN,
  phone, address. Card numbers should never be stored — use PSP tokens.
- **Audit redaction:** `AuditService` redacts by key name (recursively) and by value shape (JWT / `Bearer …`) before insert.
  Updates record changed *field names*, not values. Reviewer notes are free text and stored as written (≤ 500 chars) —
  a deliberate, documented exception; the DTO description tells reviewers not to enter personal data.
- **Logs:** the request interceptor logs method, route, status and latency only. Validation of env vars never echoes values.

### 9. Persistence

- PostgreSQL + TypeORM with `synchronize: false` everywhere. The initial migration was generated by the CLI, reviewed,
  amended (explicit `uuid-ossp` extension), and verified by apply → revert → re-apply → no-drift check.
- All timestamps are `timestamptz`.
- Indexes follow the access paths: `(created_by_id, status)` for SALES lists, `(assigned_reviewer_id, status)` for reviewer
  lists, `(status, created_at)` for admin queues, `(resource_type, resource_id, created_at)` for audit lookups.
- Foreign keys: `created_by_id → users ON DELETE RESTRICT`; `assigned_reviewer_id → users ON DELETE SET NULL`.
  `audit_logs.resource_id` has **no** FK on purpose, so audit history outlives the data it describes.
- Audit is a Postgres table (explicitly acceptable for this time-box). Audit rows are written in the **same transaction** as
  the state change, so there is never a change without its record or a record without its change. The worker is recorded
  with a `NULL` actor (= system).
- **Not enforced:** append-only semantics at the database level (revoke `UPDATE/DELETE` from the app role, or add a trigger).

### 10. Where the worker runs

The BullMQ worker runs in the API process for simplicity (one deployable, one `docker compose up`). It uses its own
concurrency setting and shares nothing with request handling except the DB pool. For production, split it into a
separate entrypoint so API and worker scale and fail independently.

### 11. Testing strategy

- **Unit:** pure rules (lifecycle, policy, redaction, encryption, env validation, provider) and services with mocked
  ports — fast, exhaustive on branches.
- **Integration (Supertest, real Postgres):** the production `AppModule` and pipeline. The authorization suite proves, by id,
  that SALES cannot read/update/submit another user's application, that unassigned reviewers and ADMIN cannot decide, and
  that reassignment revokes access. Races are tested with parallel requests.
- **Queue-level:** one suite runs through real BullMQ/Redis; the rest use an in-memory queue double plus direct invocation
  of the real worker class, so most of the async logic is tested without needing Redis.
- The authorization tests were mutation-checked (policy deliberately broken → tests fail).

## Consequences

- Strong, auditable authorization and state integrity with little framework machinery.
- One DB round-trip per request for auth, and row locks on writes (acceptable at this scale; revisit with optimistic
  concurrency if write contention on single applications ever matters).
- Encrypted columns are not queryable.
- The dual-write window (decision 6) and in-process worker (decision 10) are the main reliability limits and the first
  things to harden.

## Deliberately out of scope

Webhook callback with signature validation, MongoDB audit store, rate limiting, refresh tokens, outbox relay,
database-enforced append-only audit.
