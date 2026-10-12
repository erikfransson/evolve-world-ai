# Instructions for Agents

Markdown files need to stay lean and compact and concise

## Subagents
For smaller tasks let Sonnet (5.5+) and Haiku (5.5+) do the work with appropriate effort levels.
Try to minimize usage.
Let Opus (5.5+) be orchestrator and manager of subagents.
Work in parallel when can be done

## Where things are
Layout is in `README.md`. Follow `docs/coding-guidelines.md` for tests and reviews.
`main` deploys the site via `.github/workflows/deploy.yml`; keep `development` building (`npm run build` in `src/typescript/`).

## Git
- `main` is the released version that runs on the site. Never commit or push to `main` directly.
- All work goes to `development`: branch from it, and commit or push to it after an independent review passes. Pushes to `development` run the tests but do not deploy.
- A release is a pull request from `development` into `main`, merged only when Erik asks for a release and the release review below has passed.

### Versions
- Versions are `MAJOR.MINOR.PATCH`, starting at 0.1.0. Bug fixes and small changes bump the patch (0.1.1, 0.1.2), bigger features bump the minor (0.2.0).
- The version lives in `src/typescript/src/version.ts` and `src/typescript/package.json` (a test keeps them equal), and the pages show it.
- Note each change that lands on `development` under "Unreleased" in `docs/releases.md`.
- To release: set the new version in both files, rename "Unreleased" to the version with the date, open the pull request from `development` to `main`, and after the merge tag `main` as `vX.Y.Z` and make a GitHub release with the same notes.

### Review development to master merge


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
