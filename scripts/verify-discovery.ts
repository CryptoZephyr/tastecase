import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import {
  SCHEMA_VERSION, IdSchema, ProjectSchema, CatalogVersionSchema, TaskVersionSchema,
  MappingConfirmationSchema, MintRunnerCredentialResponseSchema, DiscoveryJobSchema,
  DiscoveryJobDetailResponseSchema, AttemptSchema,
} from '@tastecase/contracts';
import { buildServer, buildBackend } from '../apps/api/src/index.js';
import { OfficialQlooAdapter, OpenRouterDecisionAdapter } from '@tastecase/worker';
import { RunnerClient, createConfiguredAdapter, runOnce } from '@tastecase/runner';

let stage = 'configuration';
async function main() {
  if (process.env.TASTECASE_LIVE_VERIFY !== '1') throw new Error('Live verification must be explicitly enabled.');
  const databaseUrl = process.env.DATABASE_URL;
  const fixtures = process.env.TASTECASE_QLOO_FIXTURE_DIRECTORY;
  const key = process.env.OPENROUTER_API_KEY;
  if (!databaseUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
    || new URL(databaseUrl).pathname !== '/tastecase_test' || !fixtures || !key || !process.env.QLOO_API_KEY) throw new Error('Local verified fixtures and providers are required.');
  const availableCatalog = z.array(z.object({ name: z.string(), qloo_id: IdSchema })).min(2).max(10)
    .parse(JSON.parse(await readFile(join(fixtures, 'expanded-catalog.json'), 'utf8')));
  const catalogFixture = availableCatalog.filter(entry => ['Gramercy Tavern', 'Via Carota', 'Le Bernardin'].includes(entry.name));
  assert.equal(catalogFixture.length, 3, 'The bounded previously mapped verification catalog is required.');
  const resolutions = z.array(z.object({ entity: z.string(), envelope: z.object({ results: z.array(z.object({ entity_id: IdSchema })) }) }))
    .parse(JSON.parse(await readFile(join(fixtures, 'entity-resolution.json'), 'utf8')));
  const anchors = ['Radiohead', 'Taylor Swift'].map(label => {
    const entityId = resolutions.find(value => value.entity === label)?.envelope.results[0]?.entity_id;
    assert.ok(entityId, 'Previously confirmed public anchor is required.');
    return { id: randomUUID(), label, kind: 'music' as const, confirmedEntityId: entityId };
  });
  const ownerId = randomUUID(); const otherOwnerId = randomUUID();
  const token = `synthetic-${randomUUID()}`; const otherToken = `synthetic-${randomUUID()}`;
  const auth = { testVerifier: async (value: string) => value === token ? ownerId : value === otherToken ? otherOwnerId : null };
  const pool = new pg.Pool({ connectionString: databaseUrl });
  let app = buildServer({ pool, auth }); let projectId: string | undefined; let jobId: string | undefined; let credentialId: string | undefined;
  let restarts = 0; let targetCalls = 0;
  const v = { schema_version: SCHEMA_VERSION };
  try {
    let origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const owner = async (path: string, body?: unknown) => {
      const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      assert.ok(response.ok, `Owner HTTP status ${response.status}.`);
      return response.json();
    };
    stage = 'fixture_setup';
    const project = ProjectSchema.parse(await owner('/projects', { ...v, name: 'Synthetic live Qloo discovery verification' })); projectId = project.id;
    const path = `/projects/${project.id}`;
    const catalog = CatalogVersionSchema.parse(await owner(path + '/catalogs', { ...v, id: randomUUID(), label: 'Public NYC venues; fictional briefs, unknown constraint facts',
      entries: catalogFixture.map((entry, index) => ({ id: `venue-${index}`, name: entry.name, metadata: { city: 'New York' } })) }));
    const task = TaskVersionSchema.parse(await owner(path + '/tasks', { ...v, id: randomUUID(), label: 'Explicitly synthetic restaurant question', catalogVersionId: catalog.id,
      syntheticBrief: { provenance: 'synthetic', label: 'Fictional dinner', text: 'For this fictional dinner, recommend two options from the supplied eligible NYC catalog, using exact catalog IDs and reasons. Consider the explicitly provided interests. No price, dietary or availability facts are verified.' },
      syntheticInterests: [], constraints: { partySize: 2, location: { city: 'New York', countryCode: 'US' }, dietaryRequirements: [], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: [] } }));
    const mappingIds: string[] = [];
    for (const [index, entry] of catalog.entries.entries()) {
      const mapping = MappingConfirmationSchema.parse(await owner(path + '/mappings', { ...v, id: randomUUID(), catalogVersionId: catalog.id, catalogEntryId: entry.id, qlooEntityId: catalogFixture[index].qloo_id })); mappingIds.push(mapping.id);
    }
    const credential = MintRunnerCredentialResponseSchema.parse(await owner(path + '/runner-credentials', { ...v, label: 'Local live discovery runner' })); credentialId = credential.credential.id;
    const body = { ...v, id: randomUUID(), catalogVersionId: catalog.id, taskVersionId: task.id, mappingConfirmationIds: mappingIds,
      eligibleCatalogEntryIds: catalog.entries.map(entry => entry.id), assistantVersion: 'nemotron/live-verification',
      profiles: anchors.map((anchor, index) => ({ id: index === 0 ? 'a' : 'b', provenance: 'public_synthetic', label: `Fictional ${anchor.label} profile`, anchors: [anchor] })),
      budgets: { qlooAttempts: 8, modelDecisions: 1, targetAttempts: 6, rounds: 2, deadlineSeconds: 1200, retriesPerOperation: 1 }, repeatCount: 2, reducePair: true };
    const job = DiscoveryJobSchema.parse(await owner(path + '/discovery-jobs', body)); jobId = job.id;
    const read = async () => DiscoveryJobDetailResponseSchema.parse(await owner(path + '/discovery-jobs/' + job.id));
    const start = async () => {
      await app.close();
      const backend = buildBackend({ pool, auth, adapters: { qloo: () => new OfficialQlooAdapter(), decision: new OpenRouterDecisionAdapter(key) },
        workerOptions: { projectId: project.id, pollMilliseconds: 100, heartbeatMilliseconds: 250 } });
      app = backend.app; origin = await app.listen({ host: '127.0.0.1', port: 0 }); void backend.startWorker();
    };
    await start();
    const adapter = createConfiguredAdapter({ env: { OPENROUTER_API_KEY: key } });
    const terminal = new Set(['awaiting_review', 'partial', 'unavailable', 'no_useful_contrast', 'failed', 'cancelled', 'budget_exhausted', 'deadline_exceeded', 'needs_confirmation']);
    const deadline = Date.now() + 1200000;
    stage = 'discovery_and_runner';
    let saved = await read();
    while (Date.now() < deadline) {
      saved = await read();
      if (terminal.has(saved.job.state) && saved.job.leaseId === null) break;
      if (saved.job.state === 'waiting_runner' && saved.job.leaseId === null) {
        if (restarts === 0) {
          const evidenceChecksums = saved.evidence.map(e => e.checksum); await start(); restarts++;
          assert.deepEqual((await read()).evidence.map(e => e.checksum), evidenceChecksums);
        }
        const client = new RunnerClient({ apiOrigin: origin, allowLoopbackHttp: true, env: { TASTECASE_RUNNER_TOKEN: credential.token } });
        while (targetCalls < 6) {
          const outcome = await runOnce(client, adapter);
          if (outcome.status === 'no_work') break;
          assert.equal(outcome.status, 'completed');
          if (outcome.status !== 'completed') throw new Error('Runner unavailable.');
          targetCalls++;
          assert.equal(outcome.result.outcome, 'success', 'Live target output unavailable.');
          const attempt = AttemptSchema.parse(await owner(path + '/attempts/' + outcome.acknowledgement.attemptId));
          assert.equal(attempt.resultChecksum, outcome.acknowledgement.resultChecksum);
          assert.deepEqual(attempt.input.task.constraints, task.constraints);
          assert.deepEqual(attempt.input.eligibleCatalogEntryIds, job.input.targetInput.eligibleCatalogEntryIds);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(terminal.has(saved.job.state), 'Live deadline elapsed before terminal state.');
    assert.notEqual(saved.job.state, 'failed', 'Live discovery invariant failure.');
    stage = 'saved_evidence';
    const evidence = saved.evidence.map(e => e.checksum); const candidates = saved.candidates.map(c => c.checksum);
    await app.close(); app = buildServer({ pool, auth }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
    assert.deepEqual((await read()).evidence.map(e => e.checksum), evidence);
    assert.deepEqual((await read()).candidates.map(c => c.checksum), candidates);
    assert.equal((await fetch(origin + path + '/discovery-jobs/' + job.id, { headers: { authorization: `Bearer ${otherToken}` } })).status, 404);
    const cancelled = DiscoveryJobSchema.parse(await owner(path + '/discovery-jobs', { ...body, id: randomUUID() }));
    await owner(path + '/discovery-jobs/' + cancelled.id + '/cancel', v);
    assert.equal(DiscoveryJobDetailResponseSchema.parse(await owner(path + '/discovery-jobs/' + cancelled.id)).job.state, 'cancelled');
    const ranks = saved.evidence.filter(e => e.data.kind === 'rank').map(e => e.data);
    const proof = { synthetic: true, localAuthOnly: true, hostedApplication: false, model: 'nova-micro', projectId: project.id, jobId: job.id,
      state: saved.job.state, checkpoint: saved.job.checkpoint, counters: saved.job.counters, targetCalls, workerRestartCount: restarts,
      reopenedChecksumsVerified: true, otherOwnerRead: '404', cancellation: 'passed',
      rankings: ranks.map(rank => rank.kind === 'rank' ? { profile: rank.profileId, scope: rank.scope, requested: rank.requestedEntryIds.length, returned: rank.orderedEntryIds.length, missing: rank.missingEntryIds.length } : {}),
      candidateCount: saved.candidates.length, candidateChecksums: candidates,
      providerAttempts: saved.providerAttempts.map(p => ({ kind: p.kind, operation: p.operationKey, status: p.status })),
      reasons: saved.job.reason, automaticFailure: false, humanReviewRequired: true };
    await writeFile('.local/discovery-verification.json', JSON.stringify(proof, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(proof));
    assert.ok(['partial', 'awaiting_review', 'no_useful_contrast'].includes(saved.job.state), 'Providers did not complete discovery.');
  } finally {
    await app.close();
    if (projectId && jobId) await pool.query('SELECT public.cancel_discovery_job($1,$2)', [projectId, jobId]);
    if (credentialId) await pool.query('UPDATE public.runner_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1', [credentialId]);
    await pool.end();
  }
}
main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', stage, type: error instanceof Error ? error.name : 'Unknown', recovery: 'Inspect bounded normalized job state; provider payloads and credentials are not printed.' }));
  process.exitCode = 1;
});
