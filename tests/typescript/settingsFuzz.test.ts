// @vitest-environment happy-dom
import { pageBody } from "./pageLoader.ts";
import { testRng } from "./helpers.ts";
import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { buildForm } from "../../src/typescript/src/ui/settingsForm.ts";
import type { FormHandle } from "../../src/typescript/src/ui/settingsForm.ts";
import { ECO_FORM } from "../../src/typescript/src/ui/ecoSettingsForm.ts";
import { PREDATOR_FORM } from "../../src/typescript/src/ui/predatorForm.ts";
import { TRIALS_FORM } from "../../src/typescript/src/ui/trialsForm.ts";
import { initSettingsIO, parseWithPreset, serialise } from "../../src/typescript/src/ui/settingsIO.ts";
import type { Mode } from "../../src/typescript/src/ui/settingsIO.ts";
import { Scoreboard } from "../../src/typescript/src/ui/scoreboard.ts";

// Hostile pasted settings: random mutations of a valid settings file must parse to a finite config or fail with a readable Error.
const rng = testRng(20260611);
const pick = <T>(a: readonly T[]): T => a[rng.int(a.length)]!;

const HOSTILE: unknown[] = [
  null, "", "abc", "NaN", "1e999", "-1e999", "x".repeat(100_000), true, false, 0, -0, -1, 1e308, -1e308, 1e-320, 2 ** 53, 0.5,
  [], [[]], [null], [1, 2, 3], ["a", "b"], {}, { a: 1 }, JSON.parse('{"__proto__":{"polluted":1}}') as unknown, JSON.parse('{"constructor":{"prototype":{"polluted":1}}}') as unknown,
];
const KEYS = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "polluted", "", "eco", "world", "species", "config", "x".repeat(5000)];

type Node = Record<string, unknown> | unknown[];
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null;

// Paths to every value (objects and arrays included) of a JSON tree.
function paths(v: unknown, at: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  out.push(at);
  if (isNode(v)) for (const k of Object.keys(v)) paths((v as any)[k], [...at, k], out);
  return out;
}

function deepNest(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = i % 2 ? [v] : { a: v };
  return v;
}

function mutate(base: unknown): unknown {
  const doc = structuredClone(base) as Record<string, unknown>;
  for (let n = 1 + rng.int(3); n > 0; n--) {
    const at = pick(paths(doc).filter((p) => p.length > 0));
    const parent = at.slice(0, -1).reduce<any>((v, k) => v[k], doc);
    const key = at[at.length - 1]!;
    const how = rng.int(5);
    if (how === 0) delete parent[key];
    else if (how === 1) parent[key] = structuredClone(pick(HOSTILE));
    else if (how === 2) parent[key] = deepNest(5 + rng.int(200));
    else if (how === 3) {
      const target = isNode(parent[key]) ? parent[key] : parent;
      Object.defineProperty(target, pick(KEYS), { value: structuredClone(pick(HOSTILE)), enumerable: true, writable: true, configurable: true }); // an extra key, possibly a prototype key
    } else if (typeof parent[key] === "number") parent[key] = pick([NaN, Infinity, -Infinity, -parent[key], parent[key] * 1e6, 0]); // JSON.stringify turns the first three into null
    else parent[key] = rng.next() < 0.5 ? [parent[key]] : { value: parent[key] };
  }
  return doc;
}

// Raw text mutations that JSON.stringify cannot produce.
function corrupt(text: string): string {
  switch (rng.int(4)) {
    case 0: { // one random number of the text becomes a literal JSON.parse reads as Infinity or rejects
      const found = [...text.matchAll(/\d+(\.\d+)?/g)];
      const at = pick(found);
      return text.slice(0, at.index) + pick(["1e999", "-1e999", "NaN", "0x10", "-", "1e", ".5."]) + text.slice(at.index + at[0].length);
    }
    case 1: return text.slice(0, rng.int(text.length));
    case 2: return text.replace(/"config"|"normal"/, '"__proto__":{"polluted":1},$&');
    default: return text.replace(/"(\w+)":/, '"$1":"$1":');
  }
}

function finiteDeep(v: unknown, where = ""): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? null : `${where} = ${v}`;
  if (isNode(v)) for (const [k, x] of Object.entries(v)) { const bad = finiteDeep(x, `${where}.${k}`); if (bad) return bad; }
  return null;
}

const DEFAULTS = { trials: DEFAULT_CONFIG, ecosystem: DEFAULT_ECO_CONFIG, predators: DEFAULT_PREDATOR_CONFIG };
const FORMS = { trials: TRIALS_FORM, ecosystem: ECO_FORM, predators: PREDATOR_FORM };
const ROUNDS = 400;

function checkPrototype(): void {
  expect(({} as any).polluted).toBeUndefined();
  expect(Object.keys(Object.prototype)).toEqual([]);
  expect(Object.keys(Array.prototype)).toEqual([]);
}

describe.each(["trials", "ecosystem", "predators"] as Mode[])("hostile pasted settings (%s)", (mode) => {
  let form: FormHandle<any>;
  let apply: (t: string) => void;
  beforeAll(() => {
    document.body.innerHTML = pageBody(mode);
    form = buildForm(document.getElementById("settings")!, FORMS[mode] as any);
    form.fill(DEFAULTS[mode]);
    apply = initSettingsIO({ mode, form: document.getElementById("setup") as HTMLFormElement, read: form.read, fill: form.fill }).apply;
  });

  it("parses to a finite config of the default's shape, or throws a readable Error", () => {
    const valid = JSON.parse(serialise(mode, DEFAULTS[mode], "custom"));
    let accepted = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const text = i % 4 === 3 ? corrupt(JSON.stringify(valid)) : JSON.stringify(mutate(valid));
      try {
        const { config } = parseWithPreset(text, mode);
        accepted++;
        expect(finiteDeep(config), text.slice(0, 300)).toBeNull();
        expect(Object.keys(config).sort()).toEqual(Object.keys(DEFAULTS[mode]).sort());
        expect(Object.hasOwn(config, "polluted")).toBe(false);
      } catch (e) {
        expect(e, text.slice(0, 300)).toBeInstanceOf(Error);
        expect((e as Error).message.length).toBeGreaterThan(0);
        expect((e as Error).name, `${(e as Error).message} for ${text.slice(0, 300)}`).toBe("Error"); // not a TypeError or RangeError from the parser's internals
      }
    }
    expect(accepted).toBeGreaterThan(20); // the fuzz must also reach the accepting path
    checkPrototype();
  });

  it("leaves the form holding a finite config inside its slider ranges after any paste", () => {
    const valid = JSON.parse(serialise(mode, DEFAULTS[mode]));
    for (let i = 0; i < 60; i++) {
      apply(JSON.stringify(mutate(valid)));
      expect(finiteDeep(form.read()), "form value").toBeNull();
      for (const r of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
        expect(r.valueAsNumber, r.id).toBeGreaterThanOrEqual(Number(r.min));
        expect(r.valueAsNumber, r.id).toBeLessThanOrEqual(Number(r.max));
      }
      document.getElementById("ioClose")?.click();
    }
    checkPrototype();
  });
});

describe("hostile saved Top-3 entries", () => {
  const entry = { run: "r", score: 12, date: "2026-01-01", settings: { seed: 1, rays: 8, spread: 125, length: 150, hidden: [6], memory: 0.25 } };
  const store = (text: string | null) => ({ getItem: () => text, setItem: () => { throw new Error("quota"); } });

  it("loads only valid entries from any localStorage content without throwing", () => {
    const valid = { normal: [entry, entry, entry, entry] };
    for (let i = 0; i < 300; i++) {
      const doc = i % 3 === 0 ? corrupt(JSON.stringify(valid)) : JSON.stringify(mutate(valid));
      const board = new Scoreboard("trials", store(doc));
      for (const id of ["normal", "__proto__", "constructor", "polluted"]) {
        const top = board.top(id);
        expect(top.length).toBeLessThanOrEqual(3);
        for (const e of top) {
          expect(Number.isFinite(e.score)).toBe(true);
          expect(e.settings.hidden.every(Number.isFinite)).toBe(true);
        }
      }
      expect(() => board.submit("normal", { ...entry, run: "new", score: 99 })).not.toThrow(); // a failing setItem keeps the in-memory board
    }
    for (const text of ["", "null", "[]", "5", '"s"', "{", "undefined"]) expect(new Scoreboard("trials", store(text)).top("normal")).toEqual([]);
    expect(new Scoreboard("trials", { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined }).top("normal")).toEqual([]);
    checkPrototype();
  });
});
