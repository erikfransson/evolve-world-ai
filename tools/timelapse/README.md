# Live world time-lapse

`timelapse.mjs` saves one PNG of the Live world every 20 s into `<out>/<world id>_<start>/`, one folder per world (per reset).
Next to the frames it writes `frames.jsonl`, `population.jsonl` (every 5 s, per founder lineage) and `regions.jsonl` (creature counts per map region and hue, one line per frame, layout in `world.json`).
A light websocket viewer is always on and detects resets.
Chrome runs only while frames are wanted and closes when a folder reaches the cap (30 GB) or the disk has less than 20 GB free.
It takes 2 viewer slots on the server (the light client and Chrome). The server admits about 9 viewers at 12000 creatures, so the capture costs public capacity at a full world.
The output folder defaults to `videos/timelapse` of the checkout (it gets a `.gitignore` with `*`).
Set it with `out=<dir>`.
Other parameters (`framing`, `interval`, `capBytes`, `server`, `socket`, `pagePort`) sit in the `P` block at the top of the script and take `key=value` arguments.
A plain run (development) connects to `server` (default `ws://127.0.0.1:8787`). The unit passes `socket=<path>` instead: it has no network, and a forwarder inside the script pipes Chrome's and the light client's loopback connections (`127.0.0.1:<fwdPort>`, 8794, at most 4) to that Unix socket, bytes only.
Chrome is the system `/usr/bin/google-chrome`. `puppeteer-core` never downloads a browser, so nothing else is fetched.
Chrome is closed and started fresh every `chromeRestartMin` minutes (default 60, 0 = never) right after a frame, because its memory creeps up over hours. A relaunch costs no frame, the frame for that slot comes 1 to 5 s late.
A Chrome start that fails is retried after 10 s, doubling to 5 min, and logged at most every 30 s.
A page that shows offline or loading at a slot gets `pageWaitS` (6) seconds to reconnect by itself (the server drops a slow viewer, which happens at the population boom), then is reloaded, and the frame follows as soon as the page is live.
Chrome keeps its own sandbox (no `--no-sandbox`) and talks to the script over a pipe, so no DevTools port opens.
The folder cap counts every file in the world folder (frames stop a little before it so the logs fit), and the logs stop at it.

## Install
Three units: `evolve-timelapse-proxy.socket` (the user manager creates `/run/user/<uid>/evolve-timelapse/`, mode 0700, and `live.sock` in it), `evolve-timelapse-proxy.service` (`systemd-socket-proxyd`, started on the first connection, forwards to the Live public port on 127.0.0.1 and nowhere else), and `evolve-timelapse.service` (the capture, in its own network namespace, sees that directory read-only at `/run/user/evolve-timelapse/`).
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
```
Check them:
1. `ls -la /run/user/$(id -u)/evolve-timelapse` shows the directory as `drwx------` with `srw------- live.sock`.
2. `curl -s --unix-socket /run/user/$(id -u)/evolve-timelapse/live.sock http://x/stats` prints `{"creatures":...,"viewers":...}` from the public port.
3. `systemctl --user status evolve-timelapse-proxy.socket evolve-timelapse-proxy evolve-timelapse`: the socket listening, the proxy and the capture running.
4. `P=$(systemctl --user show -p MainPID --value evolve-timelapse); readlink /proc/$P/ns/net /proc/self/ns/net; tail -n +3 /proc/$P/net/dev`: two different namespaces, and only `lo` in the capture's.
5. The journal's `start` line shows `socket: '/run/user/evolve-timelapse/live.sock'`, then `chrome ready` and `frame` lines.

The capture unit hides home except the checkout (read-only), node and the output folder, and drops the user D-Bus; `evolve-timelapse.service.template` comments each difference from the server unit.
With `PrivateNetwork=yes` the desktop's abstract Unix sockets (Xwayland, ibus, session buses), the host loopback (the admin port included) and the internet are out of reach; checked under systemd 249 --user: X11 and ibus connects are refused, `DISPLAY=:0 xdpyinfo` cannot open the display, host loopback ports are refused, and there is no route out.
Through the socket a compromised capture reaches only the Live public port, at most 4 connections at once, as a loopback client: the same handlers and limits as any visitor, except the per-address caps, since it sends no Funnel `X-Forwarded-For` (it can send its own).
The proxy unit has no home, no writable path, no IPC and only IPv4 sockets, but it shares the host network, so a bug in `systemd-socket-proxyd` reached through the bytes it copies would reach the host loopback and the internet (a user manager cannot load the `IPAddressDeny=` filter).
What remains open: the kernel's surface (Chrome needs user, pid and net namespaces, so this unit can create them), the output folder (writable, shared with whoever reads the frames), and processes of the same user outside the sandbox that read the frames or logs.
The unit's `/tmp`, `/var/tmp` and `/dev/shm` are small tmpfs mounts (256M, 16M, 64M; a run uses about 30 to 80 MB of `/tmp`, measured with framing `a`, not with `b`), `/home` is a read-only tmpfs (`HOME=/tmp`), the host's `/run/lock` and `/dev/mqueue` are hidden, and the syscall filter is `@system-service chroot`.
It gives up after 5 failed starts in an hour: `systemctl --user reset-failed evolve-timelapse` then start it again.
Wrap `npm ci` and `build-page.sh` in `flock <repo>/.claude/heavy.lock` where that lock is in use.
Status: `systemctl --user status evolve-timelapse`. Log: `journalctl --user -u evolve-timelapse -f` (the proxy: `-u evolve-timelapse-proxy`). Stop: `systemctl --user stop evolve-timelapse`.
When the Live public port changes, change `@PORT@` in the installed proxy unit, `daemon-reload`, and `systemctl --user restart evolve-timelapse-proxy`.

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
