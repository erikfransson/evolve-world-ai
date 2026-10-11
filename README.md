# Evolve World AI

[![Test and deploy](https://github.com/erikfransson/evolve-world-ai/actions/workflows/deploy.yml/badge.svg)](https://github.com/erikfransson/evolve-world-ai/actions/workflows/deploy.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://erikfransson.github.io/evolve-world-ai/coverage/badge.json)](https://erikfransson.github.io/evolve-world-ai/coverage/)

## Repo structure
* `src/typescript/` web app and simulation (Vite + TypeScript), one HTML page per mode
  * `index.html` landing page, `trials/`, `ecosystem/` and `predators/` (Predators & prey, the Ecosystem page script in predators mode), `live/` placeholder
  * `src/sim/` simulation; `creature.ts` (body, brain, senses) and `world.ts` (items, rays) are shared by modes
  * `src/sim/species.ts` species of a Predators & prey world (own body ranges, costs, births and diet); the Ecosystem is the one-species case
  * `src/trials.ts`, `src/ecosystem.ts` (also the Predators & prey page), `src/landing.ts` one entry script per page
  * `src/sim/wasm/` optional WebAssembly SIMD kernels (brain forward, one-call sense); `.wat` sources are assembled into `kernels.generated.ts` with `npm run wasm` (wabt), and a test fails if they drift
  * `public/pool.json` Ecosystem seed pool of Trials-trained creatures, rebuilt with `node src/buildPool.ts` (about 30 min on 4 threads)
  * `public/coi-serviceworker.js` self-unregistering stub, kept at the old URL because visitors may still have the retired shared-memory service worker installed; on its next update check it removes itself and reloads their pages once. Nothing registers it any more, so it can be deleted once old installs are unlikely
* `src/python/` planned analysis of headless run output (empty so far)
* `docs/` for e.g. adr documents, and planning etc
* `tests/` tests for all code

## What this is
A live evolution simulation that runs in the browser: press Start and watch creatures evolve.
The same TypeScript simulation also runs headless (Node) for batch runs, to be analysed in Python (planned).

Live page: https://erikfransson.github.io/evolve-world-ai/ (GitHub Pages, rebuilt on every push to `main`).
