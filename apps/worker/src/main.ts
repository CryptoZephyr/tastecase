import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { DiscoveryStore, PoolDatabase } from './store.js';
import { OfficialQlooAdapter } from './qloo.js';
import { NovaMicroDecisionAdapter } from './decision.js';
import { runDiscoveryLoop, type WorkerOptions } from './engine.js';

/** Requires already-migrated backend Postgres and backend-only provider credentials. */
export async function startDiscoveryWorker(signal: AbortSignal, options: WorkerOptions = {}) {
  const database = process.env.DATABASE_URL; const key = process.env.LiteLLM_API_KEY;
  if (!database || !key || !process.env.QLOO_API_KEY) throw new TypeError('Discovery backend configuration is incomplete');
  const url = new URL(database);
  if (!['postgres:','postgresql:'].includes(url.protocol)) throw new TypeError('PostgreSQL configuration required');
  const local = ['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname);
  if (!local) {
    if (url.searchParams.getAll('sslmode').some(mode=>mode!=='verify-full')
      || ['sslrootcert','sslcert','sslkey'].some(name=>url.searchParams.has(name))) throw new TypeError('Configure verified TLS with DATABASE_SSL_CA_FILE, not URL overrides');
    url.searchParams.delete('sslmode');
  }
  const ca = process.env.DATABASE_SSL_CA_FILE ? await readFile(process.env.DATABASE_SSL_CA_FILE,'utf8') : undefined;
  const pool = new pg.Pool({connectionString:local ? database : url.href,max:4,connectionTimeoutMillis:5000,
    statement_timeout:5000,ssl:local ? false : {...(ca ? {ca} : {}),rejectUnauthorized:true},
  });
  try {
    await runDiscoveryLoop(new DiscoveryStore(new PoolDatabase(pool)),{
      qloo:()=>new OfficialQlooAdapter(),decision:new NovaMicroDecisionAdapter(key),
    },signal,options);
  } finally { await pool.end(); }
}

const entry = process.argv[1];
if (entry && import.meta.url===pathToFileURL(entry).href) {
  const controller = new AbortController();
  process.once('SIGTERM',()=>controller.abort()); process.once('SIGINT',()=>controller.abort());
  startDiscoveryWorker(controller.signal).catch(()=>{
    console.error('Discovery worker stopped: configuration or persistence unavailable.'); process.exitCode=1;
  });
}
