# Instructions for Agents

Markdown files need to stay lean and compact and concise

## Subagents
For smaller tasks let Sonnet (5.5+) and Haiku (5.5+) do the work with appropriate effort levels.
Try to minimize usage.
Let Opus (5.5+) be orchestrator and manager of subagents.
Work in parallel when can be done

## Where things are
Layout is in `README.md`. Follow `docs/coding-guidelines.md` for tests and reviews.
Pushing to `main` deploys the site via `.github/workflows/deploy.yml`, so keep `main` building (`npm run build` in `src/typescript/`).

## Git
You may commit and push to `main` after an independent review passes. Each push redeploys the live page.

## Live world
Safety of the server and of this laptop is the top priority for Live World, above features, looks and speed.
Treat every byte from a visitor as hostile: uploads, messages, connection patterns, names, URLs.
- No input can crash, hang or slow the server. Every handler catches its errors, and a bad client gets terminated while the process keeps running.
- Every resource is bounded per connection and globally: memory, send buffers, message size and rate, viewers, inserted creatures, CPU per tick, disk writes, upload bandwidth. Each new feature names its bound before it is built.
- Uploads are data only: parsed by `parseCreatureFile`, re-validated on the server, and every engine value checked for range and finiteness. Visitor text is shown via `textContent` only and kept out of logs and file paths.
- The server runs sandboxed (`server/evolve-live.service.template`, nice 19, memory cap, home hidden). Admin stays on loopback, with a token and an Origin check, and the tunnel exposes only the public port.
- Every limit gets an abuse test that goes red without the fix: floods, oversized and malformed input, slow readers, corrupted saves.
- Push gate: any change to `server/`, `live/` or the upload path needs 3 independent Opus high-effort reviews (public attack surface, host isolation and admin, page and protocol), all findings fixed and re-checked, before it is pushed.
- When a safety trade-off is unclear, choose the restrictive option and ask Erik.
Details: Safety in `docs/live-plan.md`.

## Tuning
During early iteration you may change physics, genetic algorithm, world and scoring parameters without asking. Log each change and its result in `docs/tuning-notes.md`.
