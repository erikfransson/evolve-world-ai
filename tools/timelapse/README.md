# Live world time-lapse

`timelapse.mjs` saves one PNG of the Live world every 20 s into `<out>/<world id>_<start>/`, one folder per world (per reset).
Next to the frames it writes `frames.jsonl`, `population.jsonl` (every 5 s, per founder lineage) and `regions.jsonl` (creature counts per map region and hue, one line per frame, layout in `world.json`).
A light websocket viewer is always on and detects resets.
Chrome runs only while frames are wanted and closes when a folder reaches the cap (30 GB) or the disk has less than 20 GB free.
At most 2 viewers connect from this machine (the light client and Chrome).
The output folder defaults to `/home/erik/progs/evolve-world-ai/videos/timelapse` (it gets a `.gitignore` with `*`).
Set it with `out=<dir>`.
Other parameters (`framing`, `interval`, `capBytes`, `server`, `pagePort`) sit in the `P` block at the top of the script and take `key=value` arguments.
Chrome is the system `/usr/bin/google-chrome`. `puppeteer-core` never downloads a browser, so nothing else is fetched.

## Install
Run these from a checkout at the released commit (the same commit the server runs).
```
cd <repo>/tools/timelapse
nice -n 19 npm ci
nice -n 19 ./build-page.sh
mkdir -p ~/.config/systemd/user
sed -e 's|@REPO@|<repo>|' -e 's|@NODE@|<node dir, the one that holds bin/node>|' -e 's|@OUT@|<output folder>|' evolve-timelapse.service.template > ~/.config/systemd/user/evolve-timelapse.service
systemctl --user daemon-reload
systemctl --user enable --now evolve-timelapse
```
Wrap `npm ci` and `build-page.sh` in `flock <repo>/.claude/heavy.lock` where that lock is in use.
Status: `systemctl --user status evolve-timelapse`. Log: `journalctl --user -u evolve-timelapse -f`. Stop: `systemctl --user stop evolve-timelapse`.

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
