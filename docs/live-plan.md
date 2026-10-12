# Live World plan (draft, 2026-10-11)

Issue #23, plus the visitor counter from #28.
One shared world that keeps running on a small self-hosted server; visitors watch it on the GitHub Pages site and add their own creatures.

## Goals
- Problem: every other mode is a private run that stops when the tab closes. Live is one world everyone shares and that keeps evolving.
- For: visitors of the site, and the owner as admin.
- Success: a visitor opens `live/`, sees the world running, designs or uploads a creature, inserts 10 named copies and can find and follow its lineage later.
- Not: accounts, chat, a cloud server, or anything that slows the host noticeably.

## Architecture
| Part           | Where                                  | Notes                                                                                     |
| -------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| World server   | `server/` in this repo, Node           | Runs the Ecosystem engine at 1x real time under `nice -n 19`, memory capped               |
| Public access  | Tunnel from the host                   | HTTPS tunnel: fixed URL, no open router ports, host IP hidden                             |
| Page           | `live/` on GitHub Pages                | Connects to the server over WebSocket; shows "world offline" when the host is off          |
| Design, train  | Visitor's browser                      | Pretrain (Trials) and RL fine-tuning run client side, so the host only simulates the world   |
| State          | `server/state/`, gitignored            | Gzipped save every 4 h and on stop, deleted after 4 days; restored on restart; admin can load any save |

No separate repo is needed.
Hourly state stays out of git, since a world of about 1000 creatures is a few MB per save and would bloat the history; an occasional chosen snapshot can be committed by hand.

## Server
- One world, Ecosystem rules: a very big world with collision damage on, tuned to about 1000 to 2000 creatures.
- Runs as a `systemd --user` service: `Nice=19`, `MemoryMax`, `CPUQuota`, restart on crash, no access outside `server/state/`.
- Streams compact binary frames (positions, angles, colours) at about 5 Hz and the page interpolates; caps viewers so upload bandwidth stays bounded.
- Admin: owner only. A separate admin port on loopback that the tunnel never exposes, plus a token kept on the host. It live-tunes world parameters, injects creatures, saves now, and loads a listed save to revert the world. Operations are documented privately.
- Counter: worlds running is 1, plus current viewers and total creatures inserted, served by the same server.
- Needs from the engine (owner: session 16): insert a creature at runtime, save and restore the full world state.

## Visitor flow
1. Page opens into the running world, with a hideable "Add your creature" panel on top.
2. Pick one of 4 clear named founders (more later) hand-picked from `pool.json` by measured behaviour (Explorer moves a lot, Slow and steady barely moves with wide rays, Peaceful avoids others, Aggressive approaches others), or upload a saved creature file.
3. Tune plan and settings within the form limits; energy per second updates live.
4. Optional toggles: Pretrain (quick Trials run) and RL fine-tune (RL envs from #27), both in the browser.
5. Choose name and colour, insert: 10 copies at random places. The page then follows and highlights that lineage.

## Safety
Follows "Uploaded creatures and settings" in `docs/modes-plan.md` (branch `rl-envs`): data only through `parseCreatureFile`, bounded cost, names rendered as text, re-validated on the server.
Server limits: insert rate per visitor, cap on visitor creatures alive, name length and character filter.

### Before uploads (L4/L5)
- Insert plans are already held to the creature-file `PLAN_LIMITS` (16 rays, 32 neurons, 8 memory units each).
- Name validation on the server for the visitor's own text (length, no control or invisible characters), shown via `textContent` only.
- Per-visitor limits need the visitor's address, which only a header from the tunnel (Funnel) can give; unverified whether it sends one.
- Test send backpressure through the real tunnel: a slow reader behind tailscaled must still be dropped by the send-queue caps.

## Build steps
| Step | Work                                                                          | Depends on              |
| ---- | ----------------------------------------------------------------------------- | ----------------------- |
| L1   | Engine hooks: insert creature, save and restore state                         | session 16 agrees       |
| L2   | `server/`: world loop, WebSocket frames, 4-hourly save, systemd unit          | L1                      |
| L3   | `live/` page: viewer with camera, offline fallback, counter                   | L2 protocol             |
| L4   | Design panel: named founders, tuning, energy per second, insert               | L3                      |
| L5   | Upload creature file, Pretrain and RL toggles                                 | L4, rl-envs on main     |
| L6   | Tunnel setup and admin panel                                                  | L2                      |

## Decisions
- 2026-10-11: self-hosted server behind an HTTPS tunnel (public port only), world pauses while the host is off (page says offline), saves every 4 h kept 4 days with admin revert, founders hand-picked from `pool.json`, 2x speed by default, viewer cap 100 with a 3 MB/s upload budget, server at lowest CPU and IO priority.
- 2026-10-11: v2 viewer (protocol 2): Ecosystem panels on the live page, a viewer may follow one creature (rays, brain, energy, birth traits at 5 Hz from a 3 kB/s allowance), item changes ride with each frame and apply at their tick, seasons on, 4x by default, 6 helper threads at idle priority (`LIVE_THREADS`).
- 2026-10-11: helper threads off by default: under SCHED_IDLE the server gets about one core whatever the thread count, and 6 helpers cost 2.3x the CPU per tick (92 against 53 ticks/s at 1190 creatures).
