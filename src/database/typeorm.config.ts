import { join } from 'path';
import { DataSourceOptions } from 'typeorm';
import { AuditLog } from '../audit/audit-log.entity';
import { MerchantApplication } from '../applications/merchant-application.entity';
import { User } from '../users/user.entity';

export interface DbEnv {
  DATABASE_HOST?: string;
  DATABASE_PORT?: string | number;
  DATABASE_USER?: string;
  DATABASE_PASSWORD?: string;
  DATABASE_NAME?: string;
}

/** Single source of truth for the app and the TypeORM CLI. Schema changes only ever ship as migrations. */
export function buildDataSourceOptions(env: DbEnv): DataSourceOptions {
  return {
    type: 'postgres',
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT ?? 5432),
    username: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    entities: [User, MerchantApplication, AuditLog],
    // Match the running extension only, so compiled output doesn't also pick up *.d.ts files.
    migrations: [join(__dirname, 'migrations', `*.${__filename.endsWith('.ts') ? 'ts' : 'js'}`)],
    synchronize: false,
  };
}
