# Videos

Polished short animations of the Evolve World creatures: trailers and README demos.

## Goals
- Trailers of 15, 30 and 60 s, one or two variants each, as polished as we can make them: camera moves, cuts, sound effects, music.
- Short loops (a few seconds) for the GitHub README.
- Creatures with faces that react: happy when eating, sick after poison, angry when bumped, a glowing brain when learning.
- Iterate in rounds: render samples, rate them, adjust. Samples first, the final trailer last.

## Not goals
- No videos in git. Only code, plans and notes live here; renders go to `out/` (gitignored).
- The site and simulation code are untouched. Shots import from `src/typescript/src` read-only.

## Pipeline
- Shots are TypeScript modules in `src/shots/`, drawn with the Canvas 2D API by [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (Skia) in Node, no browser.
- `src/render.ts` steps a shot at a fixed frame rate and pipes raw frames into ffmpeg (H.264, CRF 16). Every render is deterministic.
- `src/lib/`: `critter.ts` (body, face, squash and stretch, three styles), `face.ts` (expression rig and emotions), `fx.ts` (sparkles, hearts, anger marks, comic words, brain hologram), `stage.ts` (floor, food, poison, camera), `ease.ts` (easing, keyframes, paths, seeded noise), `crowd.ts` (a grazing crowd driven by the real simulation), `audio.ts` (synthesized effects and music bed mixed to a WAV that the renderer muxes in), `titles.ts` (title cards), `paint.ts` (soft shapes), `shot.ts` (the shot interface).

## Setup
```
cd videos
npm install
mkdir -p assets/fonts && curl -sSfL -o assets/fonts/Fredoka.ttf "https://github.com/google/fonts/raw/main/ofl/fredoka/Fredoka%5Bwdth,wght%5D.ttf"
~/miniforge3/bin/mamba create -y -n videos -c conda-forge ffmpeg   # or set FFMPEG=/path/to/ffmpeg
```

## Render
```
node src/render.ts emotions --style cute                       # 1920x1080, 60 fps -> out/emotions-cute.mp4
node src/render.ts emotions --style neon --scale 0.5 --fps 30 --sheet --stills 2.5,9.9   # quick preview, contact sheet and stills
```
Styles: `classic` (the site look plus faces), `cute` (glossy toy look with feelers), `neon` (glowing line art).
Run renders under `nice`; `npm run render -- <shot>` does that.

Progress, ratings and decisions: `NOTES.md`.
