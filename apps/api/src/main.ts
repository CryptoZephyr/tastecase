import pg from 'pg';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!databaseUrl || !supabaseUrl || !supabaseAnonKey) throw new Error('Database and Supabase Auth configuration are required.');
  const portText = process.env.PORT ?? '3000';
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('PORT must be between 1 and 65535.');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000, query_timeout: 6000 });
  pool.on('error', () => { console.error('Database connection unavailable.'); });
  const app = buildServer({ pool, auth: { supabaseUrl, supabaseAnonKey } });
  const close = async () => {
    await app.close();
    await pool.end();
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { close().catch(() => { process.exitCode = 1; }); });
  }
  try {
    await app.listen({ host: '127.0.0.1', port: Number(portText) });
    console.info('TasteCase API listening on loopback.');
  } catch (error) {
    await close();
    throw error;
  }
}

main().catch(() => {
  console.error('TasteCase API startup failed. Check database, Supabase Auth and port configuration.');
  process.exitCode = 1;
});
