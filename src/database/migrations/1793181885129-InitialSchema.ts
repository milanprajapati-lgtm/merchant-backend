import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1793181885129 implements MigrationInterface {
    name = 'InitialSchema1793181885129'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE TABLE "audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "actor_id" uuid, "action" character varying(100) NOT NULL, "resource_type" character varying NOT NULL DEFAULT 'MERCHANT_APPLICATION', "resource_id" uuid NOT NULL, "metadata" jsonb NOT NULL DEFAULT '{}', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_audit_resource" ON "audit_logs" ("resource_type", "resource_id", "created_at") `);
        await queryRunner.query(`CREATE TYPE "public"."users_role_enum" AS ENUM('ADMIN', 'REVIEWER', 'SALES')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "password_hash" character varying NOT NULL, "role" "public"."users_role_enum" NOT NULL DEFAULT 'SALES', "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."merchant_applications_status_enum" AS ENUM('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED')`);
        await queryRunner.query(`CREATE TYPE "public"."merchant_applications_risk_status_enum" AS ENUM('NOT_STARTED', 'PENDING', 'CLEAR', 'FLAGGED', 'FAILED')`);
        await queryRunner.query(`CREATE TABLE "merchant_applications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "business_name" character varying NOT NULL, "legal_business_name" character varying NOT NULL, "business_type" character varying NOT NULL, "owner_name" text NOT NULL, "contact_email" text NOT NULL, "requested_monthly_volume" numeric(14,2) NOT NULL, "requested_average_transaction" numeric(12,2) NOT NULL, "status" "public"."merchant_applications_status_enum" NOT NULL DEFAULT 'DRAFT', "risk_status" "public"."merchant_applications_risk_status_enum" NOT NULL DEFAULT 'NOT_STARTED', "risk_result" jsonb, "created_by_id" uuid NOT NULL, "assigned_reviewer_id" uuid, "submission_version" integer NOT NULL DEFAULT '0', "submitted_at" TIMESTAMP WITH TIME ZONE, "decided_at" TIMESTAMP WITH TIME ZONE, "decided_by_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_09b9df0877db73b8a232c8c7ed4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_applications_status_created" ON "merchant_applications" ("status", "created_at") `);
        await queryRunner.query(`CREATE INDEX "idx_applications_reviewer_status" ON "merchant_applications" ("assigned_reviewer_id", "status") `);
        await queryRunner.query(`CREATE INDEX "idx_applications_creator_status" ON "merchant_applications" ("created_by_id", "status") `);
        await queryRunner.query(`ALTER TABLE "merchant_applications" ADD CONSTRAINT "FK_2da4df0ec53929a13cb78d8496a" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "merchant_applications" ADD CONSTRAINT "FK_7da78a3bb9e76995dba067b83ed" FOREIGN KEY ("assigned_reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchant_applications" DROP CONSTRAINT "FK_7da78a3bb9e76995dba067b83ed"`);
        await queryRunner.query(`ALTER TABLE "merchant_applications" DROP CONSTRAINT "FK_2da4df0ec53929a13cb78d8496a"`);
        await queryRunner.query(`DROP INDEX "public"."idx_applications_creator_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_applications_reviewer_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_applications_status_created"`);
        await queryRunner.query(`DROP TABLE "merchant_applications"`);
        await queryRunner.query(`DROP TYPE "public"."merchant_applications_risk_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."merchant_applications_status_enum"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
        await queryRunner.query(`DROP INDEX "public"."idx_audit_resource"`);
        await queryRunner.query(`DROP TABLE "audit_logs"`);
    }

}
