#!/bin/bash
# usage: shot.sh N...   (renders ../map-N.png from ../map-N.data.js)
T=$(cd "$(dirname "$0")" && pwd); R=$T/..
for n in "$@"; do
  printf '<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#08150f}canvas{display:block}</style><canvas id=c></canvas>\n<script src="../map-%s.data.js"></script><script src="render.js"></script>\n' "$n" > $T/page-$n.html
  nice -n 19 google-chrome --headless=new --no-sandbox --disable-gpu --user-data-dir=$T/chrome-profile --hide-scrollbars --force-device-scale-factor=1 --window-size=2400,2210 --virtual-time-budget=40000 --screenshot=$R/$n.png file://$T/page-$n.html >/dev/null 2>&1
  ls -la $R/$n.png
done
rm -rf $T/chrome-profile
