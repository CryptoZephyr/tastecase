import pg from 'pg';
import { OfficialQlooAdapter, NovaMicroDecisionAdapter } from '@tastecase/worker';
import { buildBackend } from './backend.js';
import { databasePoolConfig } from './database-config.js';
import { publicSampleConfig } from './public-sample.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  const modelKey = process.env.LiteLLM_API_KEY;
  if (!databaseUrl || !supabaseUrl || !supabaseAnonKey || !modelKey || !process.env.QLOO_API_KEY) throw new Error('Backend database, Auth and provider configuration are required.');
  const portText = process.env.PORT ?? '3000';
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('PORT must be between 1 and 65535.');
  const pool = new pg.Pool({ ...await databasePoolConfig(databaseUrl), max: 10, connectionTimeoutMillis: 5000, query_timeout: 6000 });
  pool.on('error', () => { console.error('Database connection unavailable.'); });
  const { app, startWorker } = buildBackend({ pool, auth: { supabaseUrl, supabaseAnonKey }, publicSample: publicSampleConfig(process.env),
    adapters: { qloo: () => new OfficialQlooAdapter(), decision: new NovaMicroDecisionAdapter(modelKey) },
  });
  let closing: Promise<void> | undefined;
  const close = async () => {
    closing ??= (async () => { try { await app.close(); } finally { await pool.end(); } })();
    await closing;
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { close().catch(() => { process.exitCode = 1; }); });
  }
  try {
    const host = process.env.HOST ?? '127.0.0.1';
    if (!['127.0.0.1', '0.0.0.0', '::1', '::'].includes(host)) throw new Error('HOST must be an explicit bind address.');
    await app.listen({ host, port: Number(portText) });
    void startWorker().then(() => {
      if (!closing) throw new Error('Discovery worker unexpectedly stopped.');
    }).catch(async () => {
      console.error('Discovery worker unavailable; closing backend.');
      process.exitCode = 1; await close();
    });
    console.info('TasteCase API and discovery worker started.');
  } catch (error) {
    await close();
    throw error;
  }
}

main().catch(() => {
  console.error('TasteCase backend startup failed. Check database, Auth, providers and bind configuration.');
  process.exitCode = 1;
});
