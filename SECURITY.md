# Security boundaries

This is a tested foundation with a hosted Supabase verification, not a production security certification or hosted product.

- Owner access tokens are verified server-side by Supabase Auth. Caller-supplied owner IDs and decoded-only JWT claims are not authentication.
- The browser also verifies its stored Supabase session before owner requests. Authentication changes fence in-flight responses and unmount private views; review drafts are scoped by verified owner, project and case. Browser storage is not a substitute for server authorization.
- The Next.js proxy forwards only documented owner/public methods to one fixed origin, with body/deadline limits, no cache, no cookies and no redirects. Public build settings may contain only Supabase's public URL and publishable/anon key, never service-role or provider credentials.
- The API checks every private project's owner. Database row-level policies and composite foreign keys add isolation and cross-project reference checks.
- Runner tokens are random, project-scoped and stored only as hashes. Plaintext appears only in the mint response. Revocation blocks new claims and uploads.
- A successful runner handshake saves owner-readable historical verification timestamps, not a heartbeat or guarantee that the runner is online.
- Target credentials remain in the authorized local runner. API requests never carry the provider key or uploaded target code.
- The runner rejects credential-bearing URLs, external HTTP and redirects. Local HTTP needs explicit loopback opt-in.
- Results are schema-validated. Identical upload retries retain the original result; conflicting data and stale leases fail visibly.
- Normalized trace metadata excludes raw HTTP headers/bodies and credential-bearing blobs. Free-text results receive known-secret redaction, not a guarantee that every possible personal detail can be detected.
- Use only labeled synthetic inputs or authorized non-personal task data. Do not send guest names, emails, identifiers or histories to Qloo or the sample provider.
- Keep `.env`, `.local`, private evidence and Qloo responses out of source control and public artifacts.
- Do not run the local test-auth/bootstrap flow against cloud databases. Production startup has no test-verifier configuration mode.

Discovery, owner review, immutable suites, comparison reports and local replay are implemented backend paths. Comparisons require explicit local release bindings and persisted dispatch/reclaim budgets; cancellation stops new claims while valid already-dispatched uploads remain visible. Reports and private owner-only artifacts keep their original snapshots after later results or reviews.

Exports use strict projections excluding raw Qloo/target/error/trace content and executable source. Required inputs with conservative credential patterns, known secrets or URLs are refused rather than silently redacted and rehashed. This is not universal secret detection. Use an externally trusted pack checksum for replay: a self-checksum detects corruption, not authenticity after malicious recomputation. No artifact supplies a target endpoint or imported adapter module.

The anonymous recorded-sample route is disabled unless server configuration explicitly selects a dedicated synthetic project/case and approves synthetic inputs. Callers cannot choose records. It reads persisted evidence without provider dispatch, omits private owner/credential/lease/error metadata and fails closed on recognized credential formats or known runtime secrets. This is not universal free-text secret detection: review all synthetic sample inputs and outputs before enabling it. A configured sample is a public display projection, not a replay artifact.

Real Supabase Auth, forced owner RLS, composite boundaries, runner scope, private object access and comparison artifact isolation were verified through a loopback API. Hosted connections require verified TLS with Supabase's published CA. The installed official Qloo/Pi dependency graph is patched and `npm audit` is clean; see the documented shrinkwrap limitation. Signed URLs, other MIME/size-limit behaviour, a deployed API and production security have not been verified.

Report a vulnerability privately to the repository owner through an established private contact channel. Do not post credentials, private project data or an exploitable reproduction in public issues. No response-time guarantee or security audit is claimed.
