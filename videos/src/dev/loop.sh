#!/usr/bin/env bash
# Turns a rendered clip into a seamless loop by crossfading its last second into its first, then exports
# README-sized GIF and animated WebP. Usage: src/dev/loop.sh out/readme-cute.mp4 [width=640] [fps=25]
set -euo pipefail
FF=${FFMPEG:-$HOME/miniforge3/envs/videos/bin/ffmpeg}
FP=${FFPROBE:-$HOME/miniforge3/envs/videos/bin/ffprobe}
in=$1; w=${2:-640}; fps=${3:-25}
base=${in%.mp4}
dur=$($FP -v error -show_entries format=duration -of csv=p=0 "$in")
main=$(python3 -c "print(round($dur - 1, 3))")
# Body is [1, dur]; its last second fades into [0, 1], which is where the body begins.
nice -n 15 $FF -y -loglevel error -i "$in" -filter_complex \
  "[0:v]trim=1:$dur,setpts=PTS-STARTPTS[body];[0:v]trim=0:1,setpts=PTS-STARTPTS[head];[body][head]xfade=transition=fade:duration=1:offset=$(python3 -c "print($main - 1)"),fps=$fps,scale=$w:-2:flags=lanczos[v]" \
  -map "[v]" -an -c:v libx264 -crf 18 -pix_fmt yuv420p "$base-loop.mp4"
nice -n 15 $FF -y -loglevel error -i "$base-loop.mp4" -vf "split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" -loop 0 "$base-loop.gif"
nice -n 15 $FF -y -loglevel error -i "$base-loop.mp4" -c:v libwebp -lossless 0 -q:v 72 -compression_level 6 -loop 0 "$base-loop.webp"
ls -la "$base-loop".*
