import { plainToInstance } from 'class-transformer';
import { IsIn, IsInt, IsString, Matches, Max, Min, MinLength, validateSync } from 'class-validator';

class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: string = 'development';

  @IsInt() @Min(1) @Max(65535)
  PORT: number = 3000;

  @IsString() @MinLength(32, { message: 'JWT_SECRET must be at least 32 characters' })
  JWT_SECRET: string;

  @IsString()
  JWT_EXPIRES_IN: string = '1h';

  /** 32 random bytes, hex encoded. Generate with: openssl rand -hex 32 */
  @Matches(/^[0-9a-fA-F]{64}$/, { message: 'FIELD_ENCRYPTION_KEY must be 64 hex characters (32 bytes)' })
  FIELD_ENCRYPTION_KEY: string;

  @IsString() DATABASE_HOST: string;
  @IsInt() @Min(1) @Max(65535) DATABASE_PORT: number = 5432;
  @IsString() DATABASE_USER: string;
  @IsString() DATABASE_PASSWORD: string;
  @IsString() DATABASE_NAME: string;

  /** BullMQ key prefix. Tests use their own so they never consume jobs from a dev server on the same Redis. */
  @IsString() QUEUE_PREFIX: string = 'bull';

  @IsString() REDIS_HOST: string;
  @IsInt() @Min(1) @Max(65535) REDIS_PORT: number = 6379;

  @IsInt() @Min(1) @Max(20)
  RISK_JOB_ATTEMPTS: number = 4;

  @IsInt() @Min(1)
  RISK_BACKOFF_MS: number = 1000;

  /** How often the sweeper looks for applications stuck in PENDING without a live job. */
  @IsInt() @Min(1000)
  RISK_RECONCILE_INTERVAL_MS: number = 60_000;

  /** A PENDING application younger than this is assumed to be in normal processing. */
  @IsInt() @Min(1000)
  RISK_RECONCILE_STALE_MS: number = 300_000;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, { enableImplicitConversion: true });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors.map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`);
    // Property names only - never echo the offending values, they may be secrets.
    throw new Error(`Invalid environment configuration:\n  ${details.join('\n  ')}`);
  }
  return validated;
}
