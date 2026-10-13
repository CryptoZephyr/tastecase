import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg, { type Pool, type PoolClient } from 'pg';

export interface Migration { name: string; sql: string }

export async function loadMigrations(): Promise<Migration[]> {
  const directory = new URL('../../../supabase/migrations/', import.meta.url);
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!names.length) throw new Error('No database migrations were found.');
  return Promise.all(names.map(async name => ({ name, sql: await readFile(new URL(name, directory), 'utf8') })));
}

/** Caller supplies a transaction. Ledger entries and DDL commit or roll back together. */
export async function applyMigrations(client: PoolClient, migrations: readonly Migration[]): Promise<string[]> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('tastecase:migrations'))");
  await client.query(`CREATE TABLE IF NOT EXISTS public.tastecase_schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  ); REVOKE ALL ON public.tastecase_schema_migrations FROM PUBLIC, anon, authenticated`);
  const ledger = await client.query<{ name: string; checksum: string }>('SELECT name,checksum FROM public.tastecase_schema_migrations');
  const applied = new Map(ledger.rows.map(row => [row.name, row.checksum]));
  if (applied.size && [...applied.keys()].some(name => !migrations.some(migration => migration.name === name))) throw new Error('Applied database migration is missing from this build.');
  const names = new Set<string>();
  const added: string[] = [];
  for (const migration of [...migrations].sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!/^\d+_[a-z0-9_]+\.sql$/.test(migration.name) || names.has(migration.name)) throw new Error('Invalid or duplicate migration name.');
    names.add(migration.name);
    const hash = createHash('sha256').update(migration.sql, 'utf8').digest('hex');
    if (applied.has(migration.name)) {
      if (applied.get(migration.name) !== hash) throw new Error('Applied database migration checksum changed.');
      continue;
    }
    await client.query(migration.sql);
    await client.query('INSERT INTO public.tastecase_schema_migrations(name,checksum) VALUES ($1,$2)', [migration.name, hash]);
    added.push(migration.name);
  }
  return added;
}

/** Only the explicitly named loopback test database can receive the vanilla-PG shim. */
export function assertLocalTestDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/tastecase_test') {
    throw new Error('Local bootstrap requires a loopback tastecase_test database.');
  }
}

export async function bootstrapLocalTest(client: PoolClient): Promise<void> {
  const hosted = await client.query<{ hosted: boolean }>("SELECT to_regclass('auth.users') IS NOT NULL AS hosted");
  if (hosted.rows[0].hosted) throw new Error('Local bootstrap is forbidden on a Supabase auth database.');
  await client.query("SET LOCAL tastecase.local_test='on'");
  await client.query(await readFile(new URL('../../../supabase/local-test-bootstrap.sql', import.meta.url), 'utf8'));
}

export async function runMigrations(pool: Pool, options: { localTestBootstrap?: boolean; databaseUrl?: string } = {}): Promise<string[]> {
  if (options.localTestBootstrap) assertLocalTestDatabase(options.databaseUrl ?? '');
  const migrations = await loadMigrations();
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='60s'");
    // The bootstrap also takes the migration lock so simultaneous vanilla-PG runs are safe.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tastecase:migrations'))");
    if (options.localTestBootstrap) await bootstrapLocalTest(client);
    const added = await applyMigrations(client, migrations);
    await client.query('COMMIT');
    return added;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some(argument => argument !== '--local-test-bootstrap') || process.argv.slice(2).length > 1) throw new Error('Invalid migration arguments.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 35000 });
  try {
    const added = await runMigrations(pool, { databaseUrl, localTestBootstrap: process.argv.includes('--local-test-bootstrap') });
    console.info(`Database migrations applied: ${added.length}.`);
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    // Errors may contain connection strings, SQL or auth details. Never print them.
    console.error('Database migration failed. Check configuration, privileges and migration integrity.');
    process.exitCode = 1;
  });
}
