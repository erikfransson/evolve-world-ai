// @vitest-environment node
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { cleanStats } from "../../src/typescript/src/live/connection.ts";
import type { Stats } from "../../src/typescript/src/live/protocol.ts";
import { DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { smallConfig } from "./liveHelpers.ts";

// Predators hunt and every bump hurts, so both kinds of kill happen within a few hundred ticks.
function killingWorld(): { eco: Ecosystem; bumps: () => number } {
  const c = structuredClone(DEFAULT_PREDATOR_CONFIG);
  c.eco.wasm = false;
  c.eco.collisionDamage = true;
  c.seed = 3;
  const eco = new Ecosystem(c);
  let bumps = 0;
  eco.onBumpKill = () => void bumps++;
  return { eco, bumps: () => bumps };
}

const copy = (s: EcoState): EcoState => JSON.parse(JSON.stringify(s)) as EcoState;

describe("world totals: ever lived and kills", () => {
  it("counts every creature that was ever in the world: founders, births and inserts", () => {
    const { eco } = killingWorld();
    const founders = eco.population;
    expect(eco.everLived).toBe(founders);
    for (let t = 0; t < 400; t++) eco.step();
    expect(eco.births).toBeGreaterThan(0);
    expect(eco.everLived).toBe(founders + eco.births);
    const m = eco.members[0]!;
    const res = eco.insertCreature({ genome: m.creature.brain.genome, plan: m.creature.plan, x: m.creature.state.x, y: m.creature.state.y, heading: 0, species: m.species, hue: 0, name: "Test" });
    expect(res.ok).toBe(true);
    expect(eco.everLived).toBe(founders + eco.births + 1);
    expect(eco.everLived).toBe(eco.population + eco.deaths);
  });

  it("counts hunts and lethal bumps with one survivor, the dead's included", () => {
    const { eco, bumps } = killingWorld();
    for (let t = 0; t < 600; t++) eco.step();
    const hunts = eco.speciesCounts.reduce((k, c) => k + c.eaten, 0);
    expect(hunts).toBeGreaterThan(0);
    expect(bumps()).toBeGreaterThan(0);
    expect(eco.kills).toBe(hunts + bumps());
    expect(eco.bumpKills).toBeGreaterThan(eco.members.reduce((k, m) => k + m.bumpKills, 0)); // some killers have died since
  });

  it("keeps both totals through a save, and an older save without the field starts from the living creatures' bump kills", () => {
    const { eco } = killingWorld();
    for (let t = 0; t < 600; t++) eco.step();
    const state = saveState(eco);
    expect(state.core.bumpKills).toBe(eco.bumpKills);
    const back = restoreState(copy(state));
    expect({ lived: back.everLived, kills: back.kills }).toEqual({ lived: eco.everLived, kills: eco.kills });
    const old = copy(state);
    delete old.core.bumpKills;
    const living = eco.members.reduce((k, m) => k + m.bumpKills, 0);
    const fromOld = restoreState(old);
    expect(fromOld.bumpKills).toBe(living);
    expect(fromOld.kills).toBe(eco.kills - eco.bumpKills + living); // hunts were always saved, per species
    expect(fromOld.everLived).toBe(eco.everLived); // the next id was always saved
    for (let t = 0; t < 50; t++) {
      eco.step();
      fromOld.step();
    }
    expect(fromOld.fingerprint()).toBe(eco.fingerprint()); // the counters change nothing in the run
  });

  it("refuses a saved total that is not a whole count", () => {
    const { eco } = killingWorld();
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, "3", null]) {
      const s = copy(saveState(eco));
      (s.core as unknown as Record<string, unknown>).bumpKills = bad;
      expect(() => restoreState(s)).toThrow(/bumpKills/);
    }
  });

  it("refuses species counts that are not whole counts, so a corrupt save cannot blow up the kills total", () => {
    const { eco } = killingWorld();
    for (let t = 0; t < 100; t++) eco.step();
    const bads: [string, unknown][] = [["eaten", "x".repeat(1000)], ["eaten", -5], ["eaten", 1.5], ["eaten", { n: 1 }], ["eaten", 1e308], ["births", -1], ["deaths", "7"]];
    for (const [k, bad] of bads) {
      const s = copy(saveState(eco));
      (s.core.counts[1] as unknown as Record<string, unknown>)[k] = bad;
      expect(() => restoreState(s), `${k} = ${String(bad).slice(0, 20)}`).toThrow(new RegExp(`species ${k}`));
    }
    const s = copy(saveState(eco));
    (s.core.counts as unknown[])[0] = null;
    expect(() => restoreState(s)).toThrow(/species count/);
    expect(restoreState(copy(saveState(eco))).kills).toBe(eco.kills); // a good save still restores
  });

  it("sends them in the stats, and the page bounds them and keeps them absent from an older server", () => {
    const live = new LiveWorld(smallConfig(), null);
    for (let t = 0; t < 200; t++) live.eco.step();
    const s = live.stats(1);
    expect({ lived: s.lived, kills: s.kills }).toEqual({ lived: live.eco.everLived, kills: live.eco.kills });
    expect(s.lived).toBeGreaterThanOrEqual(s.population);
    const clean = cleanStats(JSON.parse(JSON.stringify(s)) as Stats);
    expect({ lived: clean.lived, kills: clean.kills }).toEqual({ lived: s.lived, kills: s.kills });
    const hostile = cleanStats({ ...s, lived: -5, kills: 1e300 } as Stats);
    expect({ lived: hostile.lived, kills: hostile.kills }).toEqual({ lived: 0, kills: 1e9 });
    expect(cleanStats({ ...s, lived: "x", kills: NaN } as unknown as Stats)).toMatchObject({ lived: 0, kills: 0 });
    const older = cleanStats({ ...s, lived: undefined, kills: undefined });
    expect("lived" in older || "kills" in older).toBe(false);
  });
});
