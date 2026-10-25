# Hosted TasteCase

The initial deployment uses merged commit `1d686066eca1119e7e4232a6730fa1e50009d753` from `main`. The repository remains private.

| Part | Live location | Plan |
| --- | --- | --- |
| Website and in-app docs | https://tastecase.vercel.app | Vercel Hobby |
| API and discovery worker | https://tastecase-api.onrender.com | One free Render web service, Frankfurt |
| Auth, Postgres and private storage | Dedicated TasteCase Supabase project | Existing free project |
| Assistant runner | Owner's machine or server | Not hosted by TasteCase |

The API's `/health` endpoint checks liveness; `/ready` checks the database and running discovery loop. It does not attest to Qloo/model availability or claim a test passed. The [public sample](https://tastecase.vercel.app/sample) is configured as a read-only recorded example with fictional inputs.

## Render settings

- Repository root: the monorepo root; branch: `main`.
- Runtime: Node 24.21.0; instance plan: `free`; health check: `/ready`.
- Build: `npm ci --include=dev && NODE_OPTIONS=--max-old-space-size=2048 npm run build`.
- Start: `npm start`; `HOST=0.0.0.0`; Render supplies `PORT`.
- Runtime `NODE_OPTIONS=--max-old-space-size=256`. The larger compiler allowance applies only to the build, not the running free instance. A heap cap is not a total-process memory guarantee.
- Automatic deployments wait for checks to pass. Never change the instance to a paid plan or attach a paid disk without owner approval.

Set backend-only `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `QLOO_API_KEY` and `OPENROUTER_API_KEY` through Render's environment settings. No target assistant credentials are accepted by the backend.

For a public sample, set `TASTECASE_PUBLIC_SAMPLE_PROJECT_ID`, `TASTECASE_PUBLIC_SAMPLE_CASE_ID` and `TASTECASE_PUBLIC_SAMPLE_INPUTS_SYNTHETIC=true` together, only after reviewing the dedicated synthetic inputs and genuine saved provider evidence. These settings select one saved case on the server; visitors cannot select another project or start provider work. Incomplete or unsafe sample evidence returns unavailable, never invented results.

Set both `NODE_EXTRA_CA_CERTS` and `DATABASE_SSL_CA_FILE` to `/opt/render/project/src/supabase/certs/prod-ca-2021.crt`. The database URL must use the dedicated TasteCase session pooler and `sslmode=verify-full`. Do not weaken certificate verification.

Run `npm run db:migrate` from an authorised machine with that dedicated database URL and the same verified CA policy before deploying a schema change. The migration ledger checks immutable hashes; never reset the database to make a deployment succeed.

## Vercel settings

- Framework: Next.js; repository root directory: `apps/web`.
- Install: `cd ../.. && npm ci --include=dev`.
- Build: `cd ../.. && npm run build:web`.
- Server-only `TASTECASE_API_ORIGIN=https://tastecase-api.onrender.com`.
- Browser-visible `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` use the same Supabase project as the API. Only the public publishable key is exposed, never a database password or service-role key.

Supabase's canonical site URL is `https://tastecase.vercel.app`. The explicit production callback allowlist includes `https://tastecase.vercel.app/auth/callback` and the owned alternative production domain's `/auth/callback`. Existing local-development redirects were preserved. No wildcard preview-domain redirect was added.

## Connect a local runner

Use `TASTECASE_API_ORIGIN=https://tastecase-api.onrender.com`, not the Vercel URL or its owner-only API proxy. Issue a project-scoped runner token in the app, then set it in the local environment. For the default adapter, set local `OPENROUTER_API_KEY` and an explicit `TASTECASE_ASSISTANT_VERSION` release label. See [the runner guide](runner.md).

The selected NVIDIA Nemotron 3.5 Super VL model is free-only with no paid/provider fallback. Baseline and Candidate can share it; different labels alone do not change a prompt. Your target provider key stays on the runner machine.

## Free-tier limits

- Render sleeps after 15 minutes without inbound traffic. Waking can take about a minute; the web proxy has a 20-second deadline, so the first request can show an unavailable state. Retry an unchanged mutation with the same ID; do not blindly start a second job.
- Discovery may pause or be interrupted when Render sleeps or restarts. Durable state lives in Supabase, not Render's temporary filesystem. Bounded leases/checkpoints do not promise uninterrupted execution.
- All free services in the Render workspace share 750 instance hours per calendar month. Existing services were not suspended or modified.
- Render bandwidth and build-minute overages can be billed if the workspace has a payment method. This deployment did not upgrade any service; workspace billing controls and remaining shared quotas were not independently verified through the API. Review the workspace's Billing page before inviting broad traffic.
- OpenRouter free-model allowance is shared and availability can change. Rate-limit/provider failures must remain unavailable, not become paid retries or fabricated results.
- The public sample reads saved evidence without new Qloo/model calls. It still needs the API to be awake. Private projects are never used as an anonymous fallback.

References: [Render free instances](https://render.com/docs/free), [Vercel environments](https://vercel.com/docs/deployments/overview).

## Verification

On 2026-10-14 the deployed browser journey reached a real saved case, advisory review, published suite, complete 8/8 comparison, frozen JSON/text/pack downloads and reopening. One hosted decision and ten local Nemotron assistant requests were made; the ten locally observed assistant responses reported $0. Four Qloo calls were used, with no model retries or paid fallback. The discovery case stayed partial/advisory; a complete comparison is not an automatic correctness pass.

One transient session-verification timeout recovered through visible retry without changing the frozen report checksum. Its cause was not established. Email-link completion, deliberate cold-start recovery, cancellation, objective-rule failure and CLI replay were not covered. Both test runner credentials were revoked and only the two disposable Auth owners were deleted. The setup snippet was subsequently corrected in [PR #4](https://github.com/CryptoZephyr/tastecase/pull/4).

The public sample was subsequently selected from a previously reviewed synthetic Qloo/Nemotron run. Anonymous API and Vercel-proxy responses passed schema and private-field checks; caller-supplied selectors and writes were rejected. Provisioning it made no new Qloo or model calls. These are HTTP checks, not a fresh browser walkthrough of the sample.

On 2026-10-25 the sample was refreshed from synthetic project `396e5da4-d651-4523-97d8-78d412222fc1`, case `ee3622f8-7f4e-4fcd-a7a3-85cea973d3d3`, so it shows Qloo affinity, interest influence and place tags. The case was accepted as a synthetic demo case, which records that it is worth keeping as a test, not that either answer is correct. Before switching, the API's real `/public/sample` route was checked locally against production read-only, and it passed the schema and private-field checks.
