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

## Tuning
During early iteration you may change physics, genetic algorithm, world and scoring parameters without asking. Log each change and its result in `docs/tuning-notes.md`.
