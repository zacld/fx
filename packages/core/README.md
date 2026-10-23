# @fx/core

Shared domain core for the FX Discovery v2 rewrite (see `../../ARCHITECTURE_V2.md`).

- `src/schema.ts` — zod schemas + inferred types: the data model (events, segments,
  companies, lead_evidence, leads, runs, crm). The DB tables and the dashboard read these.
- `src/signals.ts` — FX / origin-hint / B2B / secondary / negative signal lists +
  `classifyText()` + large-org detection. Faithful port of `scripts/signals.py`.
- `src/scoring.ts` — `scoreLead()` — the single gate-based lead scorer. Faithful port of
  `scripts/rescore.py`'s `rescore()` (gates A–I). **Do not change the gates/weights without
  sign-off.** Domain blocklists are data — keep in sync with `scripts/rescore.py`.

## Dev

```bash
cd packages/core
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Standalone for now; gets wired into an npm workspace (and the React app moves to
`apps/web/`) in a later increment — see `ARCHITECTURE_V2.md`.
