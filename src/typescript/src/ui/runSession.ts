import { CUSTOM } from "../sim/presets.ts";
import type { PresetInfo } from "../sim/presets.ts";
import { initPresetPanel } from "./presetPanel.ts";
import type { PresetPanel } from "./presetPanel.ts";
import { Scoreboard, settingsOf, today } from "./scoreboard.ts";
import { initSettingsIO, serialise } from "./settingsIO.ts";
import type { ConfigOf, Mode, SettingsIO } from "./settingsIO.ts";

export interface RunSessionOptions<M extends Mode> {
  mode: M;
  container: HTMLElement; // the settings fieldset
  form: HTMLFormElement;
  presets: readonly PresetInfo[];
  locked: readonly string[];
  formatScore(seconds: number): string;
  read(): ConfigOf[M];
  fill(c: ConfigOf[M]): void;
  withPreset(c: ConfigOf[M], id: string): ConfigOf[M];
}

export interface RunSession<M extends Mode> {
  presets: PresetPanel;
  begin(config?: ConfigOf[M]): void; // a run starts: remembers its preset, settings and a key of its own
  record(seconds: number, note?: string): void; // its score so far goes on the preset's Top 3 when it is among the best
}

// What Trials and the Ecosystem pages share: the Preset card with its Top 3, Copy and Paste, and the scoring of a run.
export function initRunSession<M extends Mode>(o: RunSessionOptions<M>): RunSession<M> {
  const board = new Scoreboard(o.mode);
  let io: SettingsIO | null = null;
  const presets = initPresetPanel({ ...o, board, apply: (text) => io?.apply(text) });
  io = initSettingsIO({ mode: o.mode, form: o.form, read: o.read, fill: o.fill, preset: { get: presets.current, set: presets.select } });
  let run = { preset: CUSTOM, key: "", date: "", config: "", settings: settingsOf(o.read()) };
  return {
    presets,
    begin(config = o.read()) {
      const preset = presets.current();
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      run = { preset, key, date: today(), config: serialise(o.mode, config, preset), settings: settingsOf(config) };
    },
    record(seconds, note) {
      if (run.preset === CUSTOM || seconds <= 0) return; // Custom runs keep no score
      if (board.submit(run.preset, { run: run.key, score: seconds, date: run.date, settings: run.settings, config: run.config, note })) presets.refresh();
    },
  };
}

export interface RunControls {
  start: HTMLButtonElement;
  pause: HTMLButtonElement;
  reset: HTMLButtonElement;
  settings: HTMLFieldSetElement;
  form: HTMLFormElement;
}

// Buttons and the settings lock for a run that is idle, running or paused. `canPause` is false once the run has ended.
export function renderRunControls(c: RunControls, phase: "idle" | "running" | "paused", canPause = true): void {
  const idle = phase === "idle";
  c.start.disabled = !idle;
  c.pause.disabled = idle || !canPause;
  c.pause.textContent = phase === "paused" ? "Resume" : "Pause";
  c.reset.disabled = idle;
  c.settings.disabled = !idle;
  c.form.classList.toggle("locked", !idle);
}
