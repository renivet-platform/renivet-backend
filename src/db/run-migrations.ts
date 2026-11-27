import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';

/** Explicit one-off deployment job; never called by HTTP server startup. */
async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const expected = args.find((arg) => arg.startsWith('--database='))?.slice('--database='.length);
  if (args.length !== 2 || !args.includes('--apply') || !expected || !/^[A-Za-z0-9_-]+$/.test(expected) || !process.env.DATABASE_URL) {
    throw new Error('MIGRATION_CONFIGURATION_INVALID');
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const result = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (result.rows[0]?.name !== expected) throw new Error('MIGRATION_DATABASE_MISMATCH');
    await client.query("SELECT pg_advisory_lock(hashtext('renivet-schema-migrations'))");
    try {
      await migrate(drizzle(client), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      console.log('Renivet database migrations completed.');
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('renivet-schema-migrations'))");
    }
  } finally {
    await client.end();
  }
}
void run().catch((error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : 'MIGRATION_FAILED';
  console.error(code);
  process.exitCode = 1;
});
