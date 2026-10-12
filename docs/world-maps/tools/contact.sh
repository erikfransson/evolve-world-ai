#!/bin/bash
# builds ../contact-sheet.png: the five maps (map area only) side by side
T=$(cd "$(dirname "$0")" && pwd); R=$T/..
cat > $T/contact.html <<'H'
<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#08150f}canvas{display:block}</style><canvas id=c width=3960 height=730></canvas>
<script>
const names=["F1 Realms","F2 Three Rivers","F3 Oases in the Dry","F4 The Inland Sea"];
const c=document.getElementById("c"),g=c.getContext("2d");g.fillStyle="#08150f";g.fillRect(0,0,3960,730);
let left=4;
names.forEach((n,i)=>{const im=new Image();im.onload=()=>{const x=20+i*985;g.imageSmoothingQuality="high";g.drawImage(im,60,178,2280,1419,x,70,960,597);g.strokeStyle="#2c5744";g.strokeRect(x,70,960,597);g.fillStyle="#e6f4ea";g.font="600 26px 'Noto Serif CJK JP',serif";g.fillText(n,x,50);g.fillStyle="#8fae9f";g.font="15px sans-serif";g.fillText("54 000 × 33 600 units",x,700);if(--left===0)document.title="done";};im.src="F"+(i+1)+".png";});
</script>
H
cp $R/F?.png $T/ 2>/dev/null
nice -n 19 google-chrome --headless=new --no-sandbox --disable-gpu --user-data-dir=$T/chrome-profile --hide-scrollbars --force-device-scale-factor=1 --window-size=3960,730 --virtual-time-budget=20000 --screenshot=$R/contact-sheet.png file://$T/contact.html >/dev/null 2>&1
rm -rf $T/chrome-profile $T/F?.png
ls -la $R/contact-sheet.png
