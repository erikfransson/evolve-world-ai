# Live World plan (draft, 2026-10-11)

Issue #23, plus the visitor counter from #28.
One shared world that keeps running on a small self-hosted server; visitors watch it on the GitHub Pages site and add their own creatures.

## Goals
- Problem: every other mode is a private run that stops when the tab closes. Live is one world everyone shares and that keeps evolving.
- For: visitors of the site, and the owner as admin.
- Success: a visitor opens `live/`, sees the world running, designs or uploads a creature, inserts 1 to 10 named copies and can find and follow its lineage later.
- Not: accounts, chat, a cloud server, or anything that slows the host noticeably.

## Architecture
| Part           | Where                                  | Notes                                                                                     |
| -------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| World server   | `server/` in this repo, Node           | Runs the Ecosystem engine at 3x real time under `nice -n 19`, memory capped               |
| Public access  | Tunnel from the host                   | HTTPS tunnel: fixed URL, no open router ports, host IP hidden                             |
| Page           | `live/` on GitHub Pages                | Connects to the server over WebSocket; shows "world offline" when the host is off          |
| Design, train  | Visitor's browser                      | Pretrain (Trials) and RL fine-tuning run client side, so the host only simulates the world   |
| State          | `server/state/`, gitignored            | Gzipped save every 4 h and on stop; the newest 6 are kept, older ones deleted after 4 days, and saves with before-reset folders stay under a 1 GB state budget (oldest deleted first, `StateStore.prune`); restored on restart; admin can load any save |

No separate repo is needed.
Hourly state stays out of git, since a world of about 1000 creatures is a few MB per save and would bloat the history; an occasional chosen snapshot can be committed by hand.

## Server
- One world, Ecosystem rules: the Six Realms map with collision damage on, room for 12000 creatures (5000 before 2026-11-09).
- Runs as a `systemd --user` service: `Nice=19` with idle CPU and IO scheduling, `MemoryMax`, `CPUQuota`, restart on crash. Sandboxed: home hidden, repo read-only, only the state dir writable, IPv4/IPv6 sockets only (outbound connections are not blocked), see `server/evolve-live.service.template`.
- Streams compact binary frames (positions, angles, colours) at about 5 Hz and the page interpolates; caps viewers so upload bandwidth stays bounded.
- `room()` in `public.ts` judges by the current frame size, so viewers let in at a low population stay as it grows. The stride stops at `SLOWEST_STRIDE` 60 (a frame each 12 s), where 100 viewers at 12000 creatures use about 1.9 of the 2.2 MB/s frame budget (25 did that at 5000). Accepted because send queues, frame skips and drops keep it bounded.
- Admin: owner only. A separate admin port on loopback that the tunnel never exposes, plus a token kept on the host. It live-tunes world parameters, injects creatures, saves now, and loads a listed save to revert the world. Operations are documented privately.
- Counter: worlds running is 1, plus current viewers and total creatures inserted, served by the same server.
- Needs from the engine (owner: session 16): insert a creature at runtime, save and restore the full world state.

## Visitor flow
1. Page opens into the running world, with a hideable "Add your creature" panel on top.
2. Pick one of 3 named founders trained for the Live World (Juggernaut rams, Oracle has the biggest brain, Grazer never fights), or upload a saved creature file.
3. Tune plan and settings within the form limits; energy per second updates live.
4. Optional toggles: Pretrain (quick Trials run) and RL fine-tune (RL envs from #27), both in the browser.
5. Choose name (1 to 16 letters or digits) and colour, insert 1 to 10 copies at random free spots. The page then follows one and highlights its family (each copy founds its own lineage).

## Safety
Follows "Uploaded creatures and settings" in `docs/modes-plan.md`: data only through `parseCreatureFile`, bounded cost, names rendered as text, re-validated on the server.
Server limits: insert rate per visitor and for everyone (added creatures count against the population cap), name length and character filter.
The public port answers only the WebSocket upgrade and `GET /stats` (`{creatures, viewers}` for the landing page: CORS *, no request body read, rebuilt at most once a second, 5 a second for all callers with a burst of 20, past that a 503); every other request gets a 426.

Selected-creature BIRTH (6): 12 bytes, sent just before each living DETAIL and paid from the same 3 kB/s detail allowance: birth wait as u16 tenths of a second (capped at 6553.5 s, non-finite or negative sent as 0) and a world-full bit. Its own message type, so pages and servers from before it skip or miss it.
- Lineage group ids (`namedTop` memory in `Chronicle`): one number per living named group, keyed by the name key (server-parsed, never sent), pruned to the groups living now on every pass, so at most one per living family (at most maxPopulation, 12000). Not saved, reset with the world and its history. No new wire field.

### Population and load (12000 cap, 2026-11-09)
- Cap `MAX_POPULATION` 12000 (Erik: run slower rather than cap), births stop 100 below it; the admin range and the engine's `LIVE_MAX` are 12000. A restored save keeps its own cap (a world saved at 5000 stays at 5000 until the admin raises it).
- Brain-weight rail `MAX_LIVE_WEIGHTS` = 5000 x 7538 (`MAX_ADD_GENOME`) = 37.69 M: the world the memory, save and restore limits were measured for (208 MB JSON, 1.8 GB peak at an admin load, under `MAX_GENOME_FLOATS` 40 M). Births wait 100 of the largest brains short of it (`BIRTH_WEIGHT_CAP`), an add past it is refused with the reason, a seed or reset past it is refused, and a fresh start cuts the seed file's count. 12000 of the largest brains (90 M) cannot exist; the shipped founders (1603 weights on average) put 12000 creatures near 19 M.
- Seeding: a reset whose copies do not fit the home regions is refused (`LiveWorld.seedFits`, the seed's own spot search, about 1 s at 12000): 1983 a home, the bound at 12000, does not fit the Crags and the Flats (about 1860 to 1950 spots). A seed file the map has no room for seeds the default 10 instead of failing every start (`SEED CUT`).
- Tick loop: unchanged. A world past one core runs slower in proportion to its tick cost: each slice runs at most 15 ms of ticks (one tick when ticks are longer), then sockets and timers are served, and what is owed past `maxCatchUpS` (1 s) is dropped. The unit's nice 19 and idle scheduling yield the core to interactive work.
- Energy ceiling `eco.energyCap` 5 (`ENERGY_CAP`, admin 0 off or 1 to 100): a creature at 5 times its own birth energy leaves food where it lies (poison still hurts it), so no creature stores energy without bound while births wait at the cap. Kills can carry one over it, and then it eats nothing until it spends down; a save from before gets the server's value, no clamp.
- Viewers: the 3 MB/s upload budget is unchanged, so `room()` admits fewer as frames grow: 23 at 5000 creatures, 14 at 8000, 9 at 12000 (228 kB frames); the rest get "busy", which the page shows as a full world.

### Uploads (L4, built)
- Adds are held to the creature-file `PLAN_LIMITS` and checks (`parseAdd` in `live/add.ts`), names to `[A-Za-z0-9]{1,16}`, shown via `textContent` only. Caps in `server/README.md`.
- Visitor address: Tailscale Funnel (serve proxy mode, as set up here) sets `X-Forwarded-For` to the client address its ingress saw, overwriting any sent (tailscale source, `ipn/ipnlocal/serve.go`); checked in the source and on 2026-11-08 through the public Funnel ingress: a forged single or comma-list header arrived as one entry, the real client address (`LIVE_TRUST_FORWARDED=1` turns per-visitor limits on).
- Spawn region: an add may carry one optional integer `region` (0 to 15, `parseAdd`), an index into the server's own region list, never coordinates or text. The server checks it against that world's map regions with geometry (beyond the list or no geometry: refused, nothing inserted) and searches the 0.6 x radius disc with the existing 40 tries a spot (crowded: refused, no partial insert). Existing add caps apply unchanged, no new server state, no per-tick cost. The server advertises `spawnRegions` in its add rules; a page sends `region` only then (older servers refuse unknown keys).
- Open: test send backpressure through the real tunnel (a slow reader behind tailscaled must still be dropped by the send-queue caps).

## Build steps
| Step | Work                                                                          | Depends on              |
| ---- | ----------------------------------------------------------------------------- | ----------------------- |
| L1   | Engine hooks: insert creature, save and restore state                         | session 16 agrees       |
| L2   | `server/`: world loop, WebSocket frames, 4-hourly save, systemd unit          | L1                      |
| L3   | `live/` page: viewer with camera, offline fallback, counter                   | L2 protocol             |
| L4   | Design panel: named founders, tuning, energy per second, insert (built)       | L3                      |
| L5   | Upload creature file, Pretrain and RL toggles (built with L4)                 | L4, RL envs             |
| L6   | Tunnel setup and admin panel                                                  | L2                      |

## Decisions
- 2026-10-15: trained starter founders (Pathfinder, Juggernaut, Oracle, Gentle Grazer) replace the pool picks in `public/live-founders.json`, approved by Erik; measured numbers in the file. Together in a fresh world Juggernaut and Oracle die out within 20 min; Erik keeps all four.
- 2026-10-13: The Inland Sea on the server: item slots scale with the world area to stay under the wire's 262144, a fresh world is seeded from `live-founders.json` (checked like an upload), a save of another world is not restored, the page builds the map from the name in the hello. Numbers in `docs/status.md` A7.
- 2026-10-12: L4 built. Entry card (watch or add); founders Explorer, Slow and steady, Peaceful, Hunter-ish measured by `scripts/pickFounders.ts` into `public/live-founders.json`; tuning keeps the founder's layer count; Pretrain (far-food, patch, minefield) and fine-tune (crowd, rivals) are 30 s of evolution strategies each on the Arena's worker, kept only if they beat the start on held-out layouts; added creatures start with `add.startEnergy` (300) and may first give birth `add.birthHoldS` (60 s) after insertion, both admin settings; the hold is the engine's own birth gate (a last birth placed in the future), so no engine change. Protocol 4 (founder u32, names in DETAIL and lineages, add, map info in the hello).
- 2026-10-11: self-hosted server behind an HTTPS tunnel (public port only), world pauses while the host is off (page says offline), saves every 4 h kept 4 days with admin revert, founders hand-picked from `pool.json`, 2x speed by default (now 3x), viewer cap 100 with a 3 MB/s upload budget, server at lowest CPU and IO priority.
- 2026-10-11: v2 viewer (protocol 2): Ecosystem panels on the live page, a viewer may follow one creature (rays, brain, energy, birth traits at 5 Hz from a 3 kB/s allowance), item changes ride with each frame and apply at their tick, seasons on, 4x by default (now 3x), 6 helper threads at idle priority (`LIVE_THREADS`, now off, see below).
- 2026-10-11: helper threads off by default: under SCHED_IDLE the server gets about one core whatever the thread count, and 6 helpers cost 2.3x the CPU per tick (92 against 53 ticks/s at 1190 creatures).
