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

## Replay
`replay.mjs` redraws a world from its state log, with the Live page's own drawing code (map, items, creatures, winter tint, clock chip), as PNG frames or a video.
Build the page once per checkout, from a checkout with the map version the log was recorded with (the script refuses another):
```
cd <repo>/tools/timelapse
flock <repo>/.claude/heavy.lock nice -n 19 ./build-replay.sh
```
Then, for example (all at idle priority, `nice -n 19 ionice -c3 chrt --idle 0 node tools/timelapse/replay.mjs ...`):
```
replay.mjs world=<world folder> out=day.mp4 from=2026-11-15T01:00Z to=2026-11-15T09:00Z size=1920x1080       # every 5 s record, 30 fps
replay.mjs world=<world folder> out=frames mode=frames from=400000 to=401000                                   # PNG frames in the PNG framing (3720x2336)
replay.mjs world=<world folder> out=bloom.mp4 from=2026-11-15T05:00:00Z to=2026-11-15T05:01:00Z step=0.1s interpolate=1 size=1920x1080 keys='[{"t":"2026-11-15T05:00:00Z","center":[30000,18750],"zoom":1},{"t":"2026-11-15T05:01:00Z","center":[37227,31950],"zoom":8}]'
replay.mjs world=<world folder> out=plate.mkv codec=ffv1 clean=1 crop=1000,500,1900,1069 size=2560x1440 sidecar=1
```
- Frames: `step=N` takes every Nth 5 s record (`bursts=1` adds the 1 Hz burst records); `step=Xs` makes one frame per X simulated seconds from the records around it, and `interpolate=1` moves creatures between them by id (a newborn shows from its birth at its own place, the dead stay put until the next record, nothing slides across the map). `blend=N` averages N sub-frames per frame. `from`, `to`: ISO wall time or simulated seconds (`400000`, `111h`).
- Camera: by default the capture's framing (`world.json` camera and crop), so a frame at 3720x2336 lines up with the PNGs pixel for pixel; another `size` fits that framing.
  The creatures match a PNG only at the moment the PNG shows, which is not its file-name tick: a PNG lags it by about -4 to +150 simulated seconds (the page draws the frames it has, the screenshot comes later). Comparisons first fit that lag (the measured match, MAE about 0.45 and SSIM about 0.98 at 1 Hz burst records, is after the fit, with `chipFixed=0 ground=direct`; the default `ground=cache` composites the map from a layer and differs from the page by rounding, MAE 0.29 on a ground patch, 0.70 over the frame). `crop=x,y,w,h` (PNG px) draws that part natively at `size`, dots scaled with it. `center=x,y zoom=z` (world units, zoom 1 = whole map) is a fixed close-up with the page's dot size. `keys` (a JSON list or a file) moves the camera: `{t, center, zoom}` or `{t, crop}` per key, eased, zoom geometric.
- Look: `chip=0` (no clock), `items=0`, `wall=0` (no border line), `clean=1` (both off: plates for a pipeline that adds its own captions), `itemsUnknown=hold|none` for records whose item set is unknown.
  `chipFixed=1` (default) keeps the chip as wide as its widest text so its left edge holds still at a season change; `0` sizes it to its text as the page does.
  `winterTint` scales the winter tint (1 as Live, 0 off): faithful, but in a long time-lapse the whole map brightens and darkens once per simulated year.
  `creatures=fade` (default) keeps dots at their true size and cross-fades them into the page's detailed bodies while a creature's radius grows from 3 to 5 CSS px (and while fewer than 800 to 700 are in view), where the page switches in one frame; `live` switches as the page does, `dots` never draws bodies.
  A push-in that should end on drawn bodies needs about zoom 15 to 20 at 1920x1080 (zoom 9 still ends on dots). The facing tick is the logged heading (16 bits), turned the short way between records; creatures really turn a lot, about 90 degrees per 3 simulated seconds in the Mire (median), and some drift against their heading.
  Items come from the log every 30 s, so in close-ups food appears and goes in batches in single frames. The chip is translucent as on the page, so creatures show through it close up.
  Close up, the ground is the map's own art at that zoom: its colour wash is one pixel per raster cell (about 95 world units) drawn smoothly scaled, so at zoom 9 and more it is soft on the page too. A moving camera redraws the ground layer at its own resolution every frame (the page stretches its cache up to 2x while a visitor zooms).
- Output: `mode=mp4` with `codec=h264` (default `crf=12 preset=slow pix=yuv420p`, BT.709, faststart), `pix=yuv444p` and `crf=0` for lossless, `codec=ffv1` (lossless RGB, .mkv), `codec=prores` (4444, .mov); `mode=frames` writes `frame_NNNNNN.png`. `preview=1`: quarter size, fast encode. `threads=4` caps ffmpeg, `lookahead` its memory (below).
- Gaps (outage, restart, simulated time going back): `gap=cut` (default), `hold` (at most `holdMax` frames) or `fade` (`fadeS`, the world's rectangle fades, the margins keep their colour), never interpolated across.
- `sidecar=1` writes `<out>.jsonl`, one line per frame: simulated seconds, wall time, year, season, winterness, population, lineage rows with counts (starter names only), and the region by lineage matrix of `regions.jsonl`; `positions=all` or `positions=<id,id>` adds output-pixel positions with lineage row, hue and an added flag.
- At the end it prints a JSON summary: frames, render speed, records skipped (lost base, unknown items, times out of range, records before the header), gaps, and ffmpeg's exit code. It reads a log that is still being written up to its current end.
- Outputs: `out` and the sidecar must be in an existing folder outside `captureRoot` (default the world folder's parent, the capture's output folder) and must not be links. A video is written to a hidden `.<name>.<random>.part.<ext>` next to `out` and renamed at the end. After a failure (not of ffmpeg itself) ffmpeg still finishes the frames so far and the video is kept; exit code 1.
- Before drawing, a pass over the log counts the plan and prints frames, minutes of video and a rough size. It refuses more than `planMax` (400,000) frames, an output that would not fit above `diskStop`, and less than `diskStart` (20 GB) free; below `diskStop` (10 GB) free, or `memStop`, a render stops early and keeps the video (exit 3).
- Ctrl-C once finishes the video up to the current frame (exit 130, `stoppedEarly: "sigint"`); a second Ctrl-C, SIGTERM or SIGHUP quit at once and keep nothing.
- Hostile logs: a pool record is skipped when its wall time is not a finite ms count before year 275760 or its simulated time is outside 0 to 1e10; simulated time running over `simPerWall` (20) times the wall clock counts as a gap (the clock world runs at 3, at most 4.1); the plan stops with an error past 200,000 sub-frames between two records or 20,000,000 frames in all; `blend` is at most 32; death matching looks at most 2,000,000 events per record pair. The header's world must be the map's size, radius at most 100 and itemRadius at most 50 world units (the engine: 12 and 2 to 10). world.json's camera is used only when it is the capture's own framing a or b (else framing a, said in the summary), and a default output size is capped at 16 MP. A frame whose creatures would be drawn over a quarter of the frame wide skips them (counted).

How it works: Chrome draws each frame on a canvas of the output size with `EcoRenderer`, the map's `Terrain` and `ItemMirror`; the views come from `replayCore.mjs` (decoded and interpolated records) over loopback (ports 18920 to 18990); the canvas goes back over a WebSocket as RGBA, or as BT.709 YUV 4:2:0 made in the page for h264 yuv420p (3/8 of the bytes, the step that limits speed), and straight into ffmpeg. The clock chip is the page's own HTML and CSS, composited by Chrome and kept per text and background. The map is drawn into a layer at the camera's resolution, once per still camera and every frame for a moving one (`ground=direct` draws it every frame through the page's own path, as the page does for the capture's 8.5 M px view; the two differ by rounding only).
Chrome keeps its sandbox, draws in software like the capture (`gpu=1` lets it use the GPU), gets a fresh profile that is removed after (also on SIGINT, SIGTERM, SIGHUP and a crash), and reaches nothing but the script's loopback server, whose view packets and pixel socket sit under a random token per run (the socket also checks the page's Origin and takes one connection).
Memory: the script holds the reader's window (at most 8 MiB), the records around the current frame and two frame buffers (35 MB each at 3720x2336, plus 70 MB with `blend`); peak RSS 0.23 GB at 1920x1080 and 0.34 GB at 3840x2160. Chrome's processes add 1.4 to 1.8 GB summed (shared pages counted in each).
x264 holds its lookahead: at 3840x2160 with `preset=slow threads=4` it peaked at 1.85 GB with the preset's 50 frames, 1.15 GB with 20 and 0.91 GB with 10 (PSNR 45.91, 45.87 and 45.79 dB on a 150-frame test), so `lookahead` (x264 `rc-lookahead`) is 10 above 1920x1080 and the preset's up to it.
Speed (2026-11-15, 8 cores, idle priority, with other sessions running): 1920x1080 1.4 to 2.4 frames a second, 3840x2160 0.4 to 0.9, so ten days at every 5 s record (172,800 frames) take about 20 to 35 hours at 1920x1080 and 2 to 5 days at 3840x2160. Sending the frame back from Chrome takes most of it.
`memStart=3000` refuses to start with less MemAvailable (MB), and `memStop=2000` ends the render early when it drops below, finishing the video up to there and exiting with code 3 (`stoppedEarly` in the summary, which also gives `ffmpegPeakRssMB`). 0 turns either off.
`node tools/timelapse/replaySelfTest.mjs` writes a small state log with `StateWriter` and `StateRecorder`, renders it and checks frames, interpolation, births, deaths and the map version check (needs Chrome and the built page, so it is not part of the vitest suite).

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
A refused item message, or no full set for a minute (and a minute after the hello), makes the light client reconnect (at most once a minute, and not while the state log is off or paused) so the server sends a full set; meanwhile creature records carry itemSeq 0xffffffff. Such a reconnect frees the light client's viewer slot for about a second: on a server at its viewer cap a visitor can take it, and the light client then waits for a slot (stats go stale, so PNGs and all logs pause too). A state log that could not be opened is tried again once a minute. `status.json` has the state log's state (`writing`, `capped`, `disk-floor`, `error`, `paused` for a server protocol it does not store), `itemsValid` and `itemsInvalidS`; `check.mjs` flags a stale or future last creature record (`lastCreatureAt`), a log that could not be opened, a pause, the disk floor, and an item set unknown for over 90 s.
Gaps: while the server is down, the link is down or the stats are stale nothing is written, so the wall times jump. A restart of the script appends a header with a new `session` (and `resumed: true` on the first), and the chains start again from full records. A reset opens a new world folder.
The ground on the page is the map (`src/typescript/src/sim/maps`) and the winter tint from winterness, nothing else in it changes over time. Not on the wire, so not here: a newborn's parent, the cause of a death, whether a creature eats or attacks. Impact events are left out.
`world.json` gets `camera` when the world folder is opened or resumed (framings a and b, added only when missing): PNG pixel = ((origin + world units x zoom) - crop corner) x dsf, per axis, so rendered frames can be lined up with the PNGs.
