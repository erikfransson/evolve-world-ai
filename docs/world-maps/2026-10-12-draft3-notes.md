# Live World map candidates, final set

Four maps at 54000 x 33600 (10.3x today's area): F1 Realms, F2 Three Rivers, F3 Oases in the Dry, F4 The Inland Sea. Images: `2026-10-12-draft3-*.jpg` in this folder; layer specs `tools/map-F1.json` to `tools/map-F4.json`. Design proposal for GitHub #36. Only F4 is built, at 30000 x 18750 (first 40000 x 25000) (`src/typescript/src/sim/maps/inlandSea.ts`).
Food and poison values are relative to a plain 1.0. "no poison" means poison 0. Normal ground is the area with no mud, firm ground or rock (poison and food zones on plain ground count as normal). Massif disc counts are estimates (large discs of radius 120 to 300 filling the massif mask), stones are clusters of 1 to 6 discs.

## F1 Realms (89% normal, mud 4.6, firm 2.2, rock 3.9; about 1770 discs)
| Region        | Food | Poison | Ground             | Role               |
|---------------|------|--------|--------------------|--------------------|
| Commons       | 1.0  | 1.0    | plain              | open, mixing       |
| Karst Hills   | 1.3  | 1.0    | merged outcrop clumps | tight steering  |
| Boulder Reach | 1.4  | 1.0    | scattered boulders | steering           |
| Silt Marsh    | 1.7  | none   | patchy mud         | slow, rich         |
| Ashlands      | 2.0  | 2.0    | plain              | poison, rich       |
| Speed Steppe  | 0.55 | 1.0    | firm 65%           | fast, poor         |
| Dry Basin     | 0.6  | 1.0    | plain, oasis 2.0 with mud fringes | far apart |

Behaviours: short rays and careful steering in the karst and boulders (richer than the Commons, so they pay), waders with low upkeep in the marsh, careful foragers that tell food from poison (one poison bite kills) in the Ashlands (food x2.0 against poison x2), sprinters with long sight on the steppe, travellers and settlers in the basin.
Mixing: every realm opens onto the Commons. No walls and no belts, the realms are separated only by their own terrain.

## F2 Three Rivers (82% normal, mud 7.6, firm 4.3, rock 6.3; about 1650 discs)
| Region          | Food | Poison | Ground                | Role            |
|-----------------|------|--------|-----------------------|-----------------|
| Northern Ridge  | 0.9  | 1.0    | rock massif, 2 passes | barrier         |
| Rivers and tarn | 1.9  | none   | mud, widening         | slow, rich      |
| Fords           | 1.9  | none   | stepping stones       | crossing        |
| Green Meadows   | 1.2  | 1.0    | plain                 | slightly rich   |
| Steppe plateau  | 0.7  | 1.0    | firm 50%   | fast, poor      |
| Ash coast       | 1.9  | 2.0    | plain                 | poison, rich    |
| Elsewhere       | 1.0  | 1.0    | plain                 | open            |

Behaviours: slow, efficient river dwellers, meadow generalists, plateau sprinters, careful coast foragers, steerers and wall followers at the ridge.
Mixing: the rivers are crossable everywhere (stepping stones mark the easy fords), the ridge has two wide passes, meadows and plateau edges are open.

## F3 Oases in the Dry (87% normal, mud 6.5, firm 4.1, rock 2.1; about 620 discs)
| Region     | Food | Poison | Ground                    | Role              |
|------------|------|--------|---------------------------|-------------------|
| Dry plain  | 0.85 | 1.0    | plain, olive              | thin, far apart   |
| Oasis core | 2.0  | none   | plain                     | rich, crowded     |
| Mud ring   | 1.4  | none   | patchy rings (55% mud) on three oases, one-sided arcs on three, none on three | slow, rich edge |
| Wadi       | 1.5  | none   | plain                     | green route       |
| Sand sea   | 0.6  | 1.0    | firm 60%                  | fast, poor        |
| Mesa       | 1.1  | 1.0    | rock massif               | shelter           |
| Salt pan   | 2.0  | 2.0    | plain                     | poison, rich      |

Behaviours: long-sight travellers and sprinters on the plain and sand, settlers that win by efficiency in the oases, ring waders that guard the edges of large oases, shelter users at the mesas.
Mixing: the plain is open everywhere, wadis join three oases to others. Three large, three medium and three small oases, so oasis size is a niche too. Full rings read as arcs with gaps because the mud is patchy.

## F4 The Inland Sea (84% normal, mud 6.6, firm 3.0, rock 6.1; about 1790 discs)
| Region        | Food | Poison | Ground                    | Role                 |
|---------------|------|--------|---------------------------|----------------------|
| Shallows      | 1.6  | none   | mud, deeper in the middle | slow, rich           |
| Isles         | 1.5  | none   | plain, beaches            | reachable by wading  |
| Ashfall Shore | 1.8  | 2.0    | plain                     | poison, rich         |
| Dune Coast    | 0.6  | 1.0    | four firm dune fields     | fast, poor           |
| Drowned Town  | 1.2  | 0.8    | rock outcrops             | tight steering       |
| Cliff Coast   | 1.0  | 1.0    | massif, 2 passes          | barrier              |

Behaviours: waders in the sea, island hoppers, careful foragers that tell food from poison (one poison bite kills) on the north shore (food x1.8 against poison x2), sprinters on the dunes, steerers in the karst.
Mixing: all shores meet the sea on ragged coasts. The cliff arc is the only barrier, with two passes.

## Engine plan (steps 1 to 4 built in `src/sim/maps/`, step 5 open)
1. A biome raster at the ground field's cell size (50 to 100 units): terrain kind (plain, mud, firm) plus food and poison weights, all uint8. Built once from the layer spec (`tools/map-F*.json` are those specs). The renderer reads continuous mud and firm values and thresholds at 0.5, so contours are smooth, while the engine only needs the thresholded kind.
2. Weighted spawning by rejection sampling: draw a random position, accept with probability weight / max weight. Poison spawns the same way.
3. Local food caps on a 1000-unit grid, cap = base x weight, so a rich region cannot be emptied by the global cap (`foodCap` is global today, ecosystem.ts:241) and poor regions do not fill with food from rich ones.
4. Rock as a disc list from the spec (stones as clusters, massifs as filled discs with passes), with `MAX_PIECES` raised and benched at 10k creatures. The rock grid cell is 300 units, a few thousand discs is cheap to look up, but `keepOut` and ray casts need a bench.
5. Per-region trait statistics in the viewer (mean ray length, speed, size, energy by region). This is required to see whether regions separate behaviours at all.
Optional later: region-offset seasons, per-region founder seeding, a slower mire level.

## Population and size
The designs are scale-free (shapes are fractions of the map, the generator takes the world size).
At 54000 x 33600 with about 1800 creatures the mean spacing is about 850 units while rays reach 50 to 250, so most creatures rarely meet.
The Inland Sea was built at 5.5x (40000 x 25000, cut to 3.1x, 30000 x 18750, on 2026-10-15), keeping the spacing near 600, with 10x as a later option if creatures still meet often.
Regrowth and cap values measured on it are in `docs/status.md` (A5, A7).
