# Review and immutable suites

The owner can accept, edit, reject or defer a saved discovery case, explain the decision and publish selected approved versions. Publishing saves the case, expectation and evidence together. Later edits, rejections or runner results cannot rewrite that suite.

This is a backend API, not a finished interface. Comparison, export, replay execution and an expectation evaluator are not implemented. Approval records a person's scoped expectation; it does not prove that an assistant passed or failed it.

## The review boundary

- Every decision needs a rationale and the current review revision. Unreviewed cases start at revision zero.
- `accept` without an explicit expectation preserves the original advisory proposal with `automaticFailure: false`.
- `accept` or `edit` can supply a strict declarative expectation. `edit` requires one. There is no uploaded code, expression, target URL or model-generated verdict.
- `reject` and `defer` save history without an approved expectation. A previously approved version stops being eligible for a new publication; historical suites stay unchanged.
- The discovery candidate never changes. Each decision gets its own immutable evidence snapshot, and each acceptance/edit gets a new immutable expectation version.

| Classification | Supported scope | Meaning |
|---|---|---|
| `objective_contract` | Output shape, exact allowed catalog IDs, explicit excluded IDs | Mechanical contract checks, not taste correctness |
| `approved_policy` | Recommend any selected IDs, avoid selected IDs, order two IDs when both are present; scoped to profile `a` or `b` | A policy explicitly approved by the owner |
| `advisory` | Original supported contrast with rationale | Human-reviewed evidence; never an automatic failure |
| `unavailable` | Preserved coverage/result/trace gaps | Not an executable expectation |

Objective allowed IDs must equal pinned eligibility; exclusions must come from pinned task constraints. Policy IDs must belong to the pinned catalog, and positive/order rules must use eligible options. Arbitrary rule kinds and unavailable expectation classes are rejected. No freshness guarantee is made for supplied catalog facts. An incomplete trace cannot prove missing tool calls or misconduct.

## Owner API

Use an actual Supabase owner access token in `Authorization: Bearer <token>`. The schema version is `1.0.0`. Runner credentials cannot review or publish. Other owners receive 404 on private resources.

Under `/projects/:projectId`:

| Method | Path | Operation |
|---|---|---|
| POST | `/cases` | Create a case from this project's saved job/candidate |
| GET | `/cases` | List cases and current review heads |
| GET | `/cases/:caseId` | Reopen the original candidate and current review |
| POST | `/cases/:caseId/reviews` | Save an accept/edit/reject/defer decision |
| GET | `/cases/:caseId/reviews` | Read immutable decision/expectation history |
| POST | `/suites` | Create a named suite identity |
| GET | `/suites` | List suite identities |
| GET | `/suites/:suiteId` | Read identity and current publication version |
| POST | `/suites/:suiteId/versions` | Atomically publish explicitly selected current approvals |
| GET | `/suites/:suiteId/versions` | List immutable published snapshots |
| GET | `/suites/:suiteId/versions/:suiteVersionId` | Reopen one original snapshot |

Create a case with `{ schema_version, id, jobId, candidateId }`; create a suite with `{ schema_version, id, name }`. UUIDs are caller-generated request identities, not authentication.

Example advisory acceptance:

```json
{
  "schema_version": "1.0.0",
  "id": "2ba0f58e-1a7d-4992-a1fb-8319234e5637",
  "expectedRevision": 0,
  "action": "accept",
  "rationale": "Keep this contrast for review; it is not a correctness verdict."
}
```

The response separates `head` from the immutable `review` receipt. On a same-ID retry after another decision, `head` reflects the latest revision, while `review` remains the original decision. Do not mistake a retried historical acceptance for current publication eligibility.

To publish, send `{ schema_version, id, suiteId, expectedVersion, cases }`. Each case selection is `{ caseId, expectationVersionId, expectedReviewRevision }`. New suites start at version zero; publication advances to one. The route and body suite IDs must agree. Every selection must still be the current approved version. One stale, rejected, deferred or unreviewed case rejects the entire publication.

Successful creations return 201. Invalid bodies/rules return 400; unknown or foreign-project references return 404; stale revisions and conflicting immutable IDs return 409. Oversized bodies return 413. Busy mutations return a safe 503 and should be retried with the **same ID and unchanged body**. Do not generate a fresh ID for an uncertain submission.

All list/history routes support `?limit=20&offset=0`, with maximum limit 20 and offset 10000. Unknown or duplicate query fields are rejected. Each page is a coherent database snapshot; offset pagination is not a stable cross-request cursor during concurrent writes. Mutation bodies are limited to 64 KiB, decisions to 2 MiB pinned evidence, suites to 50 selected cases and 8 MiB snapshots. A selection within the case count can still exceed the suite byte limit.

## What is pinned

The database captures the source rows in one coherent snapshot: original job/input/candidate and checksums, catalog/task/mappings, confirmed anchors, normalised Qloo evidence and provider attempts, target associations, target inputs/results/checksums, trace completeness, missing coverage, unfinished attempts and uncertain dispatches. It calculates limitations from that evidence, rather than accepting caller-supplied evidence, author IDs or checksums.

The API validates the returned source with the shared contracts before committing. Missing coverage stays unavailable, not negative preference. Partial/reduced evidence keeps its original scope. A late runner result is visible in live discovery, but cannot fill a gap in an older review or suite.

Review heads and suite version counters are mutable pointers. Cases, decision receipts, expectation versions, published snapshots and ordered suite-case references are immutable. Composite foreign keys fence project/job/case relationships. Publication locks its suite, then review heads in UUID order; competing edits/publications either advance once or conflict visibly. An identical retry returns its original publication.

## Database and security

Apply all migrations with `npm run db:migrate` before starting the backend. The review migration is `supabase/migrations/202610130004_review_suites.sql`; the existing hosted certificate policy and local-bootstrap guard still apply. `GET /ready` now also requires every review/suite table and mutation RPC, not only the discovery schema.

All seven review/suite tables have forced owner-read RLS. Direct INSERT/UPDATE/DELETE/TRUNCATE grants are revoked from anonymous, authenticated and service roles. Only backend-only mutation RPCs can create decisions and publications; those RPCs independently verify project ownership. Authenticated browser sessions cannot call them directly. The privileged database connection is trusted server infrastructure, not a client credential.

These routes make no provider calls and do not change discovery budgets, leases or candidates. Ordinary read responses do not expose runner token hashes or credentials. Raw private provider replies remain excluded from Git.

## Verification

On 2026-10-13, the full `npm run check` passed **329 tests**, zero skipped, with lint, strict types and builds. Review-specific tests cover forged references/checksums, unsupported rules, owner/runner isolation, rationale, optimistic revisions, immutable edits, late uploads, two-connection contention, atomic publication, historical retries, pagination and real loopback HTTP. The root test command includes `supabase/review.test.ts`, so CI runs SQL invariants rather than only request-schema tests.

The new migration was applied to the dedicated hosted Supabase project over verified TLS; a repeat applied zero. A loopback API with two actual disposable Supabase Auth accounts passed **114 hosted checks**: review lifecycle, missing/partial evidence pins, stale conflicts, publication/retry/reopen, atomic multi-case selection, late results, forced owner RLS and backend-only mutation privileges. Test Auth users were deleted, credentials revoked and jobs stopped; isolated, explicitly synthetic immutable history remains. This check called no Qloo/model provider and did not establish a real human-approved taste verdict.

No browser/UI, public deployment, comparison evaluator, export or replay was tested or shipped. The four existing Qloo/Pi dependency advisories remain unresolved and block public hosting. Reviewing/publishing stored synthetic cases is not proof of better discovery yield than generic generation.
