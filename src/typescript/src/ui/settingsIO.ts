import { DEFAULT_CONFIG, overrideConfig } from "../sim/config.ts";
import type { DeepPartial, SimConfig } from "../sim/config.ts";
import { DEFAULT_ECO_CONFIG } from "../sim/ecoConfig.ts";
import type { EcoConfig } from "../sim/ecoConfig.ts";

// Copy and paste of the settings as JSON, shared by Trials and Ecosystem.
export type Mode = "trials" | "ecosystem";
interface ConfigOf {
  trials: SimConfig;
  ecosystem: EcoConfig;
}
const DEFAULTS: { [M in Mode]: ConfigOf[M] } = { trials: DEFAULT_CONFIG, ecosystem: DEFAULT_ECO_CONFIG };
const PAGE: Record<Mode, string> = { trials: "Trials", ecosystem: "Ecosystem" };
export const VERSION = 1;

// {"mode": ..., "version": 1, "angles": "radians", "config": <full config>}
export function serialise<M extends Mode>(mode: M, config: ConfigOf[M]): string {
  return JSON.stringify({ mode, version: VERSION, angles: "radians", config }, null, 2);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Returns the pasted config merged over the defaults. Throws an Error with a readable message on anything wrong.
export function parseSettings<M extends Mode>(text: string, mode: M): ConfigOf[M] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!isObject(data)) throw new Error("Expected a JSON object with mode, version and config.");
  for (const key of Object.keys(data)) {
    if (!["mode", "version", "angles", "config"].includes(key)) throw new Error(`Unknown key "${key}" at the top level.`);
  }
  if (data.mode !== "trials" && data.mode !== "ecosystem") throw new Error('Missing "mode", expected "trials" or "ecosystem".');
  if (data.mode !== mode) throw new Error(`These settings are for ${PAGE[data.mode]}, but this is the ${PAGE[mode]} page.`);
  if (data.version !== VERSION) throw new Error(`Unsupported version ${JSON.stringify(data.version)}, expected ${VERSION}.`);
  if (data.angles !== undefined && data.angles !== "radians") throw new Error('Angles must be in "radians".');
  if (data.config === undefined) return structuredClone(DEFAULTS[mode]);
  return overrideConfig<ConfigOf[M]>(DEFAULTS[mode], data.config as DeepPartial<ConfigOf[M]>);
}

// Leaf paths where a and b differ, e.g. "world.width". Angles may differ by the form's whole-degree rounding.
export function differences(a: unknown, b: unknown, path = ""): string[] {
  if (isObject(a) && isObject(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => differences(a[k], b[k], path ? `${path}.${k}` : k));
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= (path === "creature.raySpread" ? 0.009 : 1e-9) ? [] : [path];
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
}

const get = (o: unknown, path: string): string => JSON.stringify(path.split(".").reduce<unknown>((v, k) => (isObject(v) ? v[k] : undefined), o));

// What the form made of the pasted config, as a note for the dialog. Null when nothing changed.
export function adjustmentNote(pasted: unknown, applied: unknown): string | null {
  const paths = differences(pasted, applied);
  if (paths.length === 0) return null;
  return `Adjusted to what the form allows: ${paths.map((p) => `${p} ${get(pasted, p)} → ${get(applied, p)}`).join(", ")}.`;
}

// ---- DOM wiring

export interface IOOptions<M extends Mode> {
  mode: M;
  form: HTMLFormElement;
  read(): ConfigOf[M];
  fill(config: ConfigOf[M]): void;
}

// The outcome of applying text: an error, or applied with an optional note about adjusted values.
type Outcome = { ok: false; message: string } | { ok: true; message: string | null };

function clampRanges(): void {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    const v = r.valueAsNumber;
    if (Number.isFinite(v)) r.value = String(Math.min(Number(r.max), Math.max(Number(r.min), v)));
  }
}

interface Dialog {
  paste(text: string, outcome?: Outcome): void;
  copy(text: string): void;
  textArea(): HTMLTextAreaElement;
}

function buildDialog(applyText: (text: string) => Outcome): Dialog {
  const scrim = document.createElement("div");
  scrim.className = "io-scrim";
  scrim.hidden = true;
  scrim.innerHTML =
    '<div class="io-dialog" role="dialog" aria-modal="true" aria-labelledby="ioTitle">' +
    '<h2 id="ioTitle"></h2><p id="ioHelp"></p>' +
    '<textarea id="ioText" spellcheck="false" aria-labelledby="ioTitle" aria-describedby="ioHelp"></textarea>' +
    '<p id="ioMsg" class="io-msg" role="alert" hidden></p>' +
    '<div class="io-actions"><button id="ioApply" class="primary" type="button">Apply</button><button id="ioClose" class="secondary" type="button">Cancel</button></div></div>';
  document.body.append(scrim);
  const q = <T extends HTMLElement>(id: string): T => scrim.querySelector<T>(`#${id}`)!;
  const title = q("ioTitle");
  const help = q("ioHelp");
  const text = q<HTMLTextAreaElement>("ioText");
  const msg = q("ioMsg");
  const apply = q<HTMLButtonElement>("ioApply");
  const close = q<HTMLButtonElement>("ioClose");
  let returnFocus: HTMLElement | null = null;

  const say = (m: string | null, error: boolean): void => {
    msg.hidden = m === null;
    msg.textContent = m ?? "";
    msg.classList.toggle("error", error);
  };
  const hide = (): void => {
    scrim.hidden = true;
    returnFocus?.focus();
    returnFocus = null;
  };
  // Settings were applied and carry a note: keep the dialog to show it.
  const showDone = (note: string): void => {
    title.textContent = "Settings applied";
    say(note, false);
    apply.hidden = true;
    text.readOnly = true;
    close.textContent = "Close";
    close.focus();
  };
  const show = (heading: string, helpText: string, value: string, editable: boolean): void => {
    returnFocus ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    title.textContent = heading;
    help.textContent = helpText;
    text.value = value;
    text.readOnly = !editable;
    apply.hidden = !editable;
    close.textContent = editable ? "Cancel" : "Close";
    say(null, false);
    scrim.hidden = false;
    text.focus();
  };

  close.onclick = hide;
  apply.onclick = () => {
    const outcome = applyText(text.value);
    if (!outcome.ok) say(outcome.message, true);
    else if (outcome.message === null) hide();
    else showDone(outcome.message);
  };
  scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) hide(); });
  scrim.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      hide();
    } else if (e.key === "Tab") {
      const items = [...scrim.querySelectorAll<HTMLElement>("textarea, button")].filter((x) => !x.hidden);
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  return {
    paste(value, outcome) {
      show("Paste settings", "Paste settings JSON copied from Trials or Ecosystem. Missing values keep their defaults.", value, true);
      if (outcome && !outcome.ok) say(outcome.message, true);
      else if (outcome?.message) showDone(outcome.message);
    },
    copy(value) {
      show("Copy settings", "Copying to the clipboard failed. Select the text and copy it yourself.", value, false);
      text.select();
    },
    textArea: () => text,
  };
}

// Adds the Copy and Paste buttons to the settings header and the paste shortcut. Paste is off while the form is locked.
export function initSettingsIO<M extends Mode>(o: IOOptions<M>): void {
  const io = document.createElement("div");
  io.className = "io";
  io.innerHTML =
    '<button id="copySettings" class="mini" type="button" title="Copy the settings as JSON" aria-live="polite"><span aria-hidden="true">⧉</span> <span class="mini-text">Copy</span></button>' +
    '<button id="pasteSettings" class="mini" type="button" title="Paste settings from JSON"><span aria-hidden="true">⎘</span> <span class="mini-text">Paste</span></button>';
  o.form.querySelector(".group-head h2")!.after(io);
  const copy = io.querySelector<HTMLButtonElement>("#copySettings")!;
  const paste = io.querySelector<HTMLButtonElement>("#pasteSettings")!;
  const copyLabel = copy.querySelector(".mini-text")!;
  const locked = (): boolean => o.form.classList.contains("locked");

  const applyText = (text: string): Outcome => {
    if (locked()) return { ok: false, message: "Settings are locked while a run is active." };
    let pasted: ConfigOf[M];
    try {
      pasted = parseSettings(text, o.mode);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    o.fill(pasted);
    clampRanges();
    const applied = o.read();
    o.fill(applied);
    o.form.dispatchEvent(new Event("input", { bubbles: true })); // the page's change handler rebuilds its preview
    return { ok: true, message: adjustmentNote(pasted, applied) };
  };
  const dialog = buildDialog(applyText);

  const syncLock = (): void => { paste.disabled = locked(); };
  new MutationObserver(syncLock).observe(o.form, { attributes: true, attributeFilter: ["class"] });
  syncLock();

  let timer = 0;
  copy.onclick = () => {
    const text = serialise(o.mode, o.read());
    const done = (): void => {
      copyLabel.textContent = "Copied";
      clearTimeout(timer);
      timer = window.setTimeout(() => { copyLabel.textContent = "Copy"; }, 1500);
    };
    const clip = navigator.clipboard as Clipboard | undefined;
    if (!clip) dialog.copy(text);
    else clip.writeText(text).then(done, () => dialog.copy(text));
  };

  paste.onclick = () => {
    dialog.paste("");
    const clip = navigator.clipboard as Clipboard | undefined;
    clip?.readText?.().then((t) => {
      const box = dialog.textArea();
      if (box.value === "" && !box.readOnly) { box.value = t; box.select(); }
    }, () => undefined);
  };

  // Shortcut: pasting JSON anywhere outside a field applies it, and a failure or a note opens the dialog.
  document.addEventListener("paste", (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.closest("input, textarea, select") || t.isContentEditable)) return;
    const text = e.clipboardData?.getData("text") ?? "";
    if (!text.trimStart().startsWith("{") || locked()) return;
    e.preventDefault();
    const outcome = applyText(text);
    if (!outcome.ok || outcome.message !== null) dialog.paste(text, outcome);
  });
}
