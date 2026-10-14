import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import {
  SCHEMA_VERSION, ProjectSchema, CatalogVersionSchema, TaskVersionSchema,
  MintRunnerCredentialResponseSchema, AttemptSchema,
} from '@tastecase/contracts';
import { buildServer, runMigrations } from '../apps/api/src/index.js';
import { RunnerClient, createConfiguredAdapter, OPENROUTER_MODEL, runOnce } from '@tastecase/runner';

let stage = 'configuration';
async function main() {
  if (process.env.TASTECASE_LIVE_VERIFY !== '1') throw new Error('Set TASTECASE_LIVE_VERIFY=1 to permit one billed target call.');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('This synthetic-auth verification requires a local Postgres database.');
  }
  if (!process.env.OPENROUTER_API_KEY) throw new Error('Local OPENROUTER_API_KEY is required.');
  const pool = new pg.Pool({ connectionString });
  const ownerId = randomUUID();
  const ownerToken = `synthetic-owner-${randomUUID()}`;
  const app = buildServer({ pool, auth: { testVerifier: async token => token === ownerToken ? ownerId : null } });
  try {
    stage = 'local_migrations';
    await runMigrations(pool, { localTestBootstrap: true, databaseUrl: connectionString });
    stage = 'http_start';
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const owner = async (path: string, body?: unknown) => {
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) console.error(JSON.stringify({ status: 'owner_api_error', http_status: response.status }));
      assert.ok(response.ok, `Owner API returned HTTP ${response.status}.`);
      return response.json() as Promise<unknown>;
    };
    stage = 'project_creation';
    const project = ProjectSchema.parse(await owner('/projects', { schema_version: SCHEMA_VERSION, name: 'Synthetic live runner verification' }));
    const path = `/projects/${project.id}`;
    stage = 'catalog_creation';
    const catalog = CatalogVersionSchema.parse(await owner(path + '/catalogs', {
      schema_version: SCHEMA_VERSION, id: randomUUID(), label: 'Synthetic fixture, not real restaurants',
      entries: [
        { id: 'synthetic-a', name: 'Synthetic Cedar Dining', metadata: { city: 'New York' } },
        { id: 'synthetic-b', name: 'Synthetic Maple Kitchen', metadata: { city: 'New York' } },
        { id: 'synthetic-c', name: 'Synthetic Willow Cafe', metadata: { city: 'New York' } },
      ],
    }));
    stage = 'task_creation';
    const task = TaskVersionSchema.parse(await owner(path + '/tasks', {
      schema_version: SCHEMA_VERSION, id: randomUUID(), label: 'Synthetic recommendation task', catalogVersionId: catalog.id,
      syntheticBrief: { provenance: 'synthetic', label: 'Synthetic brief', text: 'Recommend two dining choices from this supplied synthetic catalog. Return their exact IDs and explain the choices. No dietary or availability facts are provided.' },
      syntheticInterests: [{ provenance: 'synthetic', label: 'Public cultural interest', text: 'Radiohead' }],
      constraints: { partySize: 2, location: { city: 'New York', countryCode: 'US' }, dietaryRequirements: [], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: [] },
    }));
    const credential = MintRunnerCredentialResponseSchema.parse(await owner(path + '/runner-credentials', { schema_version: SCHEMA_VERSION, label: 'Local verification runner' }));
    const attempt = AttemptSchema.parse(await owner(path + '/attempts', {
      schema_version: SCHEMA_VERSION, id: randomUUID(), catalogVersionId: catalog.id, taskVersionId: task.id,
      mappingConfirmationIds: [], eligibleCatalogEntryIds: catalog.entries.map(entry => entry.id),
    }));
    const env = {
      TASTECASE_API_ORIGIN: origin, TASTECASE_RUNNER_TOKEN: credential.token,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };
    const client = new RunnerClient({ env, allowLoopbackHttp: true });
    const adapter = createConfiguredAdapter({ env });
    stage = 'runner_execution';
    const outcome = await runOnce(client, adapter);
    assert.equal(outcome.status, 'completed', 'The runner did not persist an attempt.');
    if (outcome.status !== 'completed') throw new Error('Runner verification did not complete.');
    assert.equal(outcome.result.outcome, 'success', 'The live provider did not return valid target output.');
    stage = 'persisted_result';
    const saved = AttemptSchema.parse(await owner(path + '/attempts/' + attempt.id));
    assert.equal(saved.status, 'completed');
    assert.deepEqual(saved.result, outcome.result);
    assert.equal(saved.resultChecksum, outcome.acknowledgement.resultChecksum);
    await app.close();
    const reopened = buildServer({ pool, auth: { testVerifier: async token => token === ownerToken ? ownerId : null } });
    try {
      const response = await reopened.inject({ method: 'GET', url: path + '/attempts/' + attempt.id, headers: { authorization: `Bearer ${ownerToken}` } });
      assert.equal(response.statusCode, 200);
      assert.equal(AttemptSchema.parse(response.json()).resultChecksum, saved.resultChecksum);
    } finally { await reopened.close(); }
    const proof = { synthetic: true, auth: 'Local synthetic verifier; hosted Supabase login not exercised',
      model: OPENROUTER_MODEL, attemptId: attempt.id, projectId: project.id,
      resultChecksum: saved.resultChecksum, outcome: outcome.result.outcome,
      traceCompleteness: outcome.result.trace.completeness, persistedAfterApiRestart: true };
    await mkdir('.local', { recursive: true, mode: 0o700 });
    await writeFile('.local/runner-verification.json', JSON.stringify(proof, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(proof));
  } finally {
    await app.close();
    await pool.end();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', stage, error_type: error instanceof Error ? error.name : 'Unknown',
    recovery: 'Check the required local configuration and stored attempt; credentials and provider output are not printed.' }));
  process.exitCode = 1;
});
