// Renders a shot frame by frame and pipes raw RGBA into ffmpeg.
// Usage: node src/render.ts <shot> [--style cute] [--w 1920] [--h 1080] [--fps 60] [--scale 0.5]
//        [--from 0] [--to 5] [--stills 1,2.5] [--sheet] [--crf 16] [--out name] [--no-video]
import { ImageData, createCanvas } from "@napi-rs/canvas";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import type { Shot, ShotOptions } from "./lib/shot.ts";

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    style: { type: "string", default: "cute" },
    w: { type: "string", default: "1920" },
    h: { type: "string", default: "1080" },
    fps: { type: "string", default: "60" },
    scale: { type: "string", default: "1" },
    from: { type: "string" },
    to: { type: "string" },
    stills: { type: "string" },
    sheet: { type: "boolean", default: false },
    crf: { type: "string", default: "16" },
    out: { type: "string" },
    "no-video": { type: "boolean", default: false },
    blur: { type: "string", default: "1" }, // motion-blur subframes
    "audio-only": { type: "boolean", default: false }, // steps the shot at a tiny size and writes only the WAV
  },
});

const name = positionals[0];
if (!name) throw new Error("usage: node src/render.ts <shot> [options]");
const FFMPEG = process.env.FFMPEG ?? (existsSync(`${homedir()}/miniforge3/envs/videos/bin/ffmpeg`) ? `${homedir()}/miniforge3/envs/videos/bin/ffmpeg` : "ffmpeg");
const audioOnly = a["audio-only"]!;
const scale = audioOnly ? 0.05 : Number(a.scale);
const W = Math.round((Number(a.w) * scale) / 2) * 2;
const H = Math.round((Number(a.h) * scale) / 2) * 2;
const fps = Number(a.fps);
const opts: ShotOptions = { style: a.style as ShotOptions["style"], W, H };
const mod = (await import(`./shots/${name}.ts`)) as { default: (o: ShotOptions) => Shot };
const shot = mod.default(opts);
const from = a.from ? Number(a.from) : 0;
const to = a.to ? Number(a.to) : shot.duration;
const outName = a.out ?? `${name}-${a.style}`;
mkdirSync("out", { recursive: true });

const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");
const stills = (a.stills ?? "").split(",").filter(Boolean).map(Number);
const dt = 1 / fps;
const sub = Math.max(1, Number(a.blur));

let ff: ReturnType<typeof spawn> | null = null;
const video = `out/${outName}.mp4`;
if (!a["no-video"] && !audioOnly) {
  ff = spawn("nice", ["-n", "15", FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(fps), "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", a.crf!, "-pix_fmt", "yuv420p", "-threads", "4",
    "-movflags", "+faststart", video], { stdio: ["pipe", "inherit", "inherit"] });
}

const write = (buf: Uint8Array): Promise<void> =>
  new Promise((res) => (ff!.stdin!.write(buf) ? res() : ff!.stdin!.once("drain", () => res())));

// Steps the shot from 0 so stateful effects match; frames before `from` are simulated but not written.
const t0 = performance.now();
const n = Math.round(to * fps);
const acc: Float32Array | null = sub > 1 ? new Float32Array(W * H * 4) : null;
const nextStills = [...stills].sort((x, y) => x - y);
for (let i = 0; i <= n; i++) {
  const t = i * dt;
  const keep = t >= from - 1e-9;
  if (sub === 1 || !keep) {
    shot.frame(ctx, t, dt);
  } else {
    acc!.fill(0);
    for (let k = 0; k < sub; k++) {
      shot.frame(ctx, t - dt * 0.5 * (1 - (k + 0.5) / sub), dt / sub); // shutter covers half a frame
      const d = ctx.getImageData(0, 0, W, H).data;
      for (let p = 0; p < d.length; p++) acc![p]! += d[p]!;
    }
  }
  if (!keep) continue;
  const data = sub === 1 ? ctx.getImageData(0, 0, W, H).data : Uint8ClampedArray.from(acc!, (v) => v / sub);
  while (nextStills.length && nextStills[0]! <= t + 1e-9) {
    const s = nextStills.shift()!;
    if (sub > 1) ctx.putImageData(new ImageData(data, W, H), 0, 0);
    writeFileSync(`out/${outName}-t${s.toFixed(2)}.png`, canvas.toBuffer("image/png"));
  }
  if (ff) await write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}
if (ff) {
  ff.stdin!.end();
  await new Promise((res) => ff!.on("close", res));
}
// Sound: the shot mixes its cues into a WAV, muxed into the finished video.
if (ff && shot.mixAudio && from === 0) {
  const wav = `out/${outName}.wav`;
  shot.mixAudio(wav);
  const tmp = `out/${outName}.tmp.mp4`;
  await new Promise((res) => spawn("nice", ["-n", "15", FFMPEG, "-y", "-loglevel", "error", "-i", video, "-i", wav, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", tmp], { stdio: "inherit" }).on("close", res));
  renameSync(tmp, video);
}
if (audioOnly && shot.mixAudio) shot.mixAudio(`out/${outName}.wav`);
const secs = (performance.now() - t0) / 1000;
console.log(`${outName}: ${n + 1} frames ${W}x${H} in ${secs.toFixed(1)} s (${((secs * 1000) / (n + 1)).toFixed(1)} ms/frame)`);
if (ff && a.sheet) {
  const cols = 4, rows = 3, every = Math.max(0.1, (to - from) / (cols * rows));
  await new Promise((res) => spawn("nice", ["-n", "15", FFMPEG, "-y", "-loglevel", "error", "-i", video, "-vf", `fps=1/${every},scale=480:-1,tile=${cols}x${rows}`, "-frames:v", "1", `out/${outName}-sheet.png`], { stdio: "inherit" }).on("close", res));
}
