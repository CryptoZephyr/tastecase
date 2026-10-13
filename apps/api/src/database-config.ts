import { readFile } from 'node:fs/promises';
import type { PoolConfig } from 'pg';

/** Hosted connections verify certificates; URL TLS flags may not weaken this policy. */
export async function databasePoolConfig(databaseUrl: string, caFile = process.env.DATABASE_SSL_CA_FILE): Promise<PoolConfig> {
  const database = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('PostgreSQL configuration required.');
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(database.hostname);
  if (!local) {
    if (database.searchParams.getAll('sslmode').some(mode => mode !== 'verify-full')
      || ['sslrootcert', 'sslcert', 'sslkey'].some(name => database.searchParams.has(name))) throw new Error('Configure verified TLS with DATABASE_SSL_CA_FILE, not URL overrides.');
    // pg otherwise replaces our explicit CA/verification settings with the URL's sslmode.
    database.searchParams.delete('sslmode');
  }
  const ca = caFile ? await readFile(caFile, 'utf8') : undefined;
  return { connectionString: local ? databaseUrl : database.href, ssl: local ? false : { ...(ca ? { ca } : {}), rejectUnauthorized: true } };
}
