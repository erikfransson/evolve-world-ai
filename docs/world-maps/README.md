# Suggested world maps

Design drafts for the Live World map (GitHub #36), kept so ideas survive later iterations.
The Inland Sea and The Six Realms are built; files are dated and numbered by draft round.

| File                                   | What                                                                  |
|----------------------------------------|-----------------------------------------------------------------------|
| `2026-10-12-draft1-contact-sheet.jpg`  | Round 1: nine first concepts                                          |
| `2026-10-12-draft2-contact-sheet.jpg`  | Round 2: five reworked concepts after visual and ecology reviews      |
| `2026-10-12-draft3-*.jpg`              | Round 3: the four reviewed finalists (Realms, Three Rivers, Oases, Inland Sea) |
| `2026-10-12-draft3-notes.md`           | Region tables, expected behaviours, engine plan, size trade-off        |
| `tools/`                               | Generator (`gen.mjs`, `specs.mjs`), renderer (`render.js`) and layer specs (`map-F*.json`) |

Chosen and built for the live server: The Inland Sea, scaled to 30000 x 18750 (detail as at 40000 wide) into `src/typescript/src/sim/maps/inlandSea.ts` by `tools/to-engine.mjs`.

The Six Realms (`clock`, 60000 x 37500) is the Live World map since the clock-map branch: generator `tools/clock.mjs` writes `src/typescript/src/sim/maps/clock.ts` (7353 rock discs, 103 layers); log in `docs/clock-map-notes.md`.
Six outer realms on a ring around a hub, joined by thin trails (food 0.5) rim to rim; each realm has a hue and a looks-only paint wash.

| Realm  | Hue | Founder        |
|--------|-----|----------------|
| Crags  | 120 | Juggernaut     |
| Blight | 55  | Oracle         |
| Mire   | 300 | Gentle Grazer  |
| Bloom  | 0   | Grazer         |
| Flats  | 230 | Rammer         |
| Steppe | 185 | Pathfinder     |
