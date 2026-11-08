// Table of B4 results against the B1 probe: node b4-table.mjs RESULTS.jsonl B1_RUNS_DIR   (B1_RUNS_DIR holds light/ medium/ strong/ with <protocol>-s<seed>/<design>.meta.json)
import { readFileSync, existsSync } from "node:fs";
const [resFile, b1] = process.argv.slice(2);
const rows = readFileSync(resFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const PROTO = { fresh: { light: "ppo-hi", medium: "ppo-mix", strong: "ppo-mix1" }, es: { light: "current", medium: "current", strong: "current" } };
const DESIGN = { p3: "p3-mid", p6: "p6-big-brain" };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const probe = (tier, body, mode) => {
  const d = DESIGN[body];
  if (!d) return null;
  const runs = [1, 2].map((s) => `${b1}/${tier}/${PROTO[mode][tier]}-s${s}/${d}.meta.json`).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")).phases);
  return runs.length ? { iters: mean(runs.map((p) => p.reduce((a, x) => a + x.iters, 0))), eps: mean(runs.map((p) => p.reduce((a, x) => a + x.episodes, 0))) } : null;
};
const groups = new Map();
for (const r of rows) {
  const k = `${r.spec.tier}|${r.spec.body}|${r.spec.fresh ? "fresh" : "es"}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const f = (x, n = 0) => x.toFixed(n);
console.log("tier | body | mode | runs | iters (runs) | episodes | wall s | ready s | load before | probe iters | probe episodes | iters ratio | episodes ratio");
for (const tier of ["light", "medium", "strong"]) for (const [k, rs] of groups) {
  const [t, body, mode] = k.split("|");
  if (t !== tier) continue;
  const iters = rs.map((r) => r.phases.reduce((a, p) => a + p.iters, 0)), eps = rs.map((r) => r.phases.reduce((a, p) => a + p.episodes, 0));
  const p = probe(t, body, mode);
  console.log([t, body, mode, rs.length, `${f(mean(iters), 1)} (${iters.join(",")})`, f(mean(eps)), f(mean(rs.map((r) => r.wall)), 1), rs[0].phases.map((_, i) => f(mean(rs.map((r) => r.phases[i].readyAt - (i ? r.phases[i - 1].endAt : 0))), 1)).join("+"),
    rs.map((r) => f(r.load0, 1)).join(","), p ? f(p.iters, 1) : "-", p ? f(p.eps) : "-", p ? f(mean(iters) / p.iters, 2) : "-", p ? f(mean(eps) / p.eps, 2) : "-"].join(" | "));
}
console.log("cores", [...new Set(rows.map((r) => r.cores))].join(","), "chrome", rows[0].ua);
