# Live server

Runs the one shared world behind the Live World page.
It steps the ecosystem (up to 4x real time, slower when the host is busy) on one thread (`LIVE_THREADS` adds helper threads for sensing and thinking; at idle priority on a busy host they cost 2.3x the CPU per tick for no gain), streams compact binary frames to viewers over a public WebSocket port, and has an admin channel on loopback only.
The wire format is in `src/typescript/src/live/protocol.ts`.

## Safety model
- Visitors can watch, follow one creature and add creatures: a client may send a ping, a strictly checked `select` (one integer id) or an `add` (live/add.ts: exact keys, the creature-file checks, at most the largest genome's size); anything else gets it cut off.
- Adds (adds.ts, admin-tunable as `add.*`): 20 creatures per 5 minutes for everyone, 3 per visitor address (from the X-Forwarded-For that Tailscale Funnel sets; off until checked through the real tunnel, `LIVE_TRUST_FORWARDED=1` turns it on), added creatures alive at most 10% of the population, none while the world is busy or paused; per connection 2 adds then one per 10 s (faster cuts it off), and at most 2 add messages a second are read for all viewers together.
- Every resource is bounded: new viewers (10 a second, burst 30), viewers (100, fewer when the frames would pass the upload budget at the slowest rate), population (2500), message size and rate, selection changes (2 a second), followed-creature details (3 kB/s per viewer) and their senses (25 a second for all), item changes per frame (else a full item set from the connect allowance), history (bounded rings), send buffers, request header time, save size on disk and when unzipped, save parsing (worker with its own heap cap).
- Dead, slow and flooding clients are terminated; no client input can crash the process.
- Admin listens on loopback only, needs a token kept on the host, and accepts browsers only from its own page.
- Saves are gzipped JSON, read only as regular files, parsed and validated on a worker before a restore; a bad save falls back to an older one.
- `evolve-live.service.template` runs it as a sandboxed systemd user service: lowest CPU and IO priority, memory cap, home hidden except the checkout and the state dir.

## Development
`npm ci`, then `npm start` (ports and paths via `LIVE_PORT`, `LIVE_ADMIN_PORT`, `LIVE_STATE_DIR`, `LIVE_WEB_ROOT`).
`npm run admin -- <command>` talks to the admin channel; run it without arguments for the command list.
