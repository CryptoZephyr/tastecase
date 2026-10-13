# Security boundaries

This is a tested local foundation, not a production security certification or hosted product.

- Owner access tokens are verified server-side by Supabase Auth. Caller-supplied owner IDs and decoded-only JWT claims are not authentication.
- The API checks every private project's owner. Database row-level policies and composite foreign keys add isolation and cross-project reference checks.
- Runner tokens are random, project-scoped and stored only as hashes. Plaintext appears only in the mint response. Revocation blocks new claims and uploads.
- Target credentials remain in the authorized local runner. API requests never carry the provider key or uploaded target code.
- The runner rejects credential-bearing URLs, external HTTP and redirects. Local HTTP needs explicit loopback opt-in.
- Results are schema-validated. Identical upload retries retain the original result; conflicting data and stale leases fail visibly.
- Normalized trace metadata excludes raw HTTP headers/bodies and credential-bearing blobs. Free-text results receive known-secret redaction, not a guarantee that every possible personal detail can be detected.
- Use only labeled synthetic inputs or authorized non-personal task data. Do not send guest names, emails, identifiers or histories to Qloo or the sample provider.
- Keep `.env`, `.local`, private evidence and Qloo responses out of source control and public artifacts.
- Do not run the local test-auth/bootstrap flow against cloud databases. Production startup has no test-verifier configuration mode.

Discovery, human review, signed artifact access and historical replay are not implemented here. API/database checks are local; hosted Supabase authentication and private-object storage still need verification. This foundation has no Qloo dependency; the earlier Qloo prototype's upstream advisories remain a gate before hosting that integration.

Report a vulnerability privately to the repository owner through an established private contact channel. Do not post credentials, private project data or an exploitable reproduction in public issues. No response-time guarantee or security audit is claimed.
