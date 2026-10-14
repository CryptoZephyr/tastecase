# Compare releases and replay saved tests

TasteCase runs two explicitly named assistant versions against the same published cases. It keeps each repeated result, evaluates only the rules the owner approved, and freezes a report that later reviews or uploads cannot change. A downloaded pack can run again through an authorised local adapter without new Qloo calls.

This is a backend API and runner, not a finished interface or deployed app. A changed recommendation is a behaviour change, not proof of better taste. A policy pass means compliance with that approved rule only.

## What stays fixed

Create a run from an explicit published `suiteVersionId` and selected `caseIds`. There is no implicit latest version or silent subset. The plan pins the suite, case, expectation and evidence checksums; catalog, task, eligibility, mappings, constraints, full synthetic briefs and original repeat count. Both baseline and candidate execute fresh attempts. Old discovery outputs are not substituted for either version.

Full-profile inputs are derived from the published evidence, including when discovery results were unfinished. The deterministic task ID/content must match any existing stored task; a conflicting identity is rejected, not repaired. Editing or rejecting a case later does not change an already published suite or comparison.

Each immutable execution binding records the run, case, suite, expectation and evidence checksums, profile, repeat, role and explicit assistant version. Versions are **owner-controlled local release attestations**, not cryptographic proof of which model or code executed. A version label never selects a provider model automatically.

## Owner API

Authenticate with a real Supabase owner access token. Runner tokens cannot create, cancel, finalize or export comparisons. Another owner receives 404; artifacts are private no-store responses, not public bucket links.

Under `/projects/:projectId/comparisons`:

| Method | Path | Action |
|---|---|---|
| POST | `/` | Queue a fixed comparison plan; 201 |
| GET | `/` | List current progress |
| GET | `/:comparisonId` | Reopen the pinned plan, current progress and frozen report |
| POST | `/:comparisonId/cancel` | Stop new claims; 200 |
| POST | `/:comparisonId/finalize` | Freeze a coherent report; 201 |
| GET | `/:comparisonId/pack` | Download the safe test pack |
| GET | `/:comparisonId/report` | Download the finalized JSON report |
| GET | `/:comparisonId/report.txt` | Read the same report as text |

Creation shape; UUIDs below are placeholders, not runnable references:

```json
{
  "schema_version": "1.0.0",
  "id": "<new comparison UUID>",
  "suiteVersionId": "<published suite version UUID>",
  "baselineVersion": "concierge-prompt-v1",
  "candidateVersion": "concierge-prompt-v2",
  "caseIds": ["<published case UUID>"],
  "deadlineAt": "<future ISO timestamp within one hour>",
  "dispatchBudget": 8,
  "reclaimBudget": 0
}
```

Logical slots = selected cases × two versions × two full profiles × pinned repeat count. One case with two repeats needs eight slots. Limits: **10 cases, 120 logical slots, 24 reclaims, 144 charged dispatches, one hour**, 64 KiB request, 8 MiB plan/pack and 2 MiB report. Dispatch budget must cover every logical slot and cannot exceed slots plus reclaim allowance. List windows use `limit` ≤20 and `offset` ≤10000.

Cancellation takes `{ "schema_version": "1.0.0", "id": "<receipt UUID>" }`. Finalization takes the same identity fields plus `allowPartial`. With `false`, pending work conflicts rather than becoming a pass. With `true`, incomplete work is captured explicitly. Cancellation/deadline/budget limitations and unknown dispatches remain visible.

Retry creation, cancellation and finalization with the **same ID and unchanged body**. A matching retry returns its original receipt; conflicting content returns 409. Current GET progress is separate from historical receipts. A final report is frozen once; late uploads can remain visible in live progress but cannot fill gaps in the old report. Missing reports return 404 until finalized. Busy work returns a safe 503.

## Bind each local assistant version

Configure the authorised adapter/provider locally, then set `TASTECASE_ASSISTANT_VERSION` to the exact baseline or candidate label before `run-once`. The claim carries that label. An unbound or wrong-label runner cannot claim comparison work, and the runner validates the returned binding before dispatch. Existing unbound foundation/discovery execution remains supported.

```sh
export TASTECASE_ASSISTANT_VERSION="concierge-prompt-v1"
node packages/runner/dist/cli.js run-once
```

Repeat for the declared slots, then use the locally configured candidate adapter with its exact label. Keys remain environment values; never CLI arguments or artifact fields. Setting the label alone does not change the provider model or prompt. Custom adapter code stays on the owner's machine.

Claims reserve charged leases atomically against persisted counters and state. Reclaiming an expired attempt uses a fresh lease and consumes allowance; stale uploads fail. Cancelled, finalized, deadline-expired or budget-exhausted comparisons cannot issue new claims. Already dispatched uploads may arrive under valid leases. Unknown/repeated dispatches remain charged: exactly-once execution or billing is not promised.

## Read outcomes correctly

| Evidence | Interpretation |
|---|---|
| Approved `output_schema`, allowed-ID or exclusion rule | Mechanical contract pass/fail when supported |
| Approved recommend-any, avoid or conditional-order policy | Scoped policy compliance only |
| Advisory approval | Always advisory, never automatic failure |
| Provider unavailable, missing identity or unsupported evaluation | Unavailable, not pass/fail |
| Explicit malformed output | Can fail an approved output-schema rule; otherwise unavailable evaluation |
| Conditional order without both known IDs | Not applicable |
| Repeats disagree | Preserve each outcome and mark mixed, not a taste score |
| Partial/unavailable trace | Integrity limitation; no missing-tool-call verdict |

Recommendation-ID changes are shown independently of rule results. Reports never contain an LLM-generated correctness verdict or freshness guarantee for supplied catalog facts.

## Export and offline replay

The pack contains pinned synthetic inputs, approved declarative checks and structural evidence identity/status/coverage references. It deliberately omits Qloo response bodies/scores, target text/names/reasons, malformed raw text, provider diagnostics, trace events, credentials, token hashes and executable source. It is private project data, not automatically public or anonymous.

Pack version: `tastecase-test-pack/1`; report version: `tastecase-comparison-report/1`; target contract: `tastecase-target-output/1`. Unknown versions/fields/rules, incompatible contexts and altered checksums are rejected before adapter calls. Required input containing credential patterns, known local secrets or URLs is refused rather than redacted and rehashed. Detection is conservative, not a universal secret detector; clean required inputs by publishing new versions, never mutating old snapshots. Raw Qloo evidence is excluded pending redistribution/retention review.

Use the pack checksum from the trusted authenticated download as an external integrity reference. A self-checksum detects corruption, **not authenticity if someone changes the pack and recomputes every checksum**.

```sh
export TASTECASE_ASSISTANT_VERSION="concierge-prompt-v2"
node packages/runner/dist/cli.js replay \
  --pack ./tests.json --role candidate \
  --pack-checksum <trusted pack checksum> --report ./new-report.json
```

Replay needs the locally configured provider/adapter, not an API origin, Supabase owner token or runner token. It makes no Qloo call, loads no artifact-supplied module/URL, and runs only the selected role's declared profiles/repeats. Its common comparison report is therefore intentionally **partial**: the other role remains pending, not fabricated. Reports contain structural results only. Final-component pack symlinks and non-regular files are refused; output creation is exclusive and private, never overwriting existing/source files. An interrupted write may leave an incomplete reserved file, not a valid report.

Replay exit codes: 0 completed selected-role execution without mechanical failure (advisory/not-applicable is not a pass); 1 invalid/configuration/cancelled; 2 mechanical failure; 4 unavailable or pending selected-role execution. Unavailability takes exit precedence, while all per-repeat outcomes remain recorded. There are no automatic target retries. Deadlines stop awaiting uncooperative async adapters, but cannot kill arbitrary synchronous local code or undo side effects from an adapter ignoring cancellation.

## Verification

On 2026-10-13, the final integrated run passed **473 tests** with zero failures/skips, lint, strict types and builds on a fresh PostgreSQL 17 database in CI mode. This includes a URL-rejection regression preventing export of a runner-incompatible pack. SQL files run sequentially because migration tests share a schema; dedicated two-connection tests still exercise contention and atomic budgets. Remote CI is recorded in the PR.

The comparison migration applied to the dedicated TasteCase Supabase project over verified TLS, and repeat application added zero. **172 hosted checks** passed using two disposable real Auth owners through a loopback API, synthetic comparison adapters, eight fresh version-bound uploads, immutable exports/reopening, offline replay, forced RLS and backend-only RPC privileges. This includes repeated review/suite regression checks. Accounts were deleted and credentials revoked; isolated synthetic immutable fixture history remains.

The downloaded hosted pack also replayed through the actual CLI/local adapter using **eight real Nova Micro calls**, four per role, no Qloo calls. The two local prompt configurations were intentionally different; the source cases were synthetic/advisory, not organically discovered failures or proof of better taste. Both role reports retained advisory classification and structured output. Estimated token cost was about $0.00012, not a billing receipt.

No frontend/UI, cloud-hosted TasteCase application, different physical runner machine, Windows replay or case-yield advantage was verified. Hosted database verification and real-provider replay are separate evidence, not a deployed product.
