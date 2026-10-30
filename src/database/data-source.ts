import 'dotenv/config';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './typeorm.config';

// Entry point for the TypeORM CLI (see the migration:* npm scripts).
export default new DataSource(buildDataSourceOptions(process.env));
