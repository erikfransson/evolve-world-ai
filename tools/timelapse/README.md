# Live world time-lapse

`timelapse.mjs` saves one PNG of the Live world every 20 s into `<out>/<world id>_<start>/`, one folder per world (per reset).
Next to the frames it writes `frames.jsonl`, `population.jsonl` (every 5 s, per founder lineage) and `regions.jsonl` (creature counts per map region and hue, one line per frame, layout in `world.json`).
A light websocket viewer is always on, detects resets and writes the state log (`state-NNNNN.evs`, see State log), from which a renderer can redraw the world long after the PNG cap.
Chrome runs only while frames are wanted and closes when a folder reaches the cap (50 GB) or the disk has less than 20 GB free.
It takes 2 viewer slots on the server (the light client and Chrome). The server admits about 9 viewers at 12000 creatures, so the capture costs public capacity at a full world.
The output folder defaults to `videos/timelapse` of the checkout (it gets a `.gitignore` with `*`).
Set it with `out=<dir>`.
Other parameters (`framing`, `interval`, `capBytes`, `server`, `socket`, `pagePort`) sit in the `P` block at the top of the script and take `key=value` arguments.
A plain run (development) connects to `server` (default `ws://127.0.0.1:8787`). The unit passes `socket=<path>` instead: it has no network device besides its own loopback, and a forwarder inside the script pipes Chrome's and the light client's loopback connections (`127.0.0.1:<fwdPort>`, 8794, at most 4) to that Unix socket, bytes only.
In that mode the script exits with code 1 when for `socketDeadS` (180 s) every connect to the socket failed and the light client is down, so the unit's restart starts the proxy socket again.
Chrome is the system `/usr/bin/google-chrome`. `puppeteer-core` never downloads a browser, so nothing else is fetched.
Chrome is closed and started fresh every `chromeRestartMin` minutes (default 60, 0 = never) right after a frame, because its memory creeps up over hours. A relaunch costs no frame, the frame for that slot comes 1 to 5 s late.
A Chrome start that fails is retried after 10 s, doubling to 5 min, and logged at most every 30 s.
A Chrome close that takes over `chromeCloseS` (20) seconds is ended with SIGKILL to its process group.
When the script is capturing but saved no frame for `stallExitMin` (10) minutes, it exits with code 1 and the unit restarts it. This clock does not run while the server is down or its stats are stale, the page shows offline, the tick stands still, the folder is capped or the page version does not match, nor while the laptop sleeps or the process is stopped, and a frame held back as suspicious restarts it. Each such exit uses one of the unit's five starts per hour, so a stall that a restart does not heal leaves the unit failed after about an hour (`systemctl --user reset-failed evolve-timelapse` and a start bring it back).
A page that shows offline or loading at a slot gets `pageWaitS` (6) seconds to reconnect by itself (the server drops a slow viewer, which happens at the population boom), then is reloaded, and the frame follows as soon as the page is live.
Chrome keeps its own sandbox (no `--no-sandbox`) and talks to the script over a pipe, so no DevTools port opens.
The folder cap counts every file in the world folder but the state log (frames stop a little before it so the logs fit), and the logs stop at it.
The state log has its own cap, `stateCapBytes` (30 GB per world), and also stops under the free-disk floor; it goes on when the disk has room again.
`frames=0` runs without Chrome and PNGs, logs only (a test hook).

## Install
Three units:
- `evolve-timelapse-proxy.socket`: the user manager creates `/run/user/<uid>/evolve-timelapse/` (mode 0700) and `live.sock` (0600) in it.
- `evolve-timelapse-proxy.service`: `systemd-socket-proxyd`, started on the first connection, forwards to the Live public port on 127.0.0.1 and nowhere else.
- `evolve-timelapse.service`: the capture, in its own network namespace, sees that directory read-only at `/tmp/evolve-timelapse/`.

Run these from a checkout at the released commit (the same commit the server runs).
```
cd <repo>/tools/timelapse
nice -n 19 npm ci
nice -n 19 ./build-page.sh
mkdir -p <output folder> ~/.config/systemd/user
cp -p ~/.config/systemd/user/evolve-timelapse.service ~/.config/systemd/user/evolve-timelapse.service.old   # only if one is installed: the rollback copy
cp evolve-timelapse-proxy.socket ~/.config/systemd/user/
sed -e 's|@PORT@|<Live public port, 8787>|' evolve-timelapse-proxy.service.template > ~/.config/systemd/user/evolve-timelapse-proxy.service
sed -e 's|@REPO@|<repo>|' -e 's|@NODE@|<node dir, the one that holds bin/node>|' -e 's|@OUT@|<output folder>|' evolve-timelapse.service.template > ~/.config/systemd/user/evolve-timelapse.service
systemctl --user daemon-reload
systemctl --user enable --now evolve-timelapse-proxy.socket
systemctl --user enable --now evolve-timelapse
systemctl --user restart evolve-timelapse
```
The last line matters when an older `evolve-timelapse` is already running: `enable --now` does not restart a running unit, and until it restarts the old one keeps the old sandbox (with network).
On a fresh install that `restart` starts the capture a second time right after `enable --now`: harmless, but it costs one Chrome start and one of the unit's five starts per hour.
To roll back to the unit that was in force before (this brings back its sandbox, with network):
```
systemctl --user stop evolve-timelapse
mv ~/.config/systemd/user/evolve-timelapse.service.old ~/.config/systemd/user/evolve-timelapse.service
systemctl --user daemon-reload
systemctl --user start evolve-timelapse
systemctl --user disable --now evolve-timelapse-proxy.socket evolve-timelapse-proxy   # the old unit does not use them
```
Check them:
1. `ls -la /run/user/$(id -u)/evolve-timelapse` shows the directory as `drwx------` with `srw------- live.sock`.
2. `curl -s --unix-socket /run/user/$(id -u)/evolve-timelapse/live.sock http://x/stats` prints `{"creatures":...,"viewers":...}` from the public port.
3. `systemctl --user status evolve-timelapse-proxy.socket evolve-timelapse-proxy evolve-timelapse`: the socket listening, the proxy and the capture running, the capture started after the `daemon-reload`.
4. `P=$(systemctl --user show -p MainPID --value evolve-timelapse); readlink /proc/$P/ns/net /proc/self/ns/net; tail -n +3 /proc/$P/net/dev`: two different namespaces, and only `lo` in the capture's.
5. `ls /proc/$P/root/dev /proc/$P/root/run`: a short `/dev` (null, zero, random, tty, pts, shm, no `video*`, `snd`, `dri`, `kvm`), and `/run` refused.
6. The journal's `start` line shows `socket: '/tmp/evolve-timelapse/live.sock'`, then `chrome ready` and `frame` lines.

If the proxy keeps failing, its socket ends `failed` and `live.sock` is gone; the capture then exits after `socketDeadS` and its restart starts the socket again (5 such restarts in an hour stop the capture).
By hand: `systemctl --user reset-failed evolve-timelapse-proxy.socket evolve-timelapse-proxy evolve-timelapse`, then `systemctl --user start evolve-timelapse-proxy.socket evolve-timelapse`.
The capture also gives up after 5 failed starts in an hour: `systemctl --user reset-failed evolve-timelapse`, then start it again.
Wrap `npm ci` and `build-page.sh` in `flock <repo>/.claude/heavy.lock` where that lock is in use.
Status: `systemctl --user status evolve-timelapse`. Log: `journalctl --user -u evolve-timelapse -f` (the proxy: `-u evolve-timelapse-proxy`). Stop: `systemctl --user stop evolve-timelapse`.
When the Live public port changes, change `@PORT@` in the installed proxy unit, `daemon-reload`, and `systemctl --user restart evolve-timelapse-proxy`.

## Sandbox and residual risk
`evolve-timelapse.service.template` comments each difference from the server unit. Checked under systemd 249 --user with transient units carrying every line of the templates:
- Home is hidden except the checkout (read-only), node and the output folder. `/tmp`, `/var/tmp` and `/dev/shm` are small private tmpfs mounts (256M, 16M, 64M; a run uses about 30 to 80 MB of `/tmp` with framing `a`). These and the output folder are the only writable places.
- Its own network namespace with only `lo`: the desktop's abstract sockets (Xwayland, ibus), host loopback ports and the internet refuse or are unreachable. Its only network path out is the proxy socket, and through it the Live protocol.
- All of `/run` is hidden, and `/home` and `/tmp` are private, so none of the host's listening path sockets connects (77 when checked, among them the system D-Bus, tailscaled, resolved, CUPS, avahi, snapd, the journal and the user bus), and DNS lookups fail. A socket a later install puts elsewhere, such as LXD's under `/var/snap`, would be reachable.
- A minimal `/dev`: no webcam, microphone, GPU, kvm or fuse.
- `clone3` returns ENOSYS (so `RestrictNamespaces` holds, user, pid and net only, for Chrome), io_uring is refused, and the desktop session's variables (`DISPLAY`, `DBUS_SESSION_BUS_ADDRESS` and others) are unset.

To get anything an attacker needs a working Chrome exploit chain, a renderer bug plus a sandbox escape, delivered through what visitors can put on the Live page (names, genomes) that the capture renders around the clock.
Once in, they control a process that can:
- write without limit into the output folder, on the same filesystem as the Live server's state and the system (the script's 20 GB floor is its own check, which native code skips);
- talk to the Live public port like a visitor through the proxy, with up to 4 connections and its own `X-Forwarded-For`, so it escapes the per-address viewer and add caps (the global caps hold) and can claim another visitor's address;
- keep a slow two-way channel to the attacker through Live itself (names and genomes in, its own adds out);
- use the kernel's interfaces for user, pid and net namespaces, and the rest of `@system-service`;
- fill the journal through its own stdout, and through the proxy (one line per refused connection): per-unit `LogRateLimit*` has no effect in this user manager, so only journald's global limit per unit applies, and old entries rotate out.

It cannot reach the desktop, home, the user's or the system's sockets, the admin port or the network directly. It can list the host's processes and read their command lines, but not their environment, files or memory.
To get further it needs a second step: a kernel bug, or the owner running a tool over files it planted in the output folder.
The proxy runs in the host network with only IPv4 sockets and no writable path; the kernel splices the bytes, the proxy never parses them. Its known weakness is a busy loop on a hung-up client with a full pipe: up to a full core, but only idle time (SCHED_IDLE), shared with the other idle-class jobs, until the server reads or closes that connection.

## Handling the output folder
Everything in it may have been written by a compromised capture.
- Never run `git` inside it: a planted `.git` with `core.fsmonitor` runs a command on `git status` there (git at the repo root does not read it).
- Read it only with `check.mjs`, `popchart.mjs` and `stateLog.mjs` (they follow no links, block on no FIFO, bound their reads and print no control characters). Build videos only from regular files (see Video), since the ffmpeg glob follows links. An image viewer or ffmpeg still parses data the attacker wrote, so a bug in them is the second step mentioned above.
- Do not copy files out of it into places where they would be run or loaded.
- If a compromise is suspected, stop the capture unit before running `popchart.mjs` on a folder it is writing: its path checks come before its reads and writes, so a process racing them could still redirect the chart into another folder.

## After a promote
1. Update the checkout the unit runs from to the released commit.
2. `./build-page.sh` in `tools/timelapse` (the stamp must match the server's protocol version, else the log says `VERSION MISMATCH` and no frames are taken).
3. `systemctl --user restart evolve-timelapse`.

## After a reset
1. `node tools/timelapse/check.mjs` (reads only the output folder, exit 0 = healthy, else one line saying what is wrong).
2. Open the newest PNG and look at it.
3. Run both again after a few minutes and after an hour.
The script also warns, saves no frame and reloads the page when it shows offline or loading, or when a frame is under a third of the running median bytes.

## Video
Needs ffmpeg (`sudo apt install ffmpeg`).
The glob below would follow a link planted among the frames (and pull one of your own images into the video), so the frames are first hard-linked into a fresh folder, regular files only (`find -type f` skips links; give the world folder without a trailing slash, so a linked world folder is not entered either):
```
F=$(mktemp -d)
find '<world folder>' -maxdepth 1 -type f -name '*.png' -exec ln -t "$F" {} +
ffmpeg -framerate 30 -pattern_type glob -i "$F/*.png" -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p out.mp4
rm -r "$F"
```
Hard links need the frames and `$F` on one filesystem; otherwise use `cp -t "$F"` in place of `ln -t "$F"`.
All frames of a world have the same even size, and file names sort by UTC time.

## Population chart
`node tools/timelapse/popchart.mjs <world folder> outdir=<output folder> png=1` writes `population.svg` and `population.png`, one line per founder lineage, coloured from the hue the server sends.
The world folder must be a real folder directly inside the output folder (`outdir` defaults to `videos/timelapse` of the checkout), and `out=<file.svg>` may point into that world folder or outside the output folder.
It reads at most 64 MB and 1000000 lines, keeps only rows that are JSON objects with a finite `simSeconds`, charts at most 200000 rows and 1000000 points, and says so when a cap cuts the chart.

## State log
The light client keeps what the server sends every viewer and writes it to `state-NNNNN.evs` in the world folder, in its own process and independent of Chrome and of the PNG cap.
Parameters: `stateEvery` (5 s between creature records, on the wall clock), `itemsEvery` (30 s between item records), `burstEvery` and `burstSeconds` (a burst of 1 Hz creature records, 60 s every 1200 s, for smooth close-ups; 0 turns either off), `stateKeyEvery` (600 s between full records), `stateCapBytes` (30 GB), `stateFileBytes` (256 MB per file), `stateMaxDeaths` (4096 per record).
Measured on a local test server (Six Realms, 2,100 to 3,200 creatures, 20,500 items, 2026-11-14): 7.5 bytes a creature in a 5 s record, 6.5 in a burst record, 11.5 in a full one; a full item set 97 kB, the changes over 30 s 42 kB (7,500 slots).
Projected per day, with item churn at most a full set every 30 s (0.29 GB a day; it grows with the population):

| Creatures | Defaults          | No bursts         | `stateEvery=10`, no bursts |
| --------- | ----------------- | ----------------- | -------------------------- |
| 4,000     | 0.79 GB (38 days) | 0.70 GB (43 days) | 0.49 GB (61 days)          |
| 12,000    | 2.1 GB (14 days)  | 1.85 GB (16 days) | 1.25 GB (24 days)          |

Read it with `stateLog.mjs`: `readStateLog(dir)` yields the records of all files in order, `ItemState` rebuilds the item set.
It reads the folder as hostile, like `check.mjs`: regular files only, no link followed, bounded reads, every length checked, inflation capped. The text in header and lineage records is data: strip control characters before printing it.

Layout, little-endian:
- A file is `EVOSTATE` (8 bytes), then records. Files sort by name; the next one starts when a record would pass `stateFileBytes`.
- A record is `A5 5E 7A 1E` | u32 body bytes (at most 4 MiB) | u8 type | u8 flags (bit 0: the body is raw deflate) | u32 crc32 of type, flags and stored body | body. A bad sync, length, crc or body is skipped up to the next sync (the reader spends at most 2 x file size + 8 MiB on crc checks per file, then skips the rest of it). A torn tail or a corrupt record loses itself; a lost creature record also loses the creature records that follow it up to the next full one, and a lost item record the item set up to the next full set (at most `stateKeyEvery` s).
- 1 header, JSON: `format` (1), `protocol` (6, the wire's), `creatureRecord` (19), `worldId` (the folder's world id), `world` {width, height}, `dt` (simulated seconds per tick), `map`, `mapVersion`, `serverVersion`, `itemSlots`, `radius`, `itemRadius`, `fullEnergy` (from the hello), `build` (the built page's stamp: commit, protocol), `params`, `session`, `part` (file number), `resumed`, `openedAt`. Every file starts with one, and one more follows each start of the script (a new `session`) and each reopen after a write error (the same session).
- 2 creatures (the first frame in each `stateEvery` slot; the server sends the light client 1 to 5 frames a second, fewer when it is busy) and 3 burst (1 Hz in a burst, the slots between regular records): f64 wallMs | f64 simSeconds (the server's whole seconds plus ticks x dt since its stats; tick x dt is exact) | u32 tick | u32 population (stats) | u32 itemSeq | f32 winterness (0 summer to 1 mid-winter, -1 without seasons) | f32 yearMinutes | f32 winterFood | u32 count | u32 seq | u32 baseSeq | 19 byte planes of count bytes (plane j holds byte j of each creature).
  The creatures are sorted by id, ties in frame order. Planes 0 to 3 hold the id as the u32 gap to the previous id (the first from 0). When baseSeq is not 0xffffffff, a creature whose id is in record baseSeq stores, for x, y, heading, hue (16 bits) and radius, energy, age (8 bits), the difference to it wrapped modulo 2^bits into -2^(bits-1) .. 2^(bits-1) - 1 and zigzagged ((d << 1) ^ (d >> 31)); decoding adds modulo 2^bits. Founder holds the u32 difference modulo 2^32. A 16-bit field keeps its low byte in plane f and its high byte in plane f + 1. A creature new since then is stored as is, and a duplicate id is coded against the first base creature with that id.
  seq starts at a random u32 in each session and goes up by one per creature record written (types 2 and 3 share it), wrapping and skipping 0xffffffff; baseSeq is the seq of the creature record written just before, or 0xffffffff for a full record (the first of a session, after a failed write, every `stateKeyEvery` s). Item records (types 4 and 5) have their own seq, with the same rules. `readStateLog` undoes all this and gives `records`, count x 19 bytes in the wire layout of `src/typescript/src/live/protocol.ts` (u32 id | u16 x | u16 y | u16 heading | u8 radius | u8 energy | u8 age | u16 hue | u32 founder), or null when the base was lost (until the next full record).
- 4 item set: f64 wallMs | u32 tick | u32 seq | u32 slots | u32 n | ceil(slots / 4) bytes of 2-bit kinds by slot (0 free, 1 food, 2 poison) | n u16 x | n u16 y, in slot order. Written first, after a gap in the chain, every `stateKeyEvery` s, and when the changes would be larger.
- 5 item changes since the last item record: f64 wallMs | u32 tick | u32 seq | u32 baseSeq | u32 n | u32 m | n u32 words (slot gap to the previous changed slot | kind << 18) as 4 byte planes | m u16 x | m u16 y for the n words with kind not 0, in order. Kind 0 frees the slot. It applies only to the set of seq baseSeq.
- 6 deaths since the last record: f64 wallMs | u32 tick | u32 n | u32 dropped | n u16 ticks before tick (0 to 65535) | n u16 x | n u16 y | n u16 hue. dropped counts deaths over `stateMaxDeaths` and deaths not 0 to 65535 ticks before tick (kept while nothing was recorded), capped at 2^32 - 1. The server sends at most 32 events per server frame, impacts included, and deaths in frames a full-set resync skipped are lost without a count.
- 7 lineages, JSON {wallMs, tick, lineages: [{founder, hue, starter, count, name, founders}]}, when the table's make-up changes (not its counts; `population.jsonl` has those every 5 s). Names are kept only for starter lineages. founders lists the other founder ids counted in the row.

Units: x, y are u16 over the world (world x = x / 65535 x width), heading 0 to 65535 over 0 to 2 pi, radius in quarter units, energy 0 to 255 of `fullEnergy`, age whole seconds capped at 255, hue 0 to 65535 over 360 degrees, as on the wire. Item x, y the same.
The lineages, item and death records that go with a creature record come right before it, with its tick. The item set to draw with a creature record is the one whose seq equals its itemSeq (`ItemState.seq`), as of the last item record, at most `itemsEvery` s older; 0xffffffff means unknown (no full set since the light client connected).
A refused item message, or no full set for a minute, makes the light client reconnect (at most once a minute) so the server sends a full set; meanwhile creature records carry itemSeq 0xffffffff. `status.json` has the state log's state (`writing`, `capped`, `disk-floor`, `error`, `paused` for a server protocol it does not store), `itemsValid` and `itemsInvalidS`; `check.mjs` flags a stale or future newest write, a log that could not be opened, a pause, the disk floor, and an item set unknown for over 90 s.
Gaps: while the server is down, the link is down or the stats are stale nothing is written, so the wall times jump. A restart of the script appends a header with a new `session` (and `resumed: true` on the first), and the chains start again from full records. A reset opens a new world folder.
The ground on the page is the map (`src/typescript/src/sim/maps`) and the winter tint from winterness, nothing else in it changes over time. Not on the wire, so not here: a newborn's parent, the cause of a death, whether a creature eats or attacks. Impact events are left out.
`world.json` gets `camera` with the first PNG (framings a and b): PNG pixel = ((origin + world units x zoom) - crop corner) x dsf, per axis, so rendered frames can be lined up with the PNGs.
