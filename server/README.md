# Live server

Runs the one shared world behind the Live World page.
It steps the ecosystem (2x real time by default), streams compact binary frames to viewers over a public WebSocket port, and has an admin channel on loopback only.
The wire format is in `src/typescript/src/live/protocol.ts`.

## Safety model
- Visitors can only watch for now; the server ignores every client message except a ping.
- Every resource is bounded: new viewers (10 a second, burst 30), viewers (100, fewer when the frames would pass the upload budget at the slowest rate), population (2500), message size and rate, send buffers, request header time, save size on disk and when unzipped, save parsing (worker with its own heap cap).
- Dead, slow and flooding clients are terminated; no client input can crash the process.
- Admin listens on loopback only, needs a token kept on the host, and accepts browsers only from its own page.
- Saves are gzipped JSON, read only as regular files, parsed and validated on a worker before a restore; a bad save falls back to an older one.
- `evolve-live.service.template` runs it as a sandboxed systemd user service: lowest CPU and IO priority, memory cap, home hidden except the checkout and the state dir.

## Development
`npm ci`, then `npm start` (ports and paths via `LIVE_PORT`, `LIVE_ADMIN_PORT`, `LIVE_STATE_DIR`, `LIVE_WEB_ROOT`).
`npm run admin -- <command>` talks to the admin channel; run it without arguments for the command list.
