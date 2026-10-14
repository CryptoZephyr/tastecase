# Hosted TasteCase

The initial deployment uses merged commit `1d686066eca1119e7e4232a6730fa1e50009d753` from `main`. The repository remains private.

| Part | Live location | Plan |
| --- | --- | --- |
| Website and in-app docs | https://tastecase.vercel.app | Vercel Hobby |
| API and discovery worker | https://tastecase-api.onrender.com | One free Render web service, Frankfurt |
| Auth, Postgres and private storage | Dedicated TasteCase Supabase project | Existing free project |
| Assistant runner | Owner's machine or server | Not hosted by TasteCase |

The API's `/health` endpoint checks liveness; `/ready` checks the database and running discovery loop. It does not attest to Qloo/model availability or claim a test passed. The anonymous public sample is not configured.

## Render settings

- Repository root: the monorepo root; branch: `main`.
- Runtime: Node 24.21.0; instance plan: `free`; health check: `/ready`.
- Build: `npm ci --include=dev && NODE_OPTIONS=--max-old-space-size=2048 npm run build`.
- Start: `npm start`; `HOST=0.0.0.0`; Render supplies `PORT`.
- Runtime `NODE_OPTIONS=--max-old-space-size=256`. The larger compiler allowance applies only to the build, not the running free instance. A heap cap is not a total-process memory guarantee.
- Automatic deployments wait for checks to pass. Never change the instance to a paid plan or attach a paid disk without owner approval.

Set backend-only `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `QLOO_API_KEY` and `OPENROUTER_API_KEY` through Render's environment settings. No target assistant credentials are accepted by the backend.

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

The selected Nemotron model is free-only with no paid/provider fallback. Baseline and Candidate can share it; different labels alone do not change a prompt. Your target provider key stays on the runner machine.

## Free-tier limits

- Render sleeps after 15 minutes without inbound traffic. Waking can take about a minute; the web proxy has a 20-second deadline, so the first request can show an unavailable state. Retry an unchanged mutation with the same ID; do not blindly start a second job.
- Discovery may pause or be interrupted when Render sleeps or restarts. Durable state lives in Supabase, not Render's temporary filesystem. Bounded leases/checkpoints do not promise uninterrupted execution.
- All free services in the Render workspace share 750 instance hours per calendar month. Existing services were not suspended or modified.
- Render bandwidth and build-minute overages can be billed if the workspace has a payment method. This deployment did not upgrade any service; workspace billing controls and remaining shared quotas were not independently verified through the API. Review the workspace's Billing page before inviting broad traffic.
- OpenRouter free-model allowance is shared and availability can change. Rate-limit/provider failures must remain unavailable, not become paid retries or fabricated results.
- No synthetic public sample has been selected and provisioned. Private cases are never used as an anonymous fallback.

References: [Render free instances](https://render.com/docs/free), [Vercel environments](https://vercel.com/docs/deployments/overview).
