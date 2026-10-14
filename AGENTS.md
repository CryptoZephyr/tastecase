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
- Run `npm run check` and database integration tests before opening a PR. Do not merge without the owner's instruction.

## Web app (`apps/web`)

The owner authorized the frontend on 2026-10-14. Notion `Frontend.md` and the Design System Proposal are binding; preserve the selected warm minimalism, Emerald Ink/Champagne palette and the unchanged Distill logo (`apps/web/public/brand/tastecase-logo-distill.png`; derivatives are alpha-keyed from it, never redrawn).

- Every screen talks to the API only through `TasteCaseApi` (`src/lib/api/port.ts`) via `useApi()`. The production transport is `src/lib/api/transport.ts`; until it is wired it returns `not_connected`, and screens show that state. Never substitute fixture, recorded or invented data for a failed or missing response.
- Import `@tastecase/contracts` with `import type` only in web code: the package uses Node APIs at runtime.
- Class and outcome stay separate. The Passed token is only for executed objective/approved-policy passes; receipts, selection and setup checks never use it.
- Mutations reuse the same request ID for an unchanged body after an uncertain failure; saved states appear only after the API confirms them.
- Synthetic fixtures live in `src/test/` and are used only by tests and `*.dev.tsx` screens (`/dev/states`), which `next build` excludes. Every fixture name starts with "Fixture".
- Web checks: `npm run typecheck --workspace @tastecase/web`, `npm test --workspace @tastecase/web`, `npm run build:web`. `npm run dev:web` serves on port 3100.
