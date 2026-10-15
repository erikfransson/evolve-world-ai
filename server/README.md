# Live server

Runs the one shared world behind the Live World page.
It steps the ecosystem (3x real time by default, slower when the host is busy) on one thread (`LIVE_THREADS` adds helper threads for sensing and thinking; at idle priority on a busy host they cost 2.3x the CPU per tick for no gain), streams compact binary frames to viewers over a public WebSocket port, and has an admin channel on loopback only.
The wire format is in `src/typescript/src/live/protocol.ts`.

## Safety model
- The public port answers only the WebSocket upgrade and `GET /stats` (`{creatures, viewers}` for the landing page: CORS *, no request body read, rebuilt at most once a second, 5 a second for all callers with a burst of 20, past that a 503); every other request gets a 426.
- Visitors can watch, follow one creature and add creatures: a client may send a ping, a strictly checked `select` (one integer id) or an `add` (live/add.ts: exact keys, the creature-file checks, at most the largest genome's size); anything else gets it cut off.
- Adds (adds.ts, admin-tunable as `add.*`): 20 creatures per 5 minutes for everyone, 3 per visitor address (from the X-Forwarded-For that Tailscale Funnel sets; off until checked through the real tunnel, `LIVE_TRUST_FORWARDED=1` turns it on), added creatures alive at most 10% of the population or 20, whichever is more (so an empty world can be populated), none while the world is busy or paused; per connection 2 adds then one per 10 s (faster is refused unread with the wait, and after 3 such strikes the connection is cut off), and at most 2 add messages a second are read for all viewers together. Admin changes reach open pages as a `rules` message.
- A save is checked by the same worker parse and restore as a load before it is written; one that would not restore is never written.
- Only saves of the configured world (size and map) restore, and the search stops at the first other one, so a new map starts a fresh world, saved at once. Saves of the earlier world are not restored, and rotation deletes them like any save (after 4 days, once six newer exist): copy them aside before switching maps if the old world matters.
- A fresh world is seeded with 10 copies of each founder in `src/typescript/public/live-founders.json` (`LIVE_FOUNDERS_FILE` overrides), checked like an upload on every start: at most 8 founders and 512 kB, every one valid, or the server exits with the reason. A fresh world moves `admin-overrides.json` to `admin-overrides.previous-world.json` (replacing an older copy), so the earlier world's settings never apply to it.
- Item slots are fixed when a world is built: room for the admin to raise the caps, held under 0.9 of the wire's 262144 slots (`itemHeadroom`, food 2.3 and poison 0.05 on the Inland Sea).
- Every resource is bounded: new viewers (10 a second, burst 30), viewers (100, fewer when the frames would pass the upload budget at the slowest rate), population (3000), message size and rate, selection changes (2 a second), followed-creature details (3 kB/s per viewer) and their senses (25 a second for all), item changes per frame (else a full item set from the connect allowance), history (bounded rings), send buffers, request header time, save size on disk and when unzipped, save parsing (worker with its own heap cap).
- Dead, slow and flooding clients are terminated; no client input can crash the process.
- Admin listens on loopback only, needs a token kept on the host, and accepts browsers only from its own page.
- Saves are gzipped JSON, read only as regular files, parsed and validated on a worker before a restore; a bad save falls back to an older one.
- `evolve-live.service.template` runs it as a sandboxed systemd user service: lowest CPU and IO priority, memory cap, home hidden except the checkout and the state dir.

## Development
`npm ci`, then `npm start` (ports and paths via `LIVE_PORT`, `LIVE_ADMIN_PORT`, `LIVE_STATE_DIR`, `LIVE_WEB_ROOT`).
`npm run admin -- <command>` talks to the admin channel; run it without arguments for the command list.
`blank-name <name>` clears an unfit visitor name from every family that carries it; the families live on unnamed.
