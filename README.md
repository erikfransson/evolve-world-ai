# Evolve World AI

[![Test and deploy](https://github.com/erikfransson/evolve-world-ai/actions/workflows/deploy.yml/badge.svg)](https://github.com/erikfransson/evolve-world-ai/actions/workflows/deploy.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://erikfransson.github.io/evolve-world-ai/coverage/badge.json)](https://erikfransson.github.io/evolve-world-ai/coverage/)

## Repo structure
* `src/typescript/` web app and simulation (Vite + TypeScript), one HTML page per mode
  * `index.html` landing page, `trials/` the current app, `ecosystem/` and `live/` placeholders
  * `src/sim/` simulation; `creature.ts` (body, brain, senses) and `world.ts` (items, rays) are shared by modes
  * `src/trials.ts`, `src/landing.ts` one entry script per page
  * `src/sim/wasm/` optional WebAssembly SIMD kernels (brain forward, creature rays); `.wat` sources are assembled into `kernels.generated.ts` with `npm run wasm` (wabt), and a test fails if they drift
  * `public/pool.json` Ecosystem seed pool of Trials-trained creatures, rebuilt with `node src/buildPool.ts` (about 30 min on 4 threads)
  * `public/coi-serviceworker.js` vendored (MIT) service worker, registered by the Ecosystem page, that cross-origin isolates the site, so Ecosystem helper threads can share memory
* `src/python/` analysis of headless run output
* `docs/` for e.g. adr documents, and planning etc
* `tests/` tests for all code

## What this is
A live evolution simulation that runs in the browser: press Start and watch creatures evolve.
The same TypeScript simulation also runs headless (Node) for batch runs, analysed in Python.

Live page: https://erikfransson.github.io/evolve-world-ai/ (GitHub Pages, rebuilt on every push to `main`).
