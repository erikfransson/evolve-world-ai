import { MAX_FILE_BYTES, parseCreatureFile } from "../sim/rl/creatureFile.ts";
import { lineageName } from "./founders.ts";
import type { Founder } from "./founders.ts";
import { PLAN_LIMITS } from "../sim/rl/validate.ts";
import { lineageColor } from "../ui/lineagePanel.ts";
import type { BodyPlan } from "../sim/sensors.ts";
import { NAME_MAX, NAME_RE, upkeepOf } from "./add.ts";
import type { AddRequest, AddRules, Added, Birth, Refused } from "./add.ts";
import { reshapeGenome } from "./reshape.ts";
import { TRAIN_SECONDS, train } from "./training.ts";
import type { TrainJob, TrainKind, TrainProgress } from "./training.ts";

// "Add your creature": pick a founder or upload a file, tune it, optionally train it in this browser, name it and send it.
// Visitor text (names, file contents) only ever reaches the page through textContent and input values.

interface Base {
  label: string;
  plan: BodyPlan;
  genome: Float32Array;
}

interface Tuned {
  rays: number;
  spreadDeg: number;
  length: number;
  neurons: number;
  neuronsSet: boolean; // the slider was moved: every layer takes `neurons`; until then the base's own layer sizes stay
  memShort: number;
  memLong: number;
  birth: Birth;
}

const SVG = "http://www.w3.org/2000/svg";
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

// A small picture of a plan: the body and its ray fan, rays to scale with each other.
export function planGlyph(plan: Pick<BodyPlan, "rayCount" | "raySpread" | "rayLength">, hue: number, size = 56): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");
  const c = size / 2;
  const reach = (size / 2 - 3) * Math.min(1, 0.45 + plan.rayLength / 400);
  const full = plan.raySpread >= 2 * Math.PI - 1e-6;
  const gaps = full ? plan.rayCount : Math.max(1, plan.rayCount - 1);
  for (let i = 0; i < plan.rayCount; i++) {
    const a = -Math.PI / 2 + (plan.rayCount === 1 ? 0 : -plan.raySpread / 2 + (plan.raySpread * i) / gaps);
    const line = document.createElementNS(SVG, "line");
    line.setAttribute("x1", String(c));
    line.setAttribute("y1", String(c));
    line.setAttribute("x2", (c + Math.cos(a) * reach).toFixed(1));
    line.setAttribute("y2", (c + Math.sin(a) * reach).toFixed(1));
    line.setAttribute("class", "glyph-ray");
    svg.append(line);
  }
  const body = document.createElementNS(SVG, "circle");
  body.setAttribute("cx", String(c));
  body.setAttribute("cy", String(c));
  body.setAttribute("r", String(size * 0.13));
  body.setAttribute("fill", lineageColor(hue));
  body.setAttribute("class", "glyph-body");
  svg.append(body);
  return svg;
}

const deg = (r: number): number => Math.round((r * 180) / Math.PI);
const tunedOf = (plan: BodyPlan, birth: Birth): Tuned => ({ rays: plan.rayCount, spreadDeg: deg(plan.raySpread), length: Math.round(plan.rayLength), neurons: Math.max(...plan.hiddenLayers), neuronsSet: false, memShort: plan.memoryShort, memLong: plan.memoryLong, birth: { ...birth } });
const planOf = (base: BodyPlan, t: Tuned): BodyPlan => ({
  rayCount: t.rays,
  raySpread: Math.max(1, t.spreadDeg) * (Math.PI / 180),
  rayLength: t.length,
  hiddenLayers: t.neuronsSet ? base.hiddenLayers.map(() => t.neurons) : base.hiddenLayers.slice(),
  memoryShort: t.memShort,
  memoryLong: t.memLong,
});
const sameStructure = (a: BodyPlan, b: BodyPlan): boolean => a.rayCount === b.rayCount && a.memoryShort === b.memoryShort && a.memoryLong === b.memoryLong && a.hiddenLayers.join() === b.hiddenLayers.join();

interface Slider {
  input: HTMLInputElement;
  out: HTMLOutputElement;
  set(v: number): void;
}

export interface AddPanelHooks {
  send(req: AddRequest): boolean; // false when not connected
  added(reply: Added): void;
  minimised(on: boolean): void; // the panel folded to its pill, or opened again
}

export class AddPanel {
  private readonly root: HTMLElement;
  private readonly hooks: AddPanelHooks;
  private rules: AddRules | null = null;
  private founders: Founder[] = [];
  private source: "founder" | "file" = "founder";
  private founder = 0;
  private file: Base | null = null;
  private t: Tuned | null = null;
  private hue = Math.floor(Math.random() * 360);
  private copies = 1;
  private job: TrainJob | null = null;
  // The last trained brain with what it was trained from, reused when an add is refused or fails and nothing changed since.
  private trained: { from: Float32Array; plan: string; kinds: string; genome: Float32Array } | null = null;
  private waiting = false; // an add is on its way
  private lockedUntil = 0; // ms: the connection's add rate, or the server's retry time
  private lockTimer: ReturnType<typeof setInterval> | undefined;
  private readonly sliders = new Map<string, Slider>();
  private readonly $ = <T extends HTMLElement = HTMLElement>(id: string): T => this.root.querySelector<T>(`#${id}`)!;

  constructor(root: HTMLElement, hooks: AddPanelHooks) {
    this.root = root;
    this.hooks = hooks;
    this.buildTuning();
    this.$("addMin").addEventListener("click", () => this.minimise(true));
    this.$("addClose").addEventListener("click", () => this.close());
    for (const r of root.querySelectorAll<HTMLInputElement>('input[name="addSource"]')) r.addEventListener("change", () => this.setSource(r.value === "file" ? "file" : "founder"));
    this.$<HTMLInputElement>("addFile").addEventListener("change", (e) => void this.readFile((e.target as HTMLInputElement).files?.[0] ?? null));
    const name = this.$<HTMLInputElement>("addName");
    name.maxLength = NAME_MAX;
    name.addEventListener("input", () => {
      delete name.dataset.auto; // typed by the visitor: a new founder or file keeps it
      this.refresh();
    });
    const hue = this.$<HTMLInputElement>("addHue");
    hue.value = String(this.hue);
    hue.addEventListener("input", () => {
      this.hue = Number(hue.value);
      this.refresh();
    });
    for (const r of root.querySelectorAll<HTMLInputElement>('input[name="addCopies"]')) r.addEventListener("change", () => {
      this.copies = Number(r.value);
      this.refresh();
    });
    this.$("addGo").addEventListener("click", () => void this.go());
    this.$("addCancel").addEventListener("click", () => this.cancelTraining());
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.minimise(true);
    });
    this.refresh(); // sliders stay disabled until there is a plan (a founder or a file) behind them
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    this.root.classList.remove("min");
    this.hooks.minimised(false);
    this.$("addTitle").focus({ preventScroll: true });
  }

  close(): void {
    this.root.hidden = true;
    this.hooks.minimised(false);
  }

  minimise(on: boolean): void {
    this.root.hidden = on;
    this.hooks.minimised(on);
  }

  setFounders(list: Founder[]): void {
    this.founders = list;
    this.buildFounders();
    if (!this.t && list.length) this.pickFounder(0);
  }

  // From the hello: what this server allows; null switches adding off.
  setRules(rules: AddRules | null): void {
    this.rules = rules;
    if (rules) {
      const b = rules.birth;
      this.range("birthEnergy", b.energy[0], b.energy[1], 1);
      this.range("birthCost", b.cost[0], b.cost[1], 1);
      this.range("birthCooldown", b.cooldown[0], b.cooldown[1], 0.5);
      if (this.t) {
        const clampTo = (v: number, [lo, hi]: [number, number]): number => Math.min(hi, Math.max(lo, v));
        this.t.birth = { energy: clampTo(this.t.birth.energy, b.energy), cost: clampTo(this.t.birth.cost, b.cost), cooldown: clampTo(this.t.birth.cooldown, b.cooldown) };
        this.syncSliders();
      }
      for (const r of this.root.querySelectorAll<HTMLInputElement>('input[name="addCopies"]')) r.disabled = Number(r.value) > rules.maxCopies;
      if (this.copies > rules.maxCopies) {
        this.copies = 1;
        this.root.querySelector<HTMLInputElement>('input[name="addCopies"][value="1"]')!.checked = true;
      }
    }
    this.refresh();
  }

  reply(r: Added | Refused): void {
    this.waiting = false;
    if (r.t === "added") {
      this.say(`${r.name} is in the world: ${r.ids.length === 1 ? "one copy" : `${r.ids.length} copies`}.`, "ok");
      this.hooks.added(r);
    } else {
      if (r.retryS) this.lock(r.retryS);
      this.say(`Not added: ${r.reason}.`, "error");
    }
    this.refresh();
  }

  // The world went away (offline or a new world): an add in flight gets no reply.
  disconnected(): void {
    if (this.waiting) this.say("The connection dropped before the world answered. Try again when it is back.", "error");
    this.waiting = false;
    this.refresh();
  }

  private base(): Base | null {
    if (this.source === "file") return this.file;
    const f = this.founders[this.founder];
    return f ? { label: f.name, plan: f.plan, genome: f.genome } : null;
  }

  private defaultBirth(): Birth {
    const b = this.rules?.birth ?? { energy: [100, 225], cost: [50, 110], cooldown: [5, 20] };
    // The middles insertCreature gives (log scale, linear for a range from 0), on the sliders' steps.
    const mid = ([lo, hi]: [number, number]): number => (lo > 0 ? Math.sqrt(lo * hi) : (lo + hi) / 2);
    return { energy: Math.round(mid(b.energy)), cost: Math.round(mid(b.cost)), cooldown: Math.round(mid(b.cooldown) * 2) / 2 };
  }

  private pickFounder(i: number): void {
    this.founder = i;
    const f = this.founders[i];
    if (!f) return;
    // The founder's own birth traits on the sliders' steps and within this world's ranges, else the range middles, as its seeded starters have.
    const r = this.rules?.birth;
    const fit = (v: number, step: number, range: [number, number] | undefined): number => {
      const s = Math.round(v / step) * step;
      return range ? Math.min(range[1], Math.max(range[0], s)) : s; // the rules clamp again when they come
    };
    const d = this.defaultBirth();
    this.t = tunedOf(f.plan, f.birth ? { energy: fit(f.birth.energy, 1, r?.energy), cost: fit(f.birth.cost, 1, r?.cost), cooldown: fit(f.birth.cooldown ?? d.cooldown, 0.5, r?.cooldown) } : d);
    const name = this.$<HTMLInputElement>("addName");
    if (!name.value || name.dataset.auto === "1") {
      name.value = f.lineage; // the starters' own lineage name, so a copy carries the same
      name.dataset.auto = "1";
    }
    for (const b of this.root.querySelectorAll<HTMLElement>(".founder")) b.setAttribute("aria-checked", String(Number(b.dataset.index) === i));
    this.syncSliders();
    this.refresh();
  }

  private setSource(s: "founder" | "file"): void {
    this.source = s;
    this.$("addFounders").hidden = s !== "founder";
    this.$("addUpload").hidden = s !== "file";
    const b = this.base();
    if (b) this.t = tunedOf(b.plan, this.t?.birth ?? this.defaultBirth());
    this.syncSliders();
    this.refresh();
  }

  private async readFile(file: File | null): Promise<void> {
    const msg = this.$("addFileMsg");
    msg.classList.remove("error");
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return this.fileError("That file is too large for a creature file.");
    let text: string;
    try {
      text = await file.text();
    } catch {
      return this.fileError("Could not read that file.");
    }
    const parsed = parseCreatureFile(text);
    if (typeof parsed === "string") return this.fileError(`Not a creature file this world can take: ${parsed}.`);
    if (parsed.kind !== "forager") return this.fileError("That creature is a hunter or prey from the RL Arena's hunt worlds. Live World takes foragers (Ecosystem creatures).");
    this.file = { label: parsed.name, plan: parsed.plan, genome: Float32Array.from(parsed.genome) };
    msg.textContent = `${parsed.name}: ${parsed.plan.rayCount} rays, brain ${parsed.plan.hiddenLayers.join("-")}${parsed.training.iterations ? `, trained ${parsed.training.iterations} iterations` : ""}.`;
    const name = this.$<HTMLInputElement>("addName");
    if (!name.value || name.dataset.auto === "1") {
      name.value = lineageName(parsed.name);
      name.dataset.auto = "1";
    }
    this.t = tunedOf(parsed.plan, this.t?.birth ?? this.defaultBirth());
    this.syncSliders();
    this.refresh();
  }

  private fileError(text: string): void {
    this.file = null;
    const msg = this.$("addFileMsg");
    msg.textContent = text;
    msg.classList.add("error");
    this.refresh();
  }

  private buildFounders(): void {
    const box = this.$("addFounders");
    box.replaceChildren(
      ...this.founders.map((f, i) => {
        const b = el("button", "founder");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(i === this.founder));
        b.dataset.index = String(i);
        const text = el("span", "founder-text");
        text.append(el("b", "", f.name), el("span", "founder-blurb", f.blurb), el("span", "founder-facts", `${f.plan.rayCount} rays · ${deg(f.plan.raySpread)}° · brain ${f.plan.hiddenLayers.join("-")}`));
        b.append(planGlyph(f.plan, this.hue, 48), text);
        b.addEventListener("click", () => this.pickFounder(i));
        return b;
      }),
    );
  }

  private slider(box: HTMLElement, id: string, label: string, tip: string, min: number, max: number, step: number, fmt: (v: number) => string, onInput: (v: number) => void): void {
    const field = el("div", "field");
    const row = el("div", "row");
    const name = el("label", "name", label);
    name.htmlFor = `add-${id}`;
    name.title = tip;
    const out = el("output");
    row.append(name, out);
    const input = el("input");
    input.type = "range";
    input.id = `add-${id}`;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const paint = (): void => {
      const lo = Number(input.min);
      const hi = Number(input.max);
      input.style.setProperty("--p", `${hi > lo ? ((Number(input.value) - lo) / (hi - lo)) * 100 : 0}%`);
      out.textContent = fmt(Number(input.value));
    };
    input.addEventListener("input", () => {
      paint();
      onInput(Number(input.value));
      this.refresh();
    });
    field.append(row, input);
    box.append(field);
    this.sliders.set(id, {
      input,
      out,
      set: (v) => {
        input.value = String(v);
        paint();
      },
    });
  }

  private range(id: string, min: number, max: number, step: number): void {
    const s = this.sliders.get(id);
    if (!s) return;
    s.input.min = String(min);
    s.input.max = String(max);
    s.input.step = String(step);
  }

  private buildTuning(): void {
    const L = PLAN_LIMITS;
    const vision = this.$("addVision");
    const brain = this.$("addBrain");
    const birth = this.$("addBirth");
    const t = (): Tuned => this.t!;
    this.slider(vision, "rays", "Rays", "How many rays it sees with. Each costs energy by its length.", L.rayCount[0], L.rayCount[1], 1, (v) => String(v), (v) => (t().rays = v));
    this.slider(vision, "spread", "Spread", "The angle the rays fan out over.", 10, 360, 5, (v) => `${v}°`, (v) => (t().spreadDeg = v));
    this.slider(vision, "length", "Ray length", "How far it sees. Longer rays cost more energy.", L.rayLength[0], L.rayLength[1], 10, (v) => String(v), (v) => (t().length = v));
    this.slider(brain, "neurons", "Neurons per layer", "Size of each hidden layer. New neurons start silent and learn in training.", L.neurons[0], L.neurons[1], 1, (v) => String(v), (v) => {
      t().neurons = v;
      t().neuronsSet = true;
    });
    this.slider(brain, "memShort", "Short memory", "Memory units that fade fast.", L.memory[0], L.memory[1], 1, (v) => String(v), (v) => (t().memShort = v));
    this.slider(brain, "memLong", "Long memory", "Memory units that fade slowly.", L.memory[0], L.memory[1], 1, (v) => String(v), (v) => (t().memLong = v));
    this.slider(birth, "birthEnergy", "Birth at energy", "It has a child when its energy reaches this.", 100, 225, 1, (v) => String(Math.round(v)), (v) => (t().birth.energy = v));
    this.slider(birth, "birthCost", "Birth cost", "Energy it gives its child, who starts with it.", 50, 110, 1, (v) => String(Math.round(v)), (v) => (t().birth.cost = v));
    this.slider(birth, "birthCooldown", "Birth cooldown", "Seconds before it can have another child.", 5, 20, 0.5, (v) => `${v} s`, (v) => (t().birth.cooldown = v));
  }

  private syncSliders(): void {
    const t = this.t;
    if (!t) return;
    const values: Record<string, number> = { rays: t.rays, spread: t.spreadDeg, length: t.length, neurons: t.neurons, memShort: t.memShort, memLong: t.memLong, birthEnergy: t.birth.energy, birthCost: t.birth.cost, birthCooldown: t.birth.cooldown };
    for (const [id, v] of Object.entries(values)) this.sliders.get(id)?.set(v);
    const b = this.base();
    this.$("addLayers").textContent = b ? `${b.plan.hiddenLayers.length} hidden ${b.plan.hiddenLayers.length === 1 ? "layer" : "layers"}` : "";
  }

  private plan(): BodyPlan | null {
    const b = this.base();
    return b && this.t ? planOf(b.plan, this.t) : null;
  }

  private say(text: string, kind: "ok" | "error" | "" = ""): void {
    const m = this.$("addMsg");
    m.textContent = text;
    m.dataset.kind = kind;
  }

  private lock(seconds: number): void {
    this.lockedUntil = Math.max(this.lockedUntil, Date.now() + seconds * 1000);
    clearInterval(this.lockTimer);
    this.lockTimer = setInterval(() => {
      if (Date.now() >= this.lockedUntil) clearInterval(this.lockTimer);
      this.refresh();
    }, 1000);
  }

  // Readouts, the preview and the button state.
  private refresh(): void {
    const plan = this.plan();
    const costs = this.rules?.costs;
    if (plan && costs) {
      const now = upkeepOf(plan, costs);
      const b = this.base()!;
      const was = upkeepOf(b.plan, costs);
      this.$("addBurn").textContent = now.toFixed(2);
      const d = now - was;
      this.$("addBurnDelta").textContent = Math.abs(d) < 0.005 ? `same as ${b.label}` : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} vs ${b.label}`;
    } else {
      this.$("addBurn").textContent = "-";
      this.$("addBurnDelta").textContent = this.source === "file" && !this.file ? "choose a file first" : "";
    }
    const preview = this.$("addPreview");
    if (plan) preview.replaceChildren(planGlyph(plan, this.hue, 72));
    else preview.replaceChildren();
    this.$("addHueSw").style.background = lineageColor(this.hue);
    for (const g of this.root.querySelectorAll<SVGCircleElement>(".founder .glyph-body")) g.setAttribute("fill", lineageColor(this.hue));
    const name = this.$<HTMLInputElement>("addName").value;
    const nameOk = NAME_RE.test(name);
    this.$("addNameHint").textContent = name && !nameOk ? `Letters and digits only, up to ${NAME_MAX}.` : `Up to ${NAME_MAX} letters and digits, shown on its card and family.`;
    this.$("addNameHint").classList.toggle("error", !!name && !nameOk);
    const go = this.$<HTMLButtonElement>("addGo");
    const left = Math.ceil((this.lockedUntil - Date.now()) / 1000);
    const training = this.job !== null;
    go.disabled = !this.rules || !plan || !nameOk || this.waiting || training || left > 0;
    go.textContent = this.waiting ? "Adding…" : training ? "Training…" : left > 0 ? `Add again in ${left} s` : this.copies > 1 ? `Add ${this.copies} to the world` : "Add to the world";
    this.$("addOff").hidden = this.rules !== null;
    for (const s of this.sliders.values()) s.input.disabled = training || this.waiting || !plan;
  }

  private progress(p: TrainProgress | null): void {
    const box = this.$("addTrain");
    box.hidden = p === null;
    if (!p) return;
    this.$<HTMLElement>("addTrainFill").style.width = `${Math.round(p.share * 100)}%`;
    const what = p.kind === "pretrain" ? "Pretraining" : "Fine-tuning among others";
    const score = p.score !== null && p.start !== null ? ` · score ${p.start.toFixed(1)} → ${p.score.toFixed(1)}` : "";
    this.$("addTrainText").textContent = `${what} · ${Math.max(0, Math.ceil((1 - p.share) * TRAIN_SECONDS))} s left · step ${p.iter}${score}`;
  }

  private async trainAll(plan: BodyPlan, genome: Float32Array): Promise<Float32Array | null> {
    const kinds: TrainKind[] = [];
    if (this.$<HTMLInputElement>("addPretrain").checked) kinds.push("pretrain");
    if (this.$<HTMLInputElement>("addFinetune").checked) kinds.push("finetune");
    let g = genome;
    for (const kind of kinds) {
      let failed = "";
      const job = train(kind, plan, g, (p) => this.progress(p), (m) => (failed = m));
      this.job = job;
      this.refresh();
      const out = await job.done;
      const cancelled = this.job !== job; // cancelTraining let go of it
      this.job = null;
      this.progress(null);
      if (failed) this.say(`Training stopped (${failed}); adding it as it is.`, "error");
      if (cancelled) return null;
      if (out) g = out;
    }
    return g;
  }

  private async go(): Promise<void> {
    const b = this.base();
    const plan = this.plan();
    const name = this.$<HTMLInputElement>("addName").value;
    if (!b || !plan || !this.t || !NAME_RE.test(name) || this.waiting || this.job) return;
    let genome = sameStructure(b.plan, plan) ? b.genome : reshapeGenome(b.plan, b.genome, plan);
    this.say("");
    const kinds = ["addPretrain", "addFinetune"].filter((id) => this.$<HTMLInputElement>(id).checked).join();
    const key = { from: b.genome, plan: JSON.stringify(plan), kinds };
    const t = this.trained;
    if (kinds && t && t.from === key.from && t.plan === key.plan && t.kinds === key.kinds) genome = t.genome; // trained already, the add did not go in
    else {
      const trained = await this.trainAll(plan, genome);
      if (!trained) {
        this.say("Training cancelled. Nothing was added.");
        return this.refresh();
      }
      genome = trained;
      if (kinds) this.trained = { ...key, genome };
    }
    const req: AddRequest = { plan, genome, birth: { ...this.t.birth }, name, hue: this.hue, copies: this.copies };
    if (!this.hooks.send(req)) {
      this.say("Not connected to the world right now. Try again when it is back.", "error");
      return this.refresh();
    }
    this.waiting = true;
    this.lock(this.rules?.everyS ?? 10);
    this.say("Sending…");
    this.refresh();
  }

  // Cancel stops a training run; the run resolves null and go() reports it.
  cancelTraining(): void {
    const j = this.job;
    this.job = null;
    j?.cancel();
  }
}
