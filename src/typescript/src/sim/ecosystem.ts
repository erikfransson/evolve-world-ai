import { genomeLength, layerSizes, randomGenome, refit } from "./brain.ts";
import { itemCounts, itemsPerDensity } from "./config.ts";
import type { EngineConfig } from "./config.ts";
import { Creature, SenseBatch, senseThinkBatch } from "./creature.ts";
import { Crowd } from "./crowd.ts";
import { seasonFactor, startRng } from "./ecoConfig.ts";
import type { EcoConfig } from "./ecoConfig.ts";
import { mutate } from "./ga.ts";
import { driftBirth, driftPlan, mutateStructure, randomBirth, randomPlan, remapWeights } from "./planMutation.ts";
import type { BirthTraits } from "./planMutation.ts";
import { agingOf, collide, hurt, keepInside, settle } from "./physics.ts";
import { terrainOf } from "./terrain.ts";
import { SMALL_SORT } from "./crowd.ts";
import { WasmCrowd, jsCrowdForced } from "./wasm/crowdKernel.ts";
import { WasmMembers, jsMembersForced } from "./wasm/membersKernel.ts";
import { F } from "./wasm/resident.ts";
import type { ResidentStore } from "./wasm/resident.ts";
import { advanceBodies, prepareRows, stepResident } from "./wasm/residentStep.ts";
import type { Body } from "./physics.ts";
import type { Aging, Contact } from "./physics.ts";
import type { StatefulRng } from "./rng.ts";
import { copyPlan, inputLayout, planOf } from "./sensors.ts";
import type { BodyPlan, PlanView } from "./sensors.ts";
import { Lineages } from "./lineages.ts";
import { checkRetune } from "./retune.ts";
import type { RetunePatch, RetuneResult } from "./retune.ts";
import type { Lineage } from "./lineages.ts";
import { trialsToEcoGenome } from "./seedPool.ts";
import type { PoolEntry } from "./seedPool.ts";
import { bandHue, founderCounts, seenEnergyScale, speciesEngine, speciesList, speciesRanges } from "./species.ts";
import type { Species } from "./species.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON } from "./types.ts";
import type { CreatureState, Genome, HitKind, WorldView } from "./types.ts";
import { World } from "./world.ts";
import { SenseKernels } from "./wasm/senseKernels.ts";
import { MAX_RAYS } from "./wasm/senser.ts";
import { PLAN_LIMITS } from "./rl/validate.ts";
import type { PhaseTimer } from "./profile.ts";

export type { Lineage } from "./lineages.ts";

// An item placed as given (RL environments with a layout), instead of the scattered start items.
export interface ItemSpot {
  x: number;
  y: number;
  kind: HitKind;
}

// A founder placed as given; genome in the config's input layout for its species.
export interface CastMember {
  species: number;
  plan: PlanView;
  genome: Genome;
  x: number;
  y: number;
  heading: number;
  hue: number;
  energy?: number; // the species' start energy when left out
}

// Collision events for the page's effects, collected since the last drain and bounded: a Float32Array of EVENT_STRIDE numbers each, kind, x, y, value.
// An impact (kind 0, value = energy each lost) is reported at BIG_IMPACT or more; a death (kind 1, value = hue) from a bump or a hunt. Reporting changes no results.
export const EVENT_IMPACT = 0;
export const EVENT_DEATH = 1;
export const EVENT_STRIDE = 4;
export const EVENT_CAP = 32;
export const BIG_IMPACT = 15;

// One creature of the ecosystem with its family record. Objects are recycled after death, so hold ids, not references.
export class EcoCreature {
  id = 0;
  parentId = -1; // -1 for a founder
  depth = 0; // generations since its founder
  birthTick = 0;
  children = 0;
  eaten = 0; // food items eaten, poison not counted
  kills = 0; // prey eaten
  species = 0; // index into the config's species; children keep their parent's
  hue = 0; // degrees
  founderId = 0; // id of the founder this family descends from; a founder is its own
  lastBirthTick = -Infinity;
  // Heritable birth traits (#31): energy at which it has a child, energy it pays (the child's start energy), seconds between births.
  birth: BirthTraits = { energy: 0, cost: 0, cooldown: 0 };
  cooldownTicks = 0;
  index = 0; // position in the ecosystem's member list
  owner = 0; // helper thread that thinks for it, set by the coordinator of helper threads
  readonly creature: Creature; // state, rays, rayOffsets and brain.layerActivations() of the last tick

  constructor(creature: Creature) {
    this.creature = creature;
  }

  get ageTicks(): number {
    return this.creature.state.ticksAlive;
  }
}

// Per-creature arrays for drawing, reused and grown by Ecosystem.readCreatures; entries 0 .. count-1 are valid.
export interface CreatureFrame {
  count: number;
  ids: Int32Array;
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array;
  energy: Float32Array;
  hue: Float32Array;
  founder: Int32Array;
  species: Int32Array;
}

// Counts of one species: living, born and died since the start, and how many of the deaths were eaten by hunters.
export interface SpeciesCount {
  population: number;
  births: number;
  deaths: number;
  eaten: number;
}

// Limits of a runtime insert (insertCreature): the plan limits of a creature file (rl/validate.ts), so an uploaded creature is never bigger than one the Arena makes.
export const MAX_INSERT_RAYS = PLAN_LIMITS.rayCount[1];
export const MAX_INSERT_RAY_LENGTH = 2000;
export const MAX_INSERT_MEMORY = PLAN_LIMITS.memory[1];
export const MAX_INSERT_LAYERS = PLAN_LIMITS.layers[1];
export const MAX_INSERT_NEURONS = PLAN_LIMITS.neurons[1];
export const MAX_INSERT_ENERGY = 100000;
export const MAX_NAME_LENGTH = 24;

export interface InsertSpec {
  genome: ArrayLike<number>; // sized for plan
  plan: PlanView;
  species?: number; // default 0
  x: number;
  y: number;
  hue: number; // degrees
  name: string; // short tag of the new lineage
  heading?: number; // default 0
  energy?: number; // default the species' start energy
  birth?: Partial<BirthTraits>; // a missing trait takes the middle of the species' range (log scale, linear for a range from 0); all are clamped into the range
}
export type InsertResult = { ok: true; id: number } | { ok: false; reason: string };

// Scalars of a run for saveState (ecoState.ts).
export interface EcoCore {
  tick: number; births: number; deaths: number; foodEaten: number; poisonEaten: number; food: number; poison: number;
  rngState: number; foodDue: number; poisonDue: number; nextId: number; founders: number; poolFounders: number; itemCapacity: number;
  counts: SpeciesCount[];
}

// Everything restoreMember needs of one creature.
export interface MemberRecord {
  id: number; parentId: number; depth: number; birthTick: number; children: number; eaten: number; kills: number; species: number; hue: number;
  founderId: number; lastBirthTick: number; birthEnergy: number; birthCost: number; birthCooldown: number; cooldownTicks: number;
  x: number; y: number; heading: number; vx: number; vy: number; turnRate: number; energy: number; ticksAlive: number; cos: number; sin: number;
  plan: PlanView; genome: Float32Array; memory: ArrayLike<number>;
}

// The most food and poison items a world holds. On a map with weights each cap cell has its own limit (the density times the cell's area and
// mean weight, see MapWeights.limits), so a rich region keeps more and a bare one less; the totals are the sums of the cells.
function capsOf(config: EcoConfig, eco: Pick<EcoConfig["eco"], "foodMaxDensity" | "poisonMaxDensity">): { food: number; poison: number; limits: [Int32Array, Int32Array] | null } {
  const perDensity = itemsPerDensity(config);
  const weights = terrainOf(config).weights;
  if (!weights) return { food: Math.round(eco.foodMaxDensity * perDensity), poison: Math.round(eco.poisonMaxDensity * perDensity), limits: null };
  const food = weights.limits(0, eco.foodMaxDensity, perDensity);
  const poison = weights.limits(1, eco.poisonMaxDensity, perDensity);
  return { food: food.reduce((a, b) => a + b, 0), poison: poison.reduce((a, b) => a + b, 0), limits: [food, poison] };
}

const middle = (r: readonly number[]): number => (r[0]! > 0 ? Math.sqrt(r[0]! * r[1]!) : (r[0]! + r[1]!) / 2);

export interface EcoJournal {
  born: number[];
  died: number[];
  items: number[];
}

// All creatures in one shared world. Each tick has two phases:
// 1. sensePhase: every creature senses a snapshot (items, and creatures as gridded at the tick start) and thinks; then each
//    updates its memory and moves. Sensing and thinking write only the creature's own rays and outputs, so creature order
//    cannot matter and helper threads can run them (ecoShare.ts).
// 2. sharedPhase: eating, hunting, collisions (with optional damage), deaths, births and regrowth, serially. Eating, hunting and births
//    walk the creatures from a random start each tick, so no creature wins contested food, prey or the last free place by its list position.
// With a species list every creature belongs to one species, with that species' body, costs, births and
// diet; a hunter eats a touching creature of a species it preys on. Without one there is a single species with the shared settings.
const MAX_ROCK_TRIES = 200; // random founder spots tried before taking the nearest free one

export class Ecosystem {
  readonly config: EcoConfig;
  readonly world: WorldView;
  tick = 0;
  births = 0;
  deaths = 0;
  foodEaten = 0;
  poisonEaten = 0;
  readonly poolFounders: number; // founders taken from the seed pool, the first ones of each species in id order
  readonly founders: number; // founders are ids 0 .. founders-1, species by species
  readonly species: readonly Species[];
  food = 0;
  poison = 0;
  // Living creatures in list order; states[i] is members[i].creature.state.
  readonly members: EcoCreature[] = [];
  // Id of a creature whose rays and brain input must be current after each tick (the selected one); the WASM sense leaves everyone else's stale.
  detail: number | null = null;
  // With the journal option: changes not yet drained by a helper coordinator (ecoShare.ts). born and died hold ids, items World.log records.
  journal: EcoJournal | null;

  private readonly items: World;
  private readonly crowd: Crowd;
  private hits = new Int32Array(0); // members touching an item this tick, ascending
  private readonly batch = new SenseBatch();
  private readonly kernels: SenseKernels | null; // with eco.wasm when WebAssembly SIMD is available
  private readonly wasmCrowd: WasmCrowd | null; // the crowd grid built in WebAssembly from the rows (crowdKernel.ts), when the rows are resident
  private readonly wasmMembers: WasmMembers | null; // the settle and birth scans over the rows in WebAssembly (membersKernel.ts)
  private readonly resident: ResidentStore | null; // creature bodies as rows of the kernel memory, which the fill kernel reads
  private readonly states: CreatureState[] = [];
  private readonly rowAt: number[] = []; // with resident bodies: rowAt[i] is the f64 index of members[i]'s row, so the hot loops read the rows, not the state objects
  private slotRows = new Int32Array(64); // with resident bodies: the row addresses and member indices of bySlot, in that order (the whole sense batch, kept up to date)
  private slotSelves = new Int32Array(64);
  private readonly byId = new Map<number, EcoCreature>();
  private readonly spare: EcoCreature[][]; // per species, since a creature keeps its species' engine config
  private readonly engines: EngineConfig[]; // per species
  private readonly ranges: EcoConfig["eco"][]; // per species, for plan variation
  private readonly counts: SpeciesCount[];
  private readonly kinds: number[] = []; // kinds[i] is members[i].species
  private readonly birthEnergies: number[] = []; // birthEnergies[i] is members[i].birth.energy, so the birth scan reads no creature object
  private readonly multi: boolean; // more than one species, so rays tell species apart
  private readonly hunters: boolean; // some species eats another
  private lookups = new Int32Array(0); // the item each creature touches, by list index
  private readonly slain = new Set<CreatureState>(); // killed by a bump or a hunt this tick
  private readonly events = new Float32Array(EVENT_CAP * EVENT_STRIDE);
  private eventCount = 0;
  private readonly rng: StatefulRng;
  // Scratch of one birth, grown as plans need: the child's plan, its genome, and the parent's weights remapped to a new shape.
  private readonly childPlan: BodyPlan;
  private childGenome = new Float32Array(0);
  private remapped = new Float32Array(0);
  private foodCap: number;
  private poisonCap: number;
  private foodPerTick: number;
  private poisonPerTick: number;
  private foodDue = 0; // fractional items accumulated by regrowth
  private poisonDue = 0;
  private nextId = 0;
  private readonly spot = { x: 0, y: 0, vx: 0, vy: 0 }; // scratch of a newborn's place
  private spent = false; // a parent gave its last energy to a child this tick
  private readonly traits: BirthTraits = { energy: 0, cost: 0, cooldown: 0 }; // scratch of one birth
  readonly lineages: Lineages;
  private aging: Aging | null;
  private readonly contact: Contact = { speed: 0 };
  onDeath: ((m: EcoCreature) => void) | null = null; // called with each creature as it leaves, before its object is recycled
  private bySlot: EcoCreature[] = []; // the members in creature construction order (Creature.slot), kept up to date as they come and go
  private batchAll = false; // the batch from the last sensePhase holds every member
  profile: PhaseTimer | null = null; // per-phase CPU laps, set by ecoBench --profile

  // pool: trained founders (see seedPool.ts); without one, or at poolFraction 0, every founder is random.
  // cast: exactly these founders instead of the species' founder counts; items: exactly these start items (RL environments, see rl/env.ts).
  // restore: builds the world empty, for restoreState (ecoState.ts) to fill: no founders and no items, the founder count and item capacity of the saved run.
  constructor(
    config: EcoConfig,
    pool: readonly PoolEntry[] | null = null,
    options: { journal?: boolean; cast?: readonly CastMember[]; items?: readonly ItemSpot[]; restore?: { founders: number; poolFounders: number; itemCapacity: number }; kernels?: SenseKernels } = {},
  ) {
    const restore = options.restore;
    this.config = config;
    const { eco, dt } = config;
    const perDensity = itemsPerDensity(config);
    const layout = options.items;
    const start = layout ? { food: layout.filter((it) => it.kind === HIT_FOOD).length, poison: layout.filter((it) => it.kind === HIT_POISON).length } : itemCounts(config);
    const weights = terrainOf(config).weights;
    if (weights && !layout) {
      if (!weights.usable(0)) start.food = 0; // a kind with no weight anywhere on the map starts and grows nowhere
      if (!weights.usable(1)) start.poison = 0;
    }
    const caps = capsOf(config, eco);
    this.foodCap = caps.food;
    this.poisonCap = caps.poison;
    this.foodPerTick = eco.foodRegrow * perDensity * dt;
    this.poisonPerTick = eco.poisonRegrow * perDensity * dt;
    this.species = speciesList(config);
    this.multi = this.species.length > 1;
    this.hunters = this.species.some((sp) => sp.prey.length > 0);
    const scale = seenEnergyScale(this.species);
    this.engines = this.species.map((sp) => speciesEngine(config, sp, scale));
    this.ranges = this.species.map((sp) => speciesRanges(config, sp));
    this.counts = this.species.map(() => ({ population: 0, births: 0, deaths: 0, eaten: 0 }));
    this.spare = this.species.map(() => []);
    this.rng = startRng(config);
    this.aging = agingOf(eco, dt);
    this.items = new World(config, restore?.itemCapacity ?? Math.max(start.food, this.foodCap) + Math.max(start.poison, this.poisonCap));
    this.world = this.items;
    if (caps.limits) this.items.setCapLimits(caps.limits[0], caps.limits[1]);
    this.journal = options.journal ? { born: [], died: [], items: [] } : null;
    this.items.log = this.journal?.items ?? null;
    if (layout && !restore) layout.forEach((it, i) => this.items.setItem(i, it.x, it.y, it.kind));
    else this.items.scatter(restore ? 0 : start.food, restore ? 0 : start.poison, this.rng);
    this.food = start.food;
    this.poison = start.poison;
    const cast = options.cast;
    const counts = cast || restore ? this.species.map(() => 0) : founderCounts(this.species, eco.maxPopulation);
    const founders = cast ? cast.length : counts.reduce((a, b) => a + b, 0);
    this.crowd = new Crowd(config, founders);
    // Plans past the kernel's ray limit (a huge ray count setting or pool entry) run on the JS path.
    const maxRays = Math.max(config.creature.rayCount, ...this.ranges.map((r) => r.rayCountRange[1] ?? 0), ...(pool ?? []).map((e) => e.plan.rayCount), ...(cast ?? []).map((c) => c.plan.rayCount));
    // options.kernels: instances to reuse (RL), reset here; the caller owns them and runs one Ecosystem on them at a time.
    this.kernels = !eco.wasm ? null : options.kernels && maxRays <= MAX_RAYS ? options.kernels.reset(config) : SenseKernels.create(config, maxRays);
    this.resident = this.kernels ? this.kernels.residentStore() : null;
    if (this.resident) this.resident.species.push(...this.engines); // the configs the rows' species indices stand for
    this.wasmCrowd = this.resident ? WasmCrowd.create(this.resident, this.crowd) : null;
    this.wasmMembers = this.resident ? WasmMembers.create(this.resident) : null;
    this.childPlan = planOf(config);

    const { width, height } = config.world;
    const r = config.creature.radius;
    const seeds = pool?.length ? pool.map((e) => (config.creature.seesCreatures ? trialsToEcoGenome(e.plan, e.genome, config) : e.genome)) : [];
    const randomPlanScratch = this.childPlan;
    this.founders = restore?.founders ?? founders;
    this.lineages = new Lineages(this.founders);
    let poolFounders = 0;
    let i = 0;
    for (let sp = 0; sp < this.species.length; sp++) {
      const spec = this.species[sp]!;
      const count = counts[sp]!;
      const fromPool = seeds.length ? Math.round(Math.min(1, Math.max(0, spec.poolFraction)) * count) : 0;
      const first = fromPool ? this.rng.int(seeds.length) : 0;
      for (let k = 0; k < count; k++, i++) {
        let plan: PlanView = randomPlanScratch;
        let genome: Genome;
        if (k < fromPool) {
          // Round-robin over the pool from a random entry, each copy mutated like a child.
          const e = (first + k) % seeds.length;
          plan = pool![e]!.plan;
          genome = seeds[e]!.slice();
          mutate(genome, this.config.mutation.rate, this.config.mutation.std, this.rng);
        } else {
          if (eco.foundersVary) randomPlan(this.ranges[sp]!, this.rng, randomPlanScratch);
          genome = randomGenome(layerSizes(config, plan), this.rng);
        }
        randomBirth(this.ranges[sp]!, this.rng, this.traits);
        let x = this.rng.range(r, width - r);
        let y = this.rng.range(r, height - r);
        for (let tries = 0; !this.startOk(x, y, r); tries++) {
          if (tries >= MAX_ROCK_TRIES) {
            ({ x, y } = this.items.terrain.nearestFree(x, y, r)); // a map that leaves no room is not allowed to hang the build
            break;
          }
          x = this.rng.range(r, width - r);
          y = this.rng.range(r, height - r);
        }
        const heading = this.rng.next() * 2 * Math.PI;
        const hue = spec.hue < 0 ? this.rng.next() * 360 : bandHue(spec, spec.hue + (this.rng.next() - 0.5) * spec.hueSpread);
        this.found(i, { species: sp, plan, genome, x, y, heading, hue, energy: spec.startEnergy }, k < fromPool);
      }
      poolFounders += fromPool;
    }
    for (const c of cast ?? []) {
      randomBirth(this.ranges[c.species]!, this.rng, this.traits);
      this.found(i++, c, false);
    }
    this.poolFounders = restore?.poolFounders ?? poolFounders;
    // Poison moves only once every founder stands, and never onto one, so none ends up on a founder placed earlier.
    const reach = r + config.world.itemRadius;
    this.gridCrowd(this.states.length);
    const onFounder = (px: number, py: number): boolean => this.crowd.anyWithin(px, py, reach);
    for (const s of this.states) this.items.clearPoison(s.x, s.y, r, this.rng, onFounder);
  }

  // Makes food invisible to every creature's rays, or visible again; eating is unchanged (RL memory envs, which run with wasm off).
  // The WASM sense kernel walks its own packed item copy and would still see food, so hiding needs the JS path.
  setFoodHidden(hidden: boolean): void {
    if (hidden && this.kernels) throw new Error("hiding food needs the JS sense path (eco.wasm false)");
    this.items.foodHidden = hidden;
  }

  get population(): number {
    return this.members.length;
  }

  // True when sense and think run on the WebAssembly kernels (eco.wasm, and available here).
  get wasm(): boolean {
    return this.kernels !== null;
  }

  get extinct(): boolean {
    return this.members.length === 0;
  }

  // Living, born, died and eaten per species, in the config's order; live objects, read only.
  get speciesCounts(): readonly SpeciesCount[] {
    return this.counts;
  }

  // The living creature with this id, or undefined once it has died.
  get(id: number): EcoCreature | undefined {
    return this.byId.get(id);
  }

  step(): void {
    if (this.extinct) return;
    const prof = this.profile;
    prof?.start();
    this.prepareTick();
    prof?.lap("crowd grid");
    this.sensePhase(0, this.members.length);
    prof?.lap("sense and think, rest");
    this.finishTick();
  }

  // The rows of the members' bodies and rowAt (member index to f64 index of its row), for the helper coordinator's bulk copies; null without resident bodies.
  residentRows(): { store: ResidentStore; rowAt: readonly number[] } | null {
    return this.resident ? { store: this.resident, rowAt: this.rowAt } : null;
  }

  // Helper threads with resident bodies: the whole sense batch, as row addresses and member indices (n entries each), valid until the next spawn or removal.
  senseBatchRows(): { rows: Int32Array; selves: Int32Array; n: number } {
    return { rows: this.slotRows, selves: this.slotSelves, n: this.bySlot.length };
  }

  // Phase 1a for the resident bodies at selves, after prepareTick.
  senseRows(rows: Int32Array, selves: Int32Array, n: number): void {
    const kernels = this.kernels!;
    kernels.detail = this.detail === null ? null : (this.byId.get(this.detail)?.creature ?? null);
    prepareRows(this.resident!, rows, n, this.items.terrain);
    kernels.runRows(this.items, this.crowd, rows, selves, n, kernels.detail, this.profile);
  }

  // Phase 1b for the resident bodies at selves: memory and motion, and the item each touches into touched[self].
  advanceRows(rows: Int32Array, selves: Int32Array, n: number, touched: Int32Array): void {
    advanceBodies(this.resident!, this.kernels!.f32, rows, selves, n, this.aging, this.items, this.config.creature.radius, touched);
  }

  // Empties the journal, once a helper coordinator has published it.
  drainJournal(): void {
    const j = this.journal;
    if (j) j.born.length = j.died.length = j.items.length = 0;
  }

  // Stops recording the journal, once no helper threads read it.
  dropJournal(): void {
    this.journal = null;
    this.items.log = null;
  }

  private gridCrowd(n: number, species?: ArrayLike<number>): void {
    const wasm = this.wasmCrowd;
    if (wasm && n > SMALL_SORT && !jsCrowdForced()) wasm.rebuild(this.rowAt, n, species);
    else if (this.resident) {
      this.crowd.rebuildRows(this.resident.f64, this.rowAt, F.energy, n, species);
    } else this.crowd.rebuild(this.states, n, species);
  }

  // Grids the creatures as they stand at the tick start, for sensePhase.
  prepareTick(): void {
    if (this.states.length < 2 && this.crowd.count < 2) return; // a lone creature, or none, only sees itself in a grid of at most itself
    this.gridCrowd(this.states.length, this.multi ? this.kinds : undefined);
  }

  // Phase 1a for members start .. end-1, after prepareTick: sense and think into each creature's outputs.
  sensePhase(start: number, end: number): void {
    if (this.resident && start === 0 && end === this.members.length) {
      // Resident bodies: the batch is the maintained row list, nothing to gather per creature.
      this.batchAll = true;
      this.profile?.lap("batch build");
      const kernels = this.kernels!;
      kernels.detail = this.detail === null ? null : (this.byId.get(this.detail)?.creature ?? null);
      prepareRows(this.resident, this.slotRows, end, this.items.terrain);
      kernels.runRows(this.items, this.crowd, this.slotRows, this.slotSelves, end, kernels.detail, this.profile);
      return;
    }
    const batch = this.batch;
    batch.clear();
    if (start === 0 && end === this.members.length && this.bySlot.length === end) {
      for (const m of this.bySlot) batch.add(m.creature, m.index);
      batch.sorted = true;
    } else {
      for (let i = start; i < end; i++) batch.add(this.members[i].creature, i);
    }
    this.batchAll = start === 0 && end === this.members.length;
    this.profile?.lap("batch build");
    this.senseBatch(batch);
  }

  // Brings the detail creature's rays and brain input up to date outside a tick (display only, on the JS path): on selecting it,
  // or while paused. Rebuilds the crowd grid, which every tick does first anyway, and leaves the simulation state alone.
  refreshDetail(): void {
    const i = this.detail === null ? -1 : this.members.findIndex((m) => m.id === this.detail);
    if (i < 0) return;
    this.gridCrowd(this.states.length, this.multi ? this.kinds : undefined);
    const c = this.members[i]!.creature;
    c.sense(this.items, this.crowd, i);
    c.encode();
  }

  // Phase 1a for a batch of members, each at its list index, after prepareTick.
  senseBatch(batch: SenseBatch): void {
    if (this.kernels) this.kernels.detail = this.detail === null ? null : (this.byId.get(this.detail)?.creature ?? null);
    senseThinkBatch(this.items, this.crowd, batch, this.kernels, this.profile);
  }

  // Phase 1b for one creature: memory and motion. Returns the item it touches there (Creature.touched), for finishTick.
  advance(creature: Creature): number {
    creature.remember();
    creature.steer();
    return creature.touched(this.items);
  }

  // Phase 1b and 2, once every creature has its outputs (from sensePhase or helper threads): memory and motion, then sharedPhase.
  // With touched, helper threads already did memory and motion and looked up what each creature touches (touched[i] for members[i],
  // see Creature.touched), so only the shared phase runs.
  finishTick(touched?: Int32Array): void {
    if (!touched) {
      if (this.batchAll) {
        // The batch holds every member in creature construction order: same work, but the objects are read front to back.
        const { creatures, count } = this.batch;
        const f32 = this.kernels?.f32;
        if (this.resident) {
          stepResident(this.resident, this.kernels!.f32, this.slotRows, this.members.length, this.aging, this.items.terrain);
        } else for (let k = 0; k < count; k++) {
          const c = creatures[k]!;
          const out = c.outputArray(f32);
          c.remember(out);
          c.steer(out);
        }
      } else {
        for (const m of this.members) {
          m.creature.remember();
          m.creature.steer();
        }
      }
      this.batchAll = false;
      this.profile?.lap("memory and steer");
    }
    this.sharedPhase(touched);
  }

  // Phase 2, after every creature moved.
  private sharedPhase(touched?: Int32Array): void {
    const members = this.members;
    let n = members.length;
    // Eating and hunting move no one, so the moved positions are gridded once, here, for the item lookups (in cell order, so
    // neighbours read the same cells), hunting and collisions.
    const eco = this.config.eco;
    const gridded = (eco.collisions || this.hunters) && n > 0;
    if (gridded) {
      this.gridCrowd(n, this.kinds);
      if (!touched) {
        const crowd = this.crowd;
        touched = this.lookups = refit(this.lookups, n);
        const tables = crowd.kernel && !jsCrowdForced() ? this.kernels!.itemTables(this.items) : null;
        if (tables) crowd.kernel!.touch(tables, this.items.rows, 1 / this.items.cell, this.config.creature.radius + this.items.itemRadius, touched); // twin of touchedBatch
        else this.items.touchedBatch(crowd.xs, crowd.ys, crowd.owners, n, this.config.creature.radius, touched);
      }
    }
    let first = this.rng.int(n);
    if (touched) {
      // Only creatures touching an item can eat: list them, then walk the list from the random start, in the same order as a walk
      // over every member.
      const hits = (this.hits = refit(this.hits, n));
      let h = 0;
      let from = 0;
      for (let at = 0; at < n; at++) {
        if (touched[at]! < 0) continue;
        if (at < first) from++;
        hits[h++] = at;
      }
      for (let k = 0; k < h; k++) {
        let q = from + k;
        if (q >= h) q -= h;
        this.eatAt(hits[q]!, touched);
      }
    } else {
      for (let k = 0; k < n; k++) this.eatAt((first + k) % n);
    }

    const prof = this.profile;
    prof?.lap("eat");
    if (this.hunters) this.hunt();
    prof?.lap("hunt");
    if (eco.collisions) this.collideAll();
    prof?.lap("collisions");

    const res = this.resident;
    const scan = this.wasmMembers && !jsMembersForced() ? this.wasmMembers : null;
    if (scan) {
      // the scan counts the tick for everyone with energy left and lists the others, highest first
      const dying = scan.settle(this.rowAt, n);
      for (let k = 0; k < dying.length; k++) this.settleAt(dying[k]!);
    } else for (let i = n - 1; i >= 0; i--) {
      const state = this.states[i];
      if (res) {
        // a creature with energy left only counts the tick, on the row; settle decides the rest
        const f = res.f64;
        const j = this.rowAt[i]! + F.energy;
        if (f[j]! > 0) {
          f[j + F.ticks - F.energy] = f[j + F.ticks - F.energy]! + 1;
          continue;
        }
      }
      this.settleAt(i);
    }
    this.slain.clear();
    prof?.lap("settle and deaths");

    n = members.length;
    first = n > 0 ? this.rng.int(n) : 0;
    const birthCap = eco.maxPopulation - eco.birthReserve;
    // states[i] is members[i].creature.state and birthEnergies[i] is members[i].birth.energy: the energy test reads no creature object.
    const states = this.states;
    const thresholds = this.birthEnergies;
    if (scan) {
      // only the members with energy for a child, in the order of the walk from first; births change no one else's energy
      const ready = scan.birthCandidates(this.rowAt, n, thresholds, first);
      for (let k = 0; k < ready.length && members.length < birthCap; k++) {
        const parent = members[ready[k]!]!;
        if (this.tick - parent.lastBirthTick >= parent.cooldownTicks) this.giveBirth(parent);
      }
    } else for (let k = 0; k < n && members.length < birthCap; k++) {
      const at = (first + k) % n;
      if ((res ? res.f64[this.rowAt[at]! + F.energy]! : states[at]!.energy) < thresholds[at]!) continue;
      const parent = members[at]!;
      if (this.tick - parent.lastBirthTick >= parent.cooldownTicks) this.giveBirth(parent);
    }
    if (this.spent) {
      // Parents that gave all they had are gone.
      for (let i = members.length - 1; i >= 0; i--) if (!this.states[i].alive) this.remove(i);
      this.spent = false;
    }
    prof?.lap("births");

    this.regrow();
    prof?.lap("regrow");
    this.tick++;
  }

  // Ends member i's tick (settle), removing it when it died.
  private settleAt(i: number): void {
    const state = this.states[i]!;
    settle(state);
    if (!state.alive) {
      if (this.slain.size > 0 && this.slain.delete(state)) this.report(EVENT_DEATH, state.x, state.y, this.members[i].hue);
      this.remove(i);
    }
  }

  // Member at eats: the item looked up for it in touched, or the first it touches now.
  private eatAt(at: number, touched?: Int32Array): void {
    const m = this.members[at];
    if (!this.species[m.species]!.plants) return;
    let eaten: number;
    if (touched && (touched[at] < 0 || this.items.kinds[touched[at]] !== HIT_NONE)) {
      // Items are only removed in the eat loop, so a looked-up item still there is still the first touched, and none stays none.
      eaten = touched[at];
      if (eaten >= 0) m.creature.eatItem(this.items, eaten);
    } else eaten = m.creature.eat(this.items); // looked up item taken by an earlier creature, or no lookup
    if (eaten < 0) return;
    if (this.items.kinds[eaten] === HIT_FOOD) {
      this.food--;
      m.eaten++;
      this.foodEaten++;
    } else {
      this.poison--;
      this.poisonEaten++;
    }
    this.items.removeItem(eaten); // so no one else eats it this tick
  }

  // Each living hunter, from a random start, eats the nearest touching creature of a species it preys on, at most one per
  // tick, using the grid of the moved positions. The prey dies (removed with the other deaths) and cannot be eaten twice.
  private hunt(): void {
    const crowd = this.crowd;
    const states = this.states;
    const members = this.members;
    const n = members.length;
    const reach = 2 * this.config.creature.radius;
    const inv = 1 / crowd.cell;
    const first = n > 0 ? this.rng.int(n) : 0;
    for (let k = 0; k < n; k++) {
      const hunter = members[(first + k) % n]!;
      const sp = this.species[hunter.species]!;
      const s = states[(first + k) % n]!;
      if (sp.prey.length === 0 || s.energy <= 0) continue;
      const cx0 = Math.max(0, Math.floor((s.x - reach) * inv));
      const cx1 = Math.min(crowd.cols - 1, Math.floor((s.x + reach) * inv));
      const cy0 = Math.max(0, Math.floor((s.y - reach) * inv));
      const cy1 = Math.min(crowd.rows - 1, Math.floor((s.y + reach) * inv));
      let best = -1;
      let bestD2 = reach * reach;
      for (let cy = cy0; cy <= cy1; cy++) {
        const row = cy * crowd.cols;
        const end = crowd.cellStart[row + cx1 + 1]!;
        for (let t = crowd.cellStart[row + cx0]!; t < end; t++) {
          if (!sp.prey.includes(crowd.species[t]!)) continue;
          const o = crowd.owners[t]!;
          const p = states[o]!;
          if (!p.alive || p.energy <= 0) continue;
          const dx = p.x - s.x;
          const dy = p.y - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2 || (d2 === bestD2 && best >= 0 && members[o]!.id < members[best]!.id)) {
            best = o;
            bestD2 = d2;
          }
        }
      }
      if (best < 0) continue;
      const prey = states[best]!;
      s.energy += sp.eatEfficiency * prey.energy + sp.eatBaseline;
      prey.energy = 0;
      prey.alive = false;
      this.slain.add(prey);
      hunter.kills++;
      this.counts[members[best]!.species]!.eaten++;
    }
  }

  // Pushes overlapping pairs apart with a bounce, using a grid of the moved positions. Pairs resolve in grid order.
  // The sweep culls on the grid's sorted position arrays; only overlapping pairs touch the creature objects (bump), which write
  // their new positions back to the arrays for the pairs after them.
  // The crowd already holds the moved positions (sharedPhase rebuilds it before eating).
  private collideAll(): void {
    const crowd = this.crowd;
    const states = this.states;
    if (states.length < 2) return; // no pairs
    const { cols, rows, cellStart, xs, ys } = crowd;
    const { radius } = this.config.creature;
    const reach = 2 * radius;
    const reach2 = reach * reach;
    const kernel = crowd.kernel;
    if (kernel && !jsCrowdForced()) {
      // the same sweep in WebAssembly (crowd.wat sweep), which finds the pairs; the bumps stay here
      kernel.sweepStart(reach2);
      while (kernel.sweepNext()) this.bumpSlots(kernel.hitS, kernel.hitT, radius);
      return;
    }
    // Occupied cells in row-major order, the same order as sweeping every cell.
    for (let o = 0; o < crowd.occupiedCount; o++) {
      const c = crowd.occupied[o]!;
      const cy = Math.floor(c / cols);
      const cx = c - cy * cols;
      const end = cellStart[c + 1]!;
      const hasRight = cx + 1 < cols;
      // Later creatures of this cell and the cell to the right are one run, the cells below-left, below and below-right another,
      // so each pair is seen once.
      const run1 = hasRight ? cellStart[c + 2]! : end;
      let run2a = 0;
      let run2b = 0;
      if (cy + 1 < rows) {
        const below = c + cols;
        run2a = cellStart[cx > 0 ? below - 1 : below]!;
        run2b = cellStart[hasRight ? below + 2 : below + 1]!;
      }
      for (let s = cellStart[c]!; s < end; s++) {
        for (let t = s + 1; t < run1; t++) {
          const dx = xs[t]! - xs[s]!;
          const dy = ys[t]! - ys[s]!;
          if (!(dx * dx + dy * dy >= reach2)) this.bumpSlots(s, t, radius);
        }
        for (let t = run2a; t < run2b; t++) {
          const dx = xs[t]! - xs[s]!;
          const dy = ys[t]! - ys[s]!;
          if (!(dx * dx + dy * dy >= reach2)) this.bumpSlots(s, t, radius);
        }
      }
    }
  }

  // bump for the creatures at sorted slots s and t of the crowd, then their positions back into its arrays.
  private bumpSlots(s: number, t: number, radius: number): void {
    const { owners, xs, ys } = this.crowd;
    const a = this.states[owners[s]!]!;
    const b = this.states[owners[t]!]!;
    this.bump(a, b, radius, 1);
    xs[s] = a.x;
    ys[s] = a.y;
    xs[t] = b.x;
    ys[t] = b.y;
  }

  private bump(a: CreatureState, b: CreatureState, radius: number, e: number): void {
    const eco = this.config.eco;
    if (!a.alive || !b.alive) return; // an eaten prey; everyone else is alive until settle
    if (!collide(a, b, radius, e, this.contact)) return;
    if (eco.collisionDamage) {
      const fresh = a.energy > 0 && b.energy > 0 && this.contact.speed > 0; // else hurt does nothing
      hurt(a, b, this.contact.speed, eco.damagePerSpeed);
      if (fresh) this.noteHurt(a, b, eco.damagePerSpeed * this.contact.speed);
    }
    this.confine(a);
    this.confine(b);
  }

  // Keeps a creature inside the walls and out of the rock.
  private confine(s: Body): void {
    const { radius, wallBounce } = this.config.creature;
    const { width, height } = this.config.world;
    keepInside(s, radius, width, height, wallBounce);
    this.items.terrain.keepOut(s, radius, wallBounce);
  }

  private noteHurt(a: CreatureState, b: CreatureState, loss: number): void {
    if (loss >= BIG_IMPACT) this.report(EVENT_IMPACT, (a.x + b.x) / 2, (a.y + b.y) / 2, loss);
    if (a.energy <= 0) this.slain.add(a);
    if (b.energy <= 0) this.slain.add(b);
  }

  private report(kind: number, x: number, y: number, value: number): void {
    if (this.eventCount >= EVENT_CAP) return;
    this.events.set([kind, x, y, value], this.eventCount++ * EVENT_STRIDE);
  }

  // The events since the last call, or null for none.
  drainEvents(): Float32Array | null {
    if (this.eventCount === 0) return null;
    const out = this.events.slice(0, this.eventCount * EVENT_STRIDE);
    this.eventCount = 0;
    return out;
  }

  private giveBirth(parent: EcoCreature): void {
    const { eco, creature: cc } = this.config;
    const sp = this.species[parent.species]!;
    const ranges = this.ranges[parent.species]!;
    const ps = parent.creature.state;
    // Energy is conserved: the child starts with what the parent pays, and a cost of all its energy or more is its end.
    const paid = Math.min(parent.birth.cost, ps.energy);
    ps.energy -= paid;
    if (ps.energy <= 0) {
      ps.energy = 0;
      ps.alive = false;
      this.spent = true;
    }
    parent.lastBirthTick = this.tick;
    parent.children++;
    const pc = parent.creature;
    const plan = this.childPlan;
    copyPlan(pc.plan, plan);
    let source = pc.brain.genome;
    if (eco.planDrift > 0) driftPlan(plan, eco.planDrift, ranges, this.rng);
    if (eco.structuralRate > 0 && this.rng.next() < eco.structuralRate) {
      const maps = mutateStructure(plan, inputLayout(this.config, pc.plan), pc.brain.sizes, ranges, this.rng);
      if (maps) {
        this.remapped = refit(this.remapped, genomeLength(maps.map((m) => m.length)));
        remapWeights(pc.brain.sizes, source, maps, this.remapped, this.rng);
        source = this.remapped;
      }
    }
    const genome = (this.childGenome = refit(this.childGenome, source.length));
    genome.set(source);
    mutate(genome, this.config.mutation.rate, this.config.mutation.std, this.rng);
    const traits = this.traits;
    traits.energy = parent.birth.energy;
    traits.cost = parent.birth.cost;
    traits.cooldown = parent.birth.cooldown;
    if (eco.birthDrift > 0) driftBirth(traits, eco.birthDrift, ranges, this.rng);
    const angle = this.rng.next() * 2 * Math.PI;
    const gap = 2 * cc.radius + 1; // just clear of the parent
    // Next to the parent along the launch direction; against a wall the clamp can leave them touching, and collisions part them.
    const spot = this.spot;
    spot.x = ps.x + Math.cos(angle) * gap;
    spot.y = ps.y + Math.sin(angle) * gap;
    this.confine(spot);
    const child = this.spawn(genome, plan, spot.x, spot.y, angle, paid, parent.species);
    this.setBirth(child, traits);
    const s = child.creature.state;
    // Parent and child part at birthSpeed relative to each other, half each way, so the parent's own motion cannot carry it back
    // into the child, and the pair's momentum stays what the parent had.
    const half = eco.birthSpeed / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    s.vx = ps.vx + cos * half;
    s.vy = ps.vy + sin * half;
    ps.vx -= cos * half;
    ps.vy -= sin * half;
    this.confine(s);
    child.parentId = parent.id;
    child.founderId = parent.founderId;
    this.lineages.born(child.founderId);
    child.depth = parent.depth + 1;
    child.hue = bandHue(sp, parent.hue + this.rng.normal() * eco.hueDrift);
    this.births++;
    this.counts[parent.species]!.births++;
  }

  private setBirth(m: EcoCreature, t: BirthTraits): void {
    m.birth.energy = t.energy;
    this.birthEnergies[m.index] = t.energy;
    m.birth.cost = t.cost;
    m.birth.cooldown = t.cooldown;
    m.cooldownTicks = Math.round(t.cooldown / this.config.dt);
  }

  // Places founder i with the birth traits in this.traits; the one path for drawn and cast founders.
  private found(i: number, c: CastMember, fromPool: boolean): void {
    const m = this.spawn(c.genome, c.plan, c.x, c.y, c.heading, c.energy ?? this.species[c.species]!.startEnergy, c.species);
    this.setBirth(m, this.traits);
    m.hue = c.hue;
    this.lineages.describe(i, c.hue, c.species, fromPool);
  }

  // Adds a creature, reusing a dead one's storage when there is one; genome and plan are copied.
  private spawn(genome: Genome, plan: PlanView, x: number, y: number, heading: number, energy: number, species: number): EcoCreature {
    let m = this.spare[species]!.pop();
    if (m) m.creature.reset(genome, x, y, heading, energy, plan);
    else {
      m = new EcoCreature(new Creature(this.engines[species]!, genome, x, y, heading, plan, this.resident));
      m.creature.state.energy = energy;
    }
    if (this.resident) {
      this.kernels!.attach(m.creature);
      m.creature.resident!.species = species;
    }
    m.species = species;
    this.counts[species]!.population++;
    m.id = this.nextId++;
    m.founderId = m.id; // a child overwrites this
    m.creature.aging = this.aging;
    if (m.id < this.founders) this.lineages.found(m.id);
    m.parentId = -1;
    m.depth = 0;
    m.birthTick = this.tick;
    m.children = 0;
    m.eaten = 0;
    m.kills = 0;
    m.lastBirthTick = -Infinity;
    this.journal?.born.push(m.id);
    this.track(m);
    this.kinds.push(species);
    this.birthEnergies.push(m.birth.energy); // setBirth follows and updates it
    this.states.push(m.creature.state);
    if (this.resident) this.rowAt.push(m.creature.resident!.o);
    this.byId.set(m.id, m);
    return m;
  }

  // Adds m to the end of the member list, and to bySlot.
  private track(m: EcoCreature): void {
    m.index = this.members.length;
    this.members.push(m);
    const list = this.bySlot;
    const slot = m.creature.slot;
    const at = list.length === 0 || list[list.length - 1]!.creature.slot < slot ? list.length : this.slotPosition(slot);
    list.splice(at, 0, m);
    if (this.resident) {
      const n = list.length - 1;
      if (n === this.slotRows.length) {
        const rows = new Int32Array(2 * n);
        const selves = new Int32Array(2 * n);
        rows.set(this.slotRows);
        selves.set(this.slotSelves);
        this.slotRows = rows;
        this.slotSelves = selves;
      }
      this.slotRows.copyWithin(at + 1, at, n);
      this.slotSelves.copyWithin(at + 1, at, n);
      this.slotRows[at] = m.creature.resident!.ptr;
      this.slotSelves[at] = m.index;
    }
  }

  private untrack(m: EcoCreature): void {
    const at = this.slotPosition(m.creature.slot);
    this.bySlot.splice(at, 1);
    if (this.resident) {
      const n = this.bySlot.length;
      this.slotRows.copyWithin(at, at + 1, n + 1);
      this.slotSelves.copyWithin(at, at + 1, n + 1);
    }
  }

  // Where a creature of this slot sits (or would sit) in bySlot.
  private slotPosition(slot: number): number {
    const list = this.bySlot;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.creature.slot < slot) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Swap-removes members[i].
  private remove(i: number): void {
    const m = this.members[i];
    const last = this.members.length - 1;
    this.members[i] = this.members[last];
    this.members[i].index = i;
    this.untrack(m);
    this.states[i] = this.states[last];
    if (this.resident) {
      this.rowAt[i] = this.rowAt[last]!;
      this.rowAt.pop();
      const moved = this.members[i];
      if (moved !== m) this.slotSelves[this.slotPosition(moved.creature.slot)] = i; // the member that took m's place in the list
    }
    this.kinds[i] = this.kinds[last]!;
    this.birthEnergies[i] = this.birthEnergies[last]!;
    this.members.pop();
    this.states.pop();
    this.kinds.pop();
    this.birthEnergies.pop();
    this.byId.delete(m.id);
    this.onDeath?.(m);
    this.lineages.died(m.founderId);
    this.journal?.died.push(m.id);
    this.spare[m.species]!.push(m);
    this.deaths++;
    const count = this.counts[m.species]!;
    count.population--;
    count.deaths++;
  }

  private regrow(): void {
    this.foodDue += this.config.eco.seasons ? this.foodPerTick * seasonFactor(this.config.eco, this.tick * this.config.dt) : this.foodPerTick;
    this.poisonDue += this.poisonPerTick;
    // At the cap the rest of the due items is dropped at once, so a huge rate cannot loop; below 2^53 the leftover fraction is what counting down leaves.
    while (this.foodDue >= 1 && this.food < this.foodCap) {
      this.foodDue--;
      const grown = this.grow(HIT_FOOD);
      if (grown < 0) break; // no free slot
      this.food += grown;
    }
    this.foodDue -= Math.floor(this.foodDue);
    while (this.poisonDue >= 1 && this.poison < this.poisonCap) {
      this.poisonDue--;
      const grown = this.grow(HIT_POISON);
      if (grown < 0) break;
      this.poison += grown;
    }
    this.poisonDue -= Math.floor(this.poisonDue);
  }

  // Places one item at a random spot, spaced from poison like every placement; returns 1, 0 when the spot's cap cell was full, or -1 if no slot was free.
  private grow(kind: HitKind): number {
    const slot = this.items.addRandomly(kind, this.rng);
    return slot >= 0 ? 1 : slot === -1 ? -1 : 0;
  }

  // Whether a founder may start at (x, y): clear of rock, and on a map with weights accepted by the food weight, so founders favour the rich places.
  private startOk(x: number, y: number, r: number): boolean {
    const t = this.items.terrain;
    return !t.touchesRock(x, y, r) && (t.weights === null || t.weights.accepts(0, x, y, this.rng.next()));
  }

  // Copies every living creature into frame, growing its arrays when needed.
  readCreatures(frame?: CreatureFrame): CreatureFrame {
    const n = this.members.length;
    if (!frame || frame.ids.length < n) {
      const size = Math.max(n, 64, frame ? 2 * frame.ids.length : 0);
      frame = {
        count: 0,
        ids: new Int32Array(size),
        x: new Float32Array(size),
        y: new Float32Array(size),
        heading: new Float32Array(size),
        energy: new Float32Array(size),
        hue: new Float32Array(size),
        founder: new Int32Array(size),
        species: new Int32Array(size),
      };
    }
    for (let i = 0; i < n; i++) {
      const m = this.members[i];
      const s = this.states[i];
      frame.ids[i] = m.id;
      frame.x[i] = s.x;
      frame.y[i] = s.y;
      frame.heading[i] = s.heading;
      frame.energy[i] = s.energy;
      frame.hue[i] = m.hue;
      frame.founder[i] = m.founderId;
      frame.species[i] = m.species;
    }
    frame.count = n;
    return frame;
  }

  // --- Live world hooks (insert, save and restore, retune); step does not use them ---

  // Adds a creature of the visitor's own design at runtime, as the founder of a new lineage (its id is its founder id; name tags live on the lineage).
  // Goes through spawn like a birth, so the journal and helper threads see it; uses no random numbers, so it can be called between any two ticks.
  // Rejects, without changing anything, bad numbers, a genome that does not fit the plan, a position outside the walls and a full world.
  insertCreature(spec: InsertSpec): InsertResult {
    const bad = (reason: string): InsertResult => ({ ok: false, reason });
    const eco = this.config.eco;
    const { radius } = this.config.creature;
    const { width, height } = this.config.world;
    const sp = spec.species ?? 0;
    if (!Number.isInteger(sp) || sp < 0 || sp >= this.species.length) return bad(`species must be 0 to ${this.species.length - 1}`);
    if (this.members.length >= eco.maxPopulation) return bad("the world is full");
    const p = spec.plan;
    const finite = (...v: number[]): boolean => v.every((x) => typeof x === "number" && Number.isFinite(x));
    const whole = (x: unknown, min: number, max: number): boolean => typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
    if (!p || !whole(p.rayCount, 1, MAX_INSERT_RAYS) || !finite(p.raySpread, p.rayLength) || !(p.raySpread > 0 && p.raySpread <= 2 * Math.PI) || !(p.rayLength > 0 && p.rayLength <= MAX_INSERT_RAY_LENGTH)) return bad(`plan needs 1 to ${MAX_INSERT_RAYS} rays, a spread up to a full turn and a ray length up to ${MAX_INSERT_RAY_LENGTH}`);
    if (!whole(p.memoryShort, 0, MAX_INSERT_MEMORY) || !whole(p.memoryLong, 0, MAX_INSERT_MEMORY)) return bad(`memory units must be whole numbers 0 to ${MAX_INSERT_MEMORY}`);
    if (!Array.isArray(p.hiddenLayers) || !whole(p.hiddenLayers.length, 1, MAX_INSERT_LAYERS) || !p.hiddenLayers.every((n) => whole(n, 1, MAX_INSERT_NEURONS))) return bad(`plan needs 1 to ${MAX_INSERT_LAYERS} hidden layers of 1 to ${MAX_INSERT_NEURONS} neurons`);
    if (!finite(spec.x, spec.y) || spec.x < radius || spec.x > width - radius || spec.y < radius || spec.y > height - radius) return bad("position must be inside the walls");
    if (this.items.terrain.touchesRock(spec.x, spec.y, radius)) return bad("position must be clear of rock");
    if (!finite(spec.hue)) return bad("hue must be a finite number");
    const heading = spec.heading ?? 0;
    if (!finite(heading)) return bad("heading must be a finite number");
    const energy = spec.energy ?? this.species[sp]!.startEnergy;
    if (!finite(energy) || energy <= 0 || energy > MAX_INSERT_ENERGY) return bad(`energy must be above 0 and at most ${MAX_INSERT_ENERGY}`);
    if (typeof spec.name !== "string" || spec.name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(spec.name)) return bad(`name must be text of at most ${MAX_NAME_LENGTH} characters without control characters`);
    const ranges = this.ranges[sp]!;
    const traits = this.traits;
    traits.energy = spec.birth?.energy ?? middle(ranges.birthEnergyRange);
    traits.cost = spec.birth?.cost ?? middle(ranges.birthCostRange);
    traits.cooldown = spec.birth?.cooldown ?? middle(ranges.birthCooldownRange);
    if (!finite(traits.energy, traits.cost, traits.cooldown) || traits.energy <= 0 || traits.cost <= 0 || traits.cooldown < 0) return bad("birth energy and cost must be above 0 and the cooldown 0 or more");
    traits.energy = Math.min(ranges.birthEnergyRange[1]!, Math.max(ranges.birthEnergyRange[0]!, traits.energy));
    traits.cost = Math.min(ranges.birthCostRange[1]!, Math.max(ranges.birthCostRange[0]!, traits.cost));
    traits.cooldown = Math.min(ranges.birthCooldownRange[1]!, Math.max(ranges.birthCooldownRange[0]!, traits.cooldown));
    const need = genomeLength(layerSizes(this.engines[sp]!, p));
    const given = spec.genome?.length;
    if (given !== need) return bad(`genome has ${String(given)} numbers, the plan needs ${need}`);
    const genome = Float32Array.from(spec.genome);
    if (!genome.every(Number.isFinite)) return bad("genome must hold finite numbers");
    const m = this.spawn(genome, p, spec.x, spec.y, heading, energy, sp);
    this.setBirth(m, traits);
    m.hue = ((spec.hue % 360) + 360) % 360;
    this.lineages.describe(m.id, m.hue, sp, false, spec.name);
    this.lineages.found(m.id);
    return { ok: true, id: m.id };
  }

  // The old-age rule in force, or null; helper threads take it from the packet header.
  get agingRule(): Aging | null {
    return this.aging;
  }

  // The name tag the founder was inserted with, "" for none.
  lineageName(founder: number): string {
    return this.lineages.name(founder);
  }

  // The family table, for saveState and restoreState.
  get lineageTable(): Lineages {
    return this.lineages;
  }

  // The scalars of the run, for saveState.
  exportCore(): EcoCore {
    return {
      tick: this.tick, births: this.births, deaths: this.deaths, foodEaten: this.foodEaten, poisonEaten: this.poisonEaten,
      food: this.food, poison: this.poison, rngState: this.rng.state, foodDue: this.foodDue, poisonDue: this.poisonDue, nextId: this.nextId,
      founders: this.founders, poolFounders: this.poolFounders, itemCapacity: this.items.count, counts: this.counts.map((c) => ({ ...c })),
    };
  }

  // Sets the scalars of a saved run, for restoreState on a world built with the restore option.
  importCore(c: EcoCore): void {
    this.tick = c.tick; this.births = c.births; this.deaths = c.deaths; this.foodEaten = c.foodEaten; this.poisonEaten = c.poisonEaten;
    this.food = c.food; this.poison = c.poison; this.rng.state = c.rngState; this.foodDue = c.foodDue; this.poisonDue = c.poisonDue; this.nextId = c.nextId;
    if (c.counts.length !== this.counts.length) throw new Error("saved species counts do not fit this world");
    c.counts.forEach((x, i) => {
      const to = this.counts[i]!;
      to.population = x.population; to.births = x.births; to.deaths = x.deaths; to.eaten = x.eaten;
    });
  }

  // Appends a saved creature to the end of the member list (call in saved order), with its id and every field; the journal sees it as born.
  restoreMember(r: MemberRecord): EcoCreature {
    const m = new EcoCreature(new Creature(this.engines[r.species]!, r.genome, r.x, r.y, r.heading, r.plan, this.resident));
    const c = m.creature;
    if (this.resident) {
      this.kernels!.attach(c);
      c.resident!.species = r.species;
    }
    const s = c.state;
    s.vx = r.vx; s.vy = r.vy; s.turnRate = r.turnRate; s.energy = r.energy; s.ticksAlive = r.ticksAlive;
    c.heading.cos = r.cos; c.heading.sin = r.sin;
    c.setMemory(r.memory, 0);
    c.aging = this.aging;
    m.id = r.id; m.parentId = r.parentId; m.depth = r.depth; m.birthTick = r.birthTick; m.children = r.children; m.eaten = r.eaten; m.kills = r.kills;
    m.species = r.species; m.hue = r.hue; m.founderId = r.founderId; m.lastBirthTick = r.lastBirthTick;
    m.birth.energy = r.birthEnergy; m.birth.cost = r.birthCost; m.birth.cooldown = r.birthCooldown; m.cooldownTicks = r.cooldownTicks;
    this.journal?.born.push(m.id);
    this.track(m);
    this.kinds.push(r.species);
    this.birthEnergies.push(m.birth.energy);
    this.states.push(s);
    if (this.resident) this.rowAt.push(c.resident!.o);
    this.byId.set(m.id, m);
    return m;
  }

  // Changes settings of the running world, all or none; LIVE_FIELDS lists what is allowed. Takes effect from the next tick.
  // Changes the config object this world was built with. Helper threads follow it through the packet header.
  retune(patch: RetunePatch): RetuneResult {
    const checked = checkRetune(patch, this.config);
    if ("reason" in checked) return { ok: false, reason: checked.reason };
    const config = this.config;
    const sections = config as unknown as Record<string, Record<string, unknown>>;
    const eco = { ...config.eco } as Record<string, unknown>;
    for (const [section, key, v] of checked.fields) if (section === "eco") eco[key] = v;
    const caps = capsOf(config, eco as unknown as EcoConfig["eco"]);
    const foodCap = caps.food;
    const poisonCap = caps.poison;
    if (foodCap + poisonCap > this.items.count) return { ok: false, reason: `food and poison caps need ${foodCap + poisonCap} item slots, this world has ${this.items.count}` };
    for (const [section, key, v] of checked.fields) sections[section]![key] = Array.isArray(v) ? v.slice() : v;
    this.foodCap = foodCap;
    this.poisonCap = poisonCap;
    if (caps.limits) this.items.setCapLimits(caps.limits[0], caps.limits[1]);
    const perDensity = itemsPerDensity(config);
    this.foodPerTick = config.eco.foodRegrow * perDensity * config.dt;
    this.poisonPerTick = config.eco.poisonRegrow * perDensity * config.dt;
    this.aging = agingOf(config.eco, config.dt);
    for (const m of this.members) m.creature.aging = this.aging;
    if (checked.fields.some(([, key]) => key.startsWith("birth") && key.endsWith("Range"))) {
      const sp = this.species[0]!;
      sp.birthEnergyRange = config.eco.birthEnergyRange;
      sp.birthCostRange = config.eco.birthCostRange;
      sp.birthCooldownRange = config.eco.birthCooldownRange;
      this.ranges[0] = speciesRanges(config, sp);
    }
    return { ok: true, changed: checked.fields.map(([section, key]) => `${section}.${key}`) };
  }

  // Hash of the counts and every creature's id, position and energy; equal runs give equal fingerprints.
  fingerprint(): number {
    const P = 1_000_000_007;
    let h = (this.tick * 31 + this.births) % P;
    for (const v of [this.deaths, this.food, this.poison, this.members.length]) h = (h * 31 + v) % P;
    for (let i = 0; i < this.members.length; i++) {
      const s = this.states[i];
      h = (h * 31 + this.members[i].id) % P;
      h = (h * 31 + (Math.round(s.x * 100) % P)) % P;
      h = (h * 31 + (Math.round(s.y * 100) % P)) % P;
      h = (h * 31 + (Math.round(s.energy * 1000) % P)) % P;
    }
    return h;
  }
}
