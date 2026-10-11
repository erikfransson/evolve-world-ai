import type { EngineConfig } from "../sim/config.ts";
import { CUSTOM } from "../sim/presets.ts";
import type { PresetInfo } from "../sim/presets.ts";
import { describeSettings, withSettings } from "./scoreboard.ts";
import type { EntrySettings, Scoreboard } from "./scoreboard.ts";
import { escapeAttr } from "./page.ts";

type Creature = Pick<EngineConfig, "seed" | "creature" | "brain">;

export interface PresetPanelOptions<C extends Creature> {
  container: HTMLElement; // the settings fieldset, the card is added at its top
  form: HTMLFormElement; // gets an input event after every change so the page rebuilds its preview
  presets: readonly PresetInfo[];
  locked: readonly string[]; // ids of the form fields a preset fixes
  board: Scoreboard;
  formatScore(seconds: number): string;
  read(): C;
  fill(c: C): void;
  withPreset(c: C, id: string): C;
}

export interface PresetPanel {
  current(): string; // a preset id or CUSTOM
  select(id: string, notify?: boolean): void; // unknown ids select Custom; notify false skips the input event
  refresh(): void; // redraws the Top 3 after the board changed
}

const CUSTOM_INFO: PresetInfo = { id: CUSTOM, name: "Custom", description: "Every setting is free. No scores are kept." };
const TIP = "Fixes the world and how it renews. Creatures, brain and evolution stay yours to design. Each preset keeps its own Top 3 in this browser.";

function setLocked(id: string, on: boolean): void {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  const box = input.closest(".field, .toggle");
  box?.classList.toggle("preset-locked", on);
  input.disabled = on || (box?.classList.contains("dep-off") ?? false); // a setting switched off by its toggle stays disabled
}

export function initPresetPanel<C extends Creature>(o: PresetPanelOptions<C>): PresetPanel {
  const all = [...o.presets, CUSTOM_INFO];
  const card = document.createElement("section");
  card.className = "card presets";
  card.innerHTML =
    "<h3>Preset</h3>" +
    `<div class="field"><div class="row"><span class="lbl"><label class="name" for="preset">World</label><span class="tip" tabindex="0" role="img" aria-label="${escapeAttr(TIP)}" data-tip="${escapeAttr(TIP)}">ⓘ</span></span></div>` +
    `<select id="preset">${all.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}</select></div>` +
    '<p id="presetDesc" class="preset-desc"></p>' +
    '<div id="presetBoard" class="board"><h4>Top 3</h4><ol class="top3"></ol></div>';
  o.container.prepend(card);
  const select = card.querySelector<HTMLSelectElement>("#preset")!;
  const desc = card.querySelector<HTMLElement>("#presetDesc")!;
  const board = card.querySelector<HTMLElement>("#presetBoard")!;
  const list = board.querySelector<HTMLOListElement>("ol")!;
  let current = CUSTOM;

  const load = (s: EntrySettings): void => {
    o.fill(withSettings(o.read(), s));
    o.form.dispatchEvent(new Event("input", { bubbles: true }));
  };

  function renderBoard(): void {
    board.hidden = current === CUSTOM;
    list.replaceChildren();
    if (current === CUSTOM) return;
    const entries = o.board.top(current);
    if (entries.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No scores yet. Start a run to set one.";
      list.append(li);
      return;
    }
    entries.forEach((e, i) => {
      const text = describeSettings(e.settings);
      const li = document.createElement("li");
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.title = text;
      for (const [cls, value] of [["rank", String(i + 1)], ["score", o.formatScore(e.score)], ["date", e.date]] as const) {
        const span = document.createElement("span");
        span.className = cls;
        span.textContent = value;
        summary.append(span);
      }
      const body = document.createElement("div");
      body.className = "entry";
      const p = document.createElement("p");
      p.textContent = e.note ? `${text} · ${e.note}` : text;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mini";
      button.textContent = "Load settings";
      button.title = "Fill the creature and brain settings with these";
      button.onclick = () => load(e.settings);
      body.append(p, button);
      details.append(summary, body);
      li.append(details);
      list.append(li);
    });
  }

  const panel: PresetPanel = {
    current: () => current,
    select(id, notify = true) {
      const info = all.find((p) => p.id === id) ?? CUSTOM_INFO;
      current = info.id;
      select.value = current;
      if (current !== CUSTOM) o.fill(o.withPreset(o.read(), current));
      for (const f of o.locked) setLocked(f, current !== CUSTOM);
      desc.textContent = info.description;
      renderBoard();
      if (notify) o.form.dispatchEvent(new Event("input", { bubbles: true }));
    },
    refresh: renderBoard,
  };
  select.addEventListener("change", () => panel.select(select.value));
  return panel;
}
