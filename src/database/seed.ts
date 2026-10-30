import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { BCRYPT_ROUNDS } from '../auth/auth.service';
import { User, UserRole } from '../users/user.entity';
import { buildDataSourceOptions } from './typeorm.config';

/**
 * Development seed. Passwords are never hard-coded: set SEED_PASSWORD in your local .env
 * (>= 12 chars). Re-running is safe - existing users are left untouched.
 */
const SEED_USERS: { email: string; role: UserRole }[] = [
  { email: 'admin@example.test', role: UserRole.ADMIN },
  { email: 'reviewer1@example.test', role: UserRole.REVIEWER },
  { email: 'reviewer2@example.test', role: UserRole.REVIEWER },
  { email: 'sales1@example.test', role: UserRole.SALES },
  { email: 'sales2@example.test', role: UserRole.SALES },
];

async function main() {
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('Set SEED_PASSWORD (at least 12 characters) in your environment before seeding.');
  }
  const dataSource = await new DataSource(buildDataSourceOptions(process.env)).initialize();
  try {
    const repo = dataSource.getRepository(User);
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    for (const seed of SEED_USERS) {
      if (await repo.exist({ where: { email: seed.email } })) {
        console.log(`exists   ${seed.email}`);
        continue;
      }
      await repo.save(repo.create({ ...seed, passwordHash }));
      console.log(`created  ${seed.email} (${seed.role})`);
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
