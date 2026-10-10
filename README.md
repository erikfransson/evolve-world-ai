# Evolve World AI

## Repo structure
* `src/typescript/` web app and simulation (Vite + TypeScript), one HTML page per mode
  * `index.html` landing page, `trials/` the current app, `ecosystem/` and `live/` placeholders
  * `src/sim/` simulation, `src/sim/physics.ts` per-creature physics shared by modes
* `src/python/` analysis of headless run output
* `docs/` for e.g. adr documents, and planning etc
* `tests/` tests for all code

## What this is
A live evolution simulation that runs in the browser: press Start and watch creatures evolve.
The same TypeScript simulation also runs headless (Node) for batch runs, analysed in Python.

Live page: https://erikfransson.github.io/evolve-world-ai/ (GitHub Pages, rebuilt on every push to `main`).
