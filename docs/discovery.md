# Private discovery backend

TasteCase can now queue a bounded discovery job, compare two fictional cultural profiles against one fixed catalog, ask an authorised local runner for recommendations and save a proposed case. The finding is advisory. A person reviews it through the [review and suite API](review.md). No frontend, comparison/export/replay execution or deployment is included here.

## One backend process

`npm run build` builds contracts, worker, API and runner. `npm start` runs the API and discovery worker in **one persistent Node 24 process**, sharing a PostgreSQL pool. Do not also start the standalone worker for the same service. PostgreSQL holds the queue; no other queue or service is required. The runner remains a separate owner-controlled process.

Set these in the backend's environment, never as command-line secrets:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Privileged PostgreSQL connection |
| `DATABASE_SSL_CA_FILE` | Trusted CA file for hosted database certificates, when not trusted by Node |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Actual Supabase owner authentication |
| `QLOO_API_KEY` | Official Qloo MCP child only |
| `LiteLLM_API_KEY` | Backend Nova Micro decision key; the case-sensitive name is intentional |
| `HOST`, `PORT` | Default `127.0.0.1:3000`; use an explicit allowed bind address |
| `NODE_ENV` | Use `production` outside local tests |

Hosted database connections verify certificates. A URL may use `sslmode=verify-full`; that flag is removed before `pg` receives the explicit verified-TLS configuration. Other SSL modes and URL `sslrootcert`, `sslcert` or `sslkey` overrides are refused. Use `DATABASE_SSL_CA_FILE` or Node's trusted CA configuration. The migration command uses the same TLS policy. Apply `npm run db:migrate` with a migration-capable role before starting. **Never use `--local-test-bootstrap` for hosted databases.** The bootstrap is only for the designated loopback `tastecase_test` fixture and refuses hosted auth databases.

The official harness is pinned to `@qloo/qloo-harness@0.1.26` with `@modelcontextprotocol/sdk@1.31.0`. Qloo uses `https://hackathon.api.qloo.com`. Decisions use `nova-micro` at `https://litellm.vision.aivar.app/v1`. There is no fallback provider. The model chooses only a software-computed contrast ID or no contrast. It cannot choose tools, invent ranking facts or declare a taste failure.

The Qloo child has a minimal environment: Qloo credentials and runtime paths, not database, model or runner keys. Raw Qloo replies and stderr are not persisted. Stored evidence contains bounded, normalised, task-relevant resolution choices and relative catalog ordering. Missing/unmapped coverage stays unavailable, not disliked. More than ten mapped eligible options is explicitly unsupported, not truncated or batched. Public-anchor labels must be genuinely public entities; the owner supplies that provenance, not a semantic PII detector.

`GET /health` only confirms the HTTP process is alive. `GET /ready` checks database/schema availability and the worker loop, **not live Qloo/model health**. Shutdown aborts the worker before HTTP draining, waits for it and then closes the pool. `buildBackend` accepts injected adapters and worker options for tests; the production entrypoint always uses actual Supabase authentication. Test auth is forbidden in production.

## Durable work and limits

Jobs pin immutable task/catalog/mapping versions, eligible IDs, two public synthetic profiles, a deadline and explicit budgets. Provider attempts are reserved before dispatch and charged even if the outcome is unknown. Target reclaims also consume a new dispatch slot. This is not an exactly-once call or billing guarantee.

Accepted evidence and target results survive restart. Lease IDs fence old writers. Deterministic attempt IDs avoid duplicate accepted work, while conflicting duplicate content fails visibly. A worker resumes checkpoints instead of paying for completed ranking/model calls again. Released or terminal jobs immediately label reserved calls `interrupted` and dispatched calls `uncertain`, without refunding counters. Expired active leases are reconciled on the next claim.

Only explicitly retryable transient provider errors receive automatic retries after persisted backoff. The default is one retry per operation; `retriesPerOperation` permits an explicit cap of zero to two. Authentication errors do not retry. Unknown dispatched calls are not automatically repeated; explicit injected worker policy can opt in and still must reserve another charged slot. The production default does not opt in.

Cancelling stops new provider work and unsent runner claims. Already dispatched results may still arrive under a valid runner lease and remain visible as cancelled/partial evidence. Deadline and lease loss also abort provider work. Waiting for a runner stops when the deadline is reached. Pair reduction preserves the entire eligible catalog and all practical constraints; only the question and Qloo pair comparison narrow.

## Owner API

Use `Authorization: Bearer <Supabase owner access token>` and the `1.0.0` schema version. Under `/projects/:projectId/discovery-jobs`:

- `POST /` queues a `CreateDiscoveryJobRequest` with caller-generated UUID, pinned version/mapping IDs, two profiles, budgets, deadline, repeat count and reduction choice.
- `GET /?limit=10&offset=0` lists a bounded window; maximum limit 20, maximum offset 10000.
- `GET /:jobId` reopens job state, counters, checkpoints, provider ledger, confirmations, target summaries and immutable candidates.
- `GET /:jobId/evidence/:evidenceId` reads one normalised evidence record.
- `GET /:jobId/candidates/:candidateId` reads one immutable proposed case.
- `POST /:jobId/confirmations` supplies `{ schema_version, id, anchorId, resolutionId, entityId }` while awaiting confirmation. The selected entity must have been observed for this job/anchor. Even a single resolved choice still needs owner confirmation unless it was explicitly confirmed in the queued input.
- `POST /:jobId/cancel` supplies `{ "schema_version": "1.0.0" }`.

See [contracts](../packages/contracts/src/discovery.ts) and [routes](../packages/contracts/src/rest.ts) for exact request shapes. Another owner receives 404 for these project/job/evidence/candidate reads. No public review or export endpoints are added.

## Live verification

The opt-in local check was run against real Qloo, Nova Micro and a local authorised runner. Never run it against an existing production queue or store provider replies in git, terminal logs or committed fixtures.

```sh
TASTECASE_LIVE_VERIFY=1 npm run verify:discovery
```

It requires a loopback `tastecase_test` database, backend `QLOO_API_KEY` and `LiteLLM_API_KEY`, plus `TASTECASE_QLOO_FIXTURE_DIRECTORY` pointing to privately verified public mapping fixtures. `expanded-catalog.json` supplies the three previously mapped Gramercy Tavern, Via Carota and Le Bernardin IDs/names; `entity-resolution.json` supplies confirmed Radiohead/Taylor Swift IDs. The fixture directory is not distributed or read as target code. The job permits at most eight Qloo attempts including bounded retries, one model choice and six target dispatches, with a 1200-second deadline. The script polls for up to 600 seconds and cancels unfinished work on exit. Target credentials are given only to the local runner adapter. Safe metadata is written to ignored `.local/discovery-verification.json`; provider unavailability is recorded and exits nonzero, rather than being reported as a successful integration.

For a manual owner-controlled check:

1. Install with `npm install --ignore-scripts --no-fund`, build and use a dedicated verification database/project. Apply hosted migrations using verified TLS, without local bootstrap. Check `/ready` after starting the single service with the environment above. Actual hosted owner authentication and forced RLS must be checked separately from local synthetic auth.
2. Read any known public Qloo fixture from a private runtime location. Create an owned project, immutable small catalog/task and explicit owner mapping confirmations through the existing API. Use genuinely public cultural anchors and wholly fictional briefs, not personal histories. Do not commit that fixture or print raw Qloo responses.
3. POST a discovery request referencing those IDs. For a first bounded run, use `repeatCount: 1`, `reducePair: false`, budgets `{ "qlooAttempts": 4, "modelDecisions": 1, "targetAttempts": 2, "rounds": 1, "deadlineSeconds": 600 }`. Two already-confirmed profiles require only two rank calls; two unconfirmed anchors add up to two resolution calls. Retries share the same total, never exceed it. A no-contrast, partial or unavailable result is a valid observed outcome, not a guarantee of a case.
4. Poll the job detail. If `needs_confirmation`, inspect only its saved normalised resolution evidence privately and POST each deliberate owner choice with its matching resolution ID. Do not automatically select ambiguous choices. Confirm unmapped/missing IDs remain unavailable and accepted provider attempts have evidence checksums.
5. When `waiting_runner`, mint a project-scoped runner credential. On the owner's separate runner machine/process, set `TASTECASE_API_ORIGIN`, `TASTECASE_RUNNER_TOKEN`, `LITELLM_API_KEY` and the trusted target model settings described in [runner setup](runner.md). Run `node packages/runner/dist/cli.js handshake`, then `node packages/runner/dist/cli.js run-once` at most twice for this first job. Add `--allow-loopback-http` only for a loopback API. The target key never belongs in the backend or Qloo child. Never rerun a target just to retry an ambiguous upload.
6. Reopen the job and proposed case. Check fixed practical constraints and eligibility, real target result checksums, explicit trace completeness and advisory/human-review labels. An incomplete trace cannot prove a missing tool. Record IDs, safe statuses, counters and checksums only, not private provider bodies. A second owner must get 404 for its job, evidence and candidate URLs.
7. Stop/restart only the parent's verification backend once between accepted ranking and runner completion. Poll until the old lease expires if it was a hard stop. Confirm checkpoints/counters persist and completed calls/results are reused. Separately cancel a queued verification job and confirm the local runner cannot claim its unsent work. No destructive reset or exactly-once assertion is appropriate.
8. For a repeat/reduction run with already-confirmed anchors, use `repeatCount: 2`, `reducePair: true`, budgets `{ "qlooAttempts": 4, "modelDecisions": 1, "targetAttempts": 6, "rounds": 2, "deadlineSeconds": 1200 }`. This schedules up to four full attempts and two pair-focused follow-ups, with no spare target reclaims in that allowance. These are maximum attempts, not guaranteed dispatches or token/currency caps. Track actual provider usage and stop within the owner's billing allowance.

## Executed checks

On 2026-10-13, `DATABASE_URL=postgresql://postgres@127.0.0.1:55432/tastecase_test npm run check` passed lint, strict types, all builds and **235 tests**: API 39, worker 31, contracts 63, runner 76 and SQL 26. Zero failures, cancellations or skips. The original foundation checks still pass.

Database-backed tests exercise checkpoint reuse after API/worker reopen, actual expired lease fencing, interruption/uncertainty, charged retry backoff/budget exhaustion, cancellation, stopped runner claims, retained already-dispatched results, two-connection contention, immutable checksums and cross-owner/cross-project isolation. The deterministic loopback test uses the real runner HTTP client and an explicitly synthetic target result; it does not call a live target provider. Adapter tests inject MCP/HTTP transports and cover all six Qloo statuses and bounded cancellation. A real harness-start test validates the installed ESM entry and tool schemas without a provider request.

The separate billed local run used the actual official MCP child, four accepted Qloo ranking calls, one validated Nova Micro selection and six real Nova Micro target calls via the authorised runner. Full rankings returned two of three options for each profile; both reduced-pair calls returned two of two. One candidate reached checkpoint `saved`, state `partial`, with `automaticFailure: false` and `humanReviewRequired: true`. The worker restarted once before runner completion and reused its accepted evidence. Saved evidence/result/candidate checksums, practical constraints, second-owner 404 and cancellation were verified. An earlier valid model choice returned no useful contrast; provider-error and invalid-output runs remained unavailable, not failures.

Both discovery migrations applied to the dedicated hosted Supabase project with verified TLS; a repeat applied zero migrations. A loopback API against that database passed **28 hosted checks** with two actual disposable Auth owners: schema readiness, queue/list/reopen, immutable pinned checksum, cross-owner job/evidence/candidate/confirmation/cancel denial, forced RLS on job/state rows and rejection of direct authenticated backend RPC use. The Auth users were deleted; clearly labeled cancelled fixture history remains isolated. No provider calls were made by this hosted fixture check. The foundation's earlier 61 hosted checks covered private Storage; discovery creates no new storage policy.

Review and suite verification is documented [separately](review.md#verification). Not checked: a runner on a different physical machine, cloud deployment, production process supervision, frontend or comparison/export/replay execution. Local/provider and hosted-database checks are distinct; neither proves a hosted TasteCase app.

## Dependency security

On 2026-10-13, the four reported Qloo/Pi package-level findings were remediated. The official `@qloo/qloo-harness@0.1.26` and `@earendil-works/pi-coding-agent@0.84.2` remain unchanged. Root overrides scoped to that Pi version pin `undici@8.10.2` and `brace-expansion@5.0.12` to their patched registry releases.

Pi publishes an `npm-shrinkwrap.json` that ignores normal overrides. Overrides alone, or patched lock entries with Pi's `hasShrinkwrap` flag retained, still install vulnerable versions. The committed root lockfile therefore updates only those two packages' versions, registry URLs and verified integrity hashes, and omits Pi's `hasShrinkwrap` metadata so the root resolutions take precedence. No upstream code or installed package files are patched, and no audit finding is suppressed. Preserve this lockfile; regenerating it from upstream can restore the vulnerable shrinkwrapped graph.

A clean `npm ci --ignore-scripts` and subsequent `npm install --ignore-scripts` both installed the patched versions. `npm ls` and the harness-start test check actual package versions from Pi's dependency paths, rather than relying only on lockfile audit output. The test fails if the old versions return. `npm audit --json` reported **zero vulnerabilities**, and lint, types, builds and all **329 tests** passed, including **42 PostgreSQL checks** with zero skips.

Two authenticated calls through the same official MCP adapter verified live Radiohead resolution and ranking of the previously mapped three-restaurant catalog. Two options ranked and one remained missing; missing coverage is still unavailable evidence. This compatibility check made no model or target-assistant calls and did not repeat the earlier full discovery investigation or hosted Supabase checks. A clean audit clears these reported dependency findings, not every possible security risk or the remaining product/deployment work.
