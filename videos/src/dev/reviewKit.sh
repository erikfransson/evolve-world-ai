#!/usr/bin/env bash
# Frames for reviewers who cannot play video: a 5x4 contact sheet at even times, a dense 0.25 s strip of a
# chosen window, and full-size stills. Usage: src/dev/reviewKit.sh out/x.mp4 "2.3,7.9,11.4" [window_start]
set -euo pipefail
FF=${FFMPEG:-$HOME/miniforge3/envs/videos/bin/ffmpeg}
FP=${FFPROBE:-$HOME/miniforge3/envs/videos/bin/ffprobe}
in=$1; times=${2:-}; win=${3:-}
name=$(basename "$in" .mp4)
dir=out/review/$name
mkdir -p "$dir"
dur=$($FP -v error -show_entries format=duration -of csv=p=0 "$in")
every=$(python3 -c "print($dur/20)")
nice -n 15 $FF -y -loglevel error -i "$in" -vf "fps=1/$every,scale=384:-1,drawtext=fontfile=$(fc-match -f '%{file}' 'DejaVu Sans'):text='%{pts\:hms}':x=6:y=6:fontsize=14:fontcolor=white:box=1:boxcolor=black@0.5,tile=5x4" -frames:v 1 "$dir/sheet.png"
if [ -n "$win" ]; then
  nice -n 15 $FF -y -loglevel error -ss "$win" -t 3 -i "$in" -vf "fps=4,scale=384:-1,tile=4x3" -frames:v 1 "$dir/strip-$win.png"
fi
IFS=, read -ra ts <<< "$times"
for t in "${ts[@]}"; do
  nice -n 15 $FF -y -loglevel error -ss "$t" -i "$in" -frames:v 1 -vf "scale=1280:-1" "$dir/still-$t.png"
done
# Loudness and audio cue overview.
if $FP -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "$in" | grep -q .; then
  nice -n 15 $FF -y -loglevel error -i "$in" -filter_complex "showwavespic=s=1600x200:split_channels=1" -frames:v 1 "$dir/wave.png"
  nice -n 15 $FF -hide_banner -nostats -i "$in" -af ebur128 -f null - 2>&1 | grep -A3 "Integrated loudness" | tr -s ' ' > "$dir/loudness.txt" || true
fi
ls "$dir"
