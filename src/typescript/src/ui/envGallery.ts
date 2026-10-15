import type { EnvSpec } from "../sim/rl/env.ts";
import { FOLDED_GROUPS } from "../sim/rl/envs.ts";
import type { Recording } from "../sim/rl/recording.ts";
import { drawArena, frameAt } from "./arenaScene.ts";
import { fitCanvas } from "./canvas.ts";
import { envFacts, galleryGroups, pickedIn } from "./envSelect.ts";

const CLIP_SPEED = 3; // clip seconds per real second

export interface GalleryHandlers {
  toggle: (id: string) => void;
  setMany: (ids: string[], on: boolean) => void;
  remove: (id: string) => void; // a custom env's delete button
}

interface Card {
  env: EnvSpec;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  rec: Recording | null;
  t0: number;
  drawn: string; // frame and size last painted, to skip identical repaints
}

interface Section {
  ids: string[];
  count: HTMLElement;
  details: HTMLDetailsElement;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};

// The environment gallery: cards grouped by category, each looping a recorded clip of its env while on screen.
export class EnvGallery {
  private cards = new Map<string, Card>();
  private clips = new Map<string, Recording>(); // by env id, kept across rebuilds
  private sections: Section[] = [];
  private visible = new Set<Element>();
  private observer: IntersectionObserver | null;
  private raf = 0;
  private playing = false;
  private reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly body = el("div", "gallery-body");
  private readonly total = el("span", "gallery-total");
  private picked: ReadonlySet<string> = new Set();
  private envs: readonly EnvSpec[] = [];
  private readonly toggle = el("button", "mini gallery-toggle");
  private compact = false;
  private expanded = false;

  private readonly root: HTMLElement;
  private readonly on: GalleryHandlers;

  constructor(root: HTMLElement, on: GalleryHandlers) {
    this.root = root;
    this.on = on;
    this.observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            for (const e of entries) {
              if (e.isIntersecting) this.visible.add(e.target);
              else this.visible.delete(e.target);
            }
          })
        : null;
    const head = el("div", "gallery-head");
    const title = el("h2", "", "Environments");
    const actions = el("div", "gallery-actions");
    const all = el("button", "mini", "Select all");
    const none = el("button", "mini", "Clear all");
    for (const b of [all, none]) b.type = "button";
    all.addEventListener("click", () => this.on.setMany(this.envs.map((e) => e.id), true));
    none.addEventListener("click", () => this.on.setMany(this.envs.map((e) => e.id), false));
    this.toggle.type = "button";
    this.toggle.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.layout();
    });
    actions.append(all, none, this.toggle);
    head.append(title, this.total, actions);
    const hint = el("p", "hint gallery-hint", "Click cards to choose. Each iteration the creature trains in all chosen environments. Small worlds learn within a few dozen iterations, bigger ones take longer.");
    this.root.append(head, hint, this.body);
  }

  // Compact while a run is on screen (paused or finished): the cards fold away behind a toggle, so the tiles stay in view.
  setCompact(on: boolean): void {
    if (on === this.compact) return;
    this.compact = on;
    this.expanded = false;
    this.layout();
  }

  private layout(): void {
    const folded = this.compact && !this.expanded;
    this.root.classList.toggle("folded", folded);
    this.toggle.hidden = !this.compact;
    this.toggle.textContent = folded ? "Change environments" : "Hide cards";
  }

  // Rebuilds the cards for a new env list; clips already recorded are reused.
  setEnvs(envs: readonly EnvSpec[], picked: ReadonlySet<string>): void {
    this.envs = envs;
    this.picked = picked;
    for (const c of this.cards.values()) this.observer?.unobserve(c.el);
    this.visible.clear();
    this.cards.clear();
    const open = new Map(this.sections.map((s) => [s.ids.join(), s.details.open]));
    this.sections = [];
    this.body.replaceChildren(
      ...galleryGroups(envs).map(({ group, envs: list }) => {
        const details = el("details", "gallery-group");
        details.open = !FOLDED_GROUPS.has(group) || list.some((e) => picked.has(e.id)) || (open.get(list.map((e) => e.id).join()) ?? false);
        const sum = el("summary");
        const name = el("span", "group-name", group);
        const count = el("span", "group-count");
        const ids = list.map((e) => e.id);
        const all = el("button", "mini", "Select all");
        const none = el("button", "mini", "Clear");
        for (const b of [all, none]) b.type = "button";
        // Buttons sit inside <summary>: stop the click from folding the group.
        all.addEventListener("click", (ev) => {
          ev.preventDefault();
          this.on.setMany(ids, true);
        });
        none.addEventListener("click", (ev) => {
          ev.preventDefault();
          this.on.setMany(ids, false);
        });
        const acts = el("span", "group-actions");
        acts.append(all, none);
        sum.append(name, count, acts);
        const grid = el("div", "gallery-grid");
        grid.append(...list.map((e) => this.card(e)));
        details.append(sum, grid);
        this.sections.push({ ids, count, details });
        return details;
      }),
    );
    this.sync(picked);
    this.layout();
  }

  private card(env: EnvSpec): HTMLElement {
    const card = el("div", "env-card");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    const canvas = el("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const frame = el("div", "env-frame");
    frame.append(canvas, el("span", "env-check"));
    const name = el("b", "", env.name);
    const desc = el("small", "", env.description);
    const chips = el("span", "chips");
    chips.append(...envFacts(env).map((f) => el("span", "", f)));
    const body = el("div", "env-card-body");
    body.append(name, desc, chips);
    card.append(frame, body);
    if (env.tags.includes("custom")) {
      const del = el("button", "env-del", "×");
      del.type = "button";
      del.title = "Remove this environment";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.on.remove(env.id);
      });
      del.addEventListener("keydown", (ev) => ev.stopPropagation());
      frame.append(del);
    }
    const flip = (): void => this.on.toggle(env.id);
    card.addEventListener("click", flip);
    card.addEventListener("keydown", (ev) => {
      if (ev.target !== card || (ev.key !== "Enter" && ev.key !== " ")) return;
      ev.preventDefault();
      flip();
    });
    const rec = this.clips.get(env.id) ?? null;
    this.cards.set(env.id, { env, el: card, canvas, rec, t0: performance.now(), drawn: "" });
    this.observer?.observe(card);
    return card;
  }

  // Updates selected states and counts after `picked` changed.
  sync(picked: ReadonlySet<string>): void {
    this.picked = picked;
    for (const c of this.cards.values()) {
      const on = picked.has(c.env.id);
      c.el.classList.toggle("selected", on);
      c.el.setAttribute("aria-pressed", String(on));
      c.el.setAttribute("aria-label", `${c.env.name}: ${c.env.description}`);
    }
    for (const s of this.sections) {
      const n = pickedIn(picked, this.envs.filter((e) => s.ids.includes(e.id)));
      s.count.textContent = `${n} / ${s.ids.length}`;
      s.count.classList.toggle("some", n > 0);
    }
    this.total.textContent = `${pickedIn(picked, this.envs)} of ${this.envs.length} chosen`;
    this.total.classList.toggle("warn", pickedIn(picked, this.envs) === 0);
  }

  setClip(id: string, rec: Recording): void {
    this.clips.set(id, rec);
    const c = this.cards.get(id);
    if (!c) return;
    c.rec = rec;
    c.t0 = performance.now();
    c.el.classList.add("has-clip");
    c.drawn = "";
    this.paint(c, 0);
  }

  // Animates visible cards while playing; a run starting stops all drawing.
  play(on: boolean): void {
    this.playing = on;
    if (on && !this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.raf = 0;
    if (!this.playing) return;
    for (const c of this.cards.values()) if (c.rec && this.visible.has(c.el)) this.paint(c, now);
    this.raf = requestAnimationFrame(this.tick);
  };

  private paint(c: Card, now: number): void {
    const rec = c.rec;
    if (!rec || c.canvas.clientWidth <= 0) return;
    const seconds = this.reduced ? rec.frames * rec.dt * 0.4 : ((now - c.t0) / 1000) * CLIP_SPEED;
    const f = frameAt(rec, seconds);
    const key = `${f}|${c.canvas.clientWidth}|${c.canvas.clientHeight}`;
    if (key === c.drawn) return;
    c.drawn = key;
    const dpr = fitCanvas(c.canvas);
    const ctx = c.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawArena(ctx, rec, f, c.canvas.clientWidth, c.canvas.clientHeight, false);
  }
}
