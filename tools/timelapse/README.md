# Live world time-lapse

`timelapse.mjs` saves one PNG of the Live world every 20 s into `<out>/<world id>_<start>/`, one folder per world (per reset), and logs `population.jsonl` (every 5 s) and `frames.jsonl` next to them.
A light websocket viewer (no browser) is always on and detects resets.
Chrome runs only while frames are wanted and closes when a folder reaches the cap (30 GB) or the disk has less than 20 GB free.
At most 2 viewers connect from this machine (the light client and Chrome).
Output folder default: `/home/erik/progs/evolve-world-ai/videos/timelapse` (gets a `.gitignore` with `*`). Set it with `out=<dir>`, in the unit's `ExecStart` for the service.
Other parameters (`framing`, `interval`, `capBytes`, `popEvery`, `server`, `pagePort`) sit in the `P` block at the top of the script and take `key=value` arguments.

## Setup
1. Build the page from the commit the server runs: `flock <repo>/.claude/heavy.lock nice -n 19 tools/timelapse/build-page.sh` (writes `tools/timelapse/page/` and a stamp with commit and protocol version).
   After a promote or any protocol change, rebuild from the new commit. On a version mismatch the script logs `VERSION MISMATCH` and takes no frames until you do.
2. Chrome at `/usr/bin/google-chrome` and `puppeteer-core` (`puppeteer=<path to the package>` if it is not at the default).

## Service (user unit, not installed yet)
```
sed -e 's|@REPO@|/home/erik/progs/evolve-world-ai|' -e 's|@NODE@|<node dir>|' -e 's|@OUT@|/home/erik/progs/evolve-world-ai/videos/timelapse|' tools/timelapse/evolve-timelapse.service.template > ~/.config/systemd/user/evolve-timelapse.service
systemctl --user daemon-reload
systemctl --user enable --now evolve-timelapse     # install and start
systemctl --user status evolve-timelapse           # status
journalctl --user -u evolve-timelapse -f           # log
systemctl --user stop evolve-timelapse             # stop
```

## Video
ffmpeg is not installed: `sudo apt install ffmpeg`.
```
ffmpeg -framerate 30 -pattern_type glob -i '<world folder>/*.png' -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p out.mp4
```
All frames of a world have the same even size. File names sort by UTC time.

## Population chart
`node tools/timelapse/popchart.mjs <world folder> png=1` writes `population.svg` (and `.png` with `png=1`) with one line per founder, coloured `hsl(hue, 75%, 58%)` from the hue the stats carry (the page's creature colour).
