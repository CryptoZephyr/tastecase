# TasteCase engineering boundaries

TasteCase helps AI-concierge teams discover overlooked recommendation cases and preserve human-reviewed release tests.

- Keep private project isolation in database, API, runner and artifacts.
- Pin catalog and task versions. Missing cultural evidence is unavailable, not negative preference.
- Cultural ranking differences are advisory, never automatic correctness failures.
- Explicitly record trace completeness; missing trace cannot prove misconduct.
- Target provider keys remain in the owner's local runner. Never accept arbitrary target URLs or uploaded source code on the backend.
- Hash scoped runner credentials; revocation stops new claims and uploads.
- Use bounded leases and idempotent attempt IDs. Conflicting duplicate uploads must fail visibly.
- Never commit credentials, raw Qloo responses, personal guest histories or local evidence.
- No visual design or frontend UI work is authorized in this build.
- Run `npm run check` and database integration tests before opening a PR. Do not merge without the owner's instruction.
