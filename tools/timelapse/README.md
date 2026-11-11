# Live world time-lapse

`timelapse.mjs` saves one PNG of the Live world every 20 s into `<out>/<world id>_<start>/`, one folder per world (per reset).
Next to the frames it writes `frames.jsonl`, `population.jsonl` (every 5 s, per founder lineage) and `regions.jsonl` (creature counts per map region and hue, one line per frame, layout in `world.json`).
A light websocket viewer is always on and detects resets.
Chrome runs only while frames are wanted and closes when a folder reaches the cap (30 GB) or the disk has less than 20 GB free.
It takes 2 viewer slots on the server (the light client and Chrome). The server admits about 9 viewers at 12000 creatures, so the capture costs public capacity at a full world.
The output folder defaults to `videos/timelapse` of the checkout (it gets a `.gitignore` with `*`).
Set it with `out=<dir>`.
Other parameters (`framing`, `interval`, `capBytes`, `server`, `socket`, `pagePort`) sit in the `P` block at the top of the script and take `key=value` arguments.
A plain run (development) connects to `server` (default `ws://127.0.0.1:8787`). The unit passes `socket=<path>` instead: it has no network device besides its own loopback, and a forwarder inside the script pipes Chrome's and the light client's loopback connections (`127.0.0.1:<fwdPort>`, 8794, at most 4) to that Unix socket, bytes only.
In that mode the script exits with code 1 when for `socketDeadS` (180 s) every connect to the socket failed and the light client is down, so the unit's restart starts the proxy socket again.
Chrome is the system `/usr/bin/google-chrome`. `puppeteer-core` never downloads a browser, so nothing else is fetched.
Chrome is closed and started fresh every `chromeRestartMin` minutes (default 60, 0 = never) right after a frame, because its memory creeps up over hours. A relaunch costs no frame, the frame for that slot comes 1 to 5 s late.
A Chrome start that fails is retried after 10 s, doubling to 5 min, and logged at most every 30 s.
A page that shows offline or loading at a slot gets `pageWaitS` (6) seconds to reconnect by itself (the server drops a slow viewer, which happens at the population boom), then is reloaded, and the frame follows as soon as the page is live.
Chrome keeps its own sandbox (no `--no-sandbox`) and talks to the script over a pipe, so no DevTools port opens.
The folder cap counts every file in the world folder (frames stop a little before it so the logs fit), and the logs stop at it.

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
cp evolve-timelapse-proxy.socket ~/.config/systemd/user/
sed -e 's|@PORT@|<Live public port, 8787>|' evolve-timelapse-proxy.service.template > ~/.config/systemd/user/evolve-timelapse-proxy.service
sed -e 's|@REPO@|<repo>|' -e 's|@NODE@|<node dir, the one that holds bin/node>|' -e 's|@OUT@|<output folder>|' evolve-timelapse.service.template > ~/.config/systemd/user/evolve-timelapse.service
systemctl --user daemon-reload
systemctl --user enable --now evolve-timelapse-proxy.socket
systemctl --user enable --now evolve-timelapse
systemctl --user restart evolve-timelapse
```
The last line matters when an older `evolve-timelapse` is already running: `enable --now` does not restart a running unit, and until it restarts the old one keeps the old sandbox (with network).
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
- Its own network namespace with only `lo`: the desktop's abstract sockets (Xwayland, ibus), host loopback ports and the internet refuse or are unreachable.
- All of `/run` is hidden: none of the host's listening path sockets connects (61 when checked) (system D-Bus, tailscaled, resolved, CUPS, avahi, snapd, journal, the user bus), and DNS lookups fail.
- A minimal `/dev`: no webcam, microphone, GPU, kvm or fuse.
- `clone3` returns ENOSYS (so `RestrictNamespaces` holds, user, pid and net only, for Chrome), io_uring is refused, and the desktop session's variables (`DISPLAY`, `DBUS_SESSION_BUS_ADDRESS` and others) are unset.

To get anything an attacker needs a working Chrome exploit chain, a renderer bug plus a sandbox escape, delivered through what visitors can put on the Live page (names, genomes) that the capture renders around the clock.
Once in, they control a process that can:
- write without limit into the output folder, on the same filesystem as the Live server's state and the system (the script's 20 GB floor is its own check, which native code skips);
- talk to the Live public port like a visitor through the proxy, with up to 4 connections and its own `X-Forwarded-For`, so it escapes the per-address viewer and add caps (the global caps hold) and can claim another visitor's address;
- keep a slow two-way channel to the attacker through Live itself (names and genomes in, its own adds out);
- use the kernel's interfaces for user, pid and net namespaces, and the rest of `@system-service`;
- fill the journal: per-unit `LogRateLimit*` has no effect in this user manager, so only journald's global per-unit limit applies. The script's own log lines are rate-limited; the proxy logs one line per refused connection.

It cannot see the desktop, home, the user's services, the system's sockets, the admin port or the network directly.
To get further it needs a second step: a kernel bug, or the owner running a tool over files it planted in the output folder.
The proxy runs in the host network with only IPv4 sockets and no writable path; the kernel splices the bytes, the proxy never parses them. Its known weakness is a busy loop on a hung-up client with a full pipe, bounded by its SCHED_IDLE class.

## Handling the output folder
Everything in it may have been written by a compromised capture.
- Never run `git` inside it: a planted `.git` with `core.fsmonitor` runs a command on `git status` there (git at the repo root does not read it).
- Read it only with `check.mjs` and `popchart.mjs` (they follow no links, block on no FIFO and print no control characters), view frames with an image viewer, and build videos with the ffmpeg line below.
- Do not copy files out of it into places where they would be run or loaded.

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
ffmpeg is not installed: `sudo apt install ffmpeg`.
```
ffmpeg -framerate 30 -pattern_type glob -i '<world folder>/*.png' -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p out.mp4
```
All frames of a world have the same even size, and file names sort by UTC time.

## Population chart
`node tools/timelapse/popchart.mjs <world folder> png=1` writes `population.svg` and `population.png`, one line per founder lineage, coloured from the hue the server sends.
