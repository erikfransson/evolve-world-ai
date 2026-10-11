import { genomeLength, layerSizes, randomGenome, refit } from "./brain.ts";
import { itemCounts, itemsPerDensity } from "./config.ts";
import { Creature } from "./creature.ts";
import { Crowd } from "./crowd.ts";
import type { EcoConfig } from "./ecoConfig.ts";
import { mutate } from "./ga.ts";
import { driftPlan, mutateStructure, randomPlan, remapWeights } from "./planMutation.ts";
import { collide, keepInside, settle } from "./physics.ts";
import { createRng, deriveSeed } from "./rng.ts";
import type { StatefulRng } from "./rng.ts";
import { copyPlan, inputLayout, planOf } from "./sensors.ts";
import type { BodyPlan, PlanView } from "./sensors.ts";
import { trialsToEcoGenome } from "./seedPool.ts";
import type { PoolEntry } from "./seedPool.ts";
import { HIT_FOOD, HIT_POISON } from "./types.ts";
import type { CreatureState, Genome, HitKind, WorldView } from "./types.ts";
import { World } from "./world.ts";

// One creature of the ecosystem with its family record. Objects are recycled after death, so hold ids, not references.
export class EcoCreature {
  id = 0;
  parentId = -1; // -1 for a founder
  depth = 0; // generations since its founder
  birthTick = 0;
  children = 0;
  eaten = 0; // food items eaten, poison not counted
  hue = 0; // degrees
  lastBirthTick = -Infinity;
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
}

// All creatures in one shared world. Each tick has two phases:
// 1. sensePhase: every creature senses a snapshot (items, and creatures as gridded at the tick start), thinks and moves.
//    It touches only its own creature, so creature order cannot matter and the phase can be split across workers.
// 2. sharedPhase: eating, collisions, deaths, births and regrowth, serially. Eating and births walk the creatures
//    from a random start each tick, so no creature wins contested food or the last free place by its list position.
export class Ecosystem {
  readonly config: EcoConfig;
  readonly world: WorldView;
  tick = 0;
  births = 0;
  deaths = 0;
  readonly poolFounders: number; // founders taken from the seed pool, the first ones in id order
  food = 0;
  poison = 0;
  // Living creatures in list order; states[i] is members[i].creature.state.
  readonly members: EcoCreature[] = [];

  private readonly items: World;
  private readonly crowd: Crowd;
  private readonly states: CreatureState[] = [];
  private readonly byId = new Map<number, EcoCreature>();
  private readonly spare: EcoCreature[] = [];
  private readonly rng: StatefulRng;
  // Scratch of one birth, grown as plans need: the child's plan, its genome, and the parent's weights remapped to a new shape.
  private readonly childPlan: BodyPlan;
  private childGenome = new Float32Array(0);
  private remapped = new Float32Array(0);
  private readonly mutation: { mutationRate: number; mutationStd: number };
  private readonly cooldownTicks: number;
  private readonly foodCap: number;
  private readonly poisonCap: number;
  private readonly foodPerTick: number;
  private readonly poisonPerTick: number;
  private foodDue = 0; // fractional items accumulated by regrowth
  private poisonDue = 0;
  private nextId = 0;

  // pool: trained founders (see seedPool.ts); without one, or at poolFraction 0, every founder is random.
  constructor(config: EcoConfig, pool: readonly PoolEntry[] | null = null) {
    this.config = config;
    const { eco, dt } = config;
    const perDensity = itemsPerDensity(config);
    const start = itemCounts(config);
    this.foodCap = Math.round(eco.foodMaxDensity * perDensity);
    this.poisonCap = Math.round(eco.poisonMaxDensity * perDensity);
    this.foodPerTick = eco.foodRegrow * perDensity * dt;
    this.poisonPerTick = eco.poisonRegrow * perDensity * dt;
    this.cooldownTicks = Math.round(eco.birthCooldown / dt);
    this.rng = createRng(deriveSeed(config.seed, 0xec0));
    this.items = new World(config, Math.max(start.food, this.foodCap) + Math.max(start.poison, this.poisonCap));
    this.world = this.items;
    this.items.scatter(start.food, start.poison, this.rng);
    this.food = start.food;
    this.poison = start.poison;
    this.crowd = new Crowd(config, Math.min(eco.initialPopulation, eco.maxPopulation));
    this.childPlan = planOf(config);
    this.mutation = { mutationRate: config.mutation.rate, mutationStd: config.mutation.std };

    const { width, height } = config.world;
    const r = config.creature.radius;
    const founders = Math.max(0, Math.min(eco.initialPopulation, eco.maxPopulation));
    const seeds = pool?.length ? pool.map((e) => (config.creature.seesCreatures ? trialsToEcoGenome(e.plan, e.genome) : e.genome)) : [];
    this.poolFounders = seeds.length ? Math.round(Math.min(1, Math.max(0, eco.poolFraction)) * founders) : 0;
    const first = this.poolFounders ? this.rng.int(seeds.length) : 0;
    const randomPlanScratch = this.childPlan;
    for (let i = 0; i < founders; i++) {
      let plan: PlanView = randomPlanScratch;
      let genome: Genome;
      if (i < this.poolFounders) {
        // Round-robin over the pool from a random entry, each copy mutated like a child.
        const k = (first + i) % seeds.length;
        plan = pool![k]!.plan;
        genome = seeds[k]!.slice();
        mutate(genome, this.mutation, this.rng);
      } else {
        if (eco.foundersVary) randomPlan(eco, this.rng, randomPlanScratch);
        genome = randomGenome(layerSizes(config, plan), this.rng);
      }
      const x = this.rng.range(r, width - r);
      const y = this.rng.range(r, height - r);
      this.items.clearPoison(x, y, r, this.rng);
      const m = this.spawn(genome, plan, x, y, this.rng.next() * 2 * Math.PI, config.creature.startEnergy);
      m.hue = this.rng.next() * 360;
    }
  }

  get population(): number {
    return this.members.length;
  }

  get extinct(): boolean {
    return this.members.length === 0;
  }

  // The living creature with this id, or undefined once it has died.
  get(id: number): EcoCreature | undefined {
    return this.byId.get(id);
  }

  step(): void {
    if (this.extinct) return;
    this.crowd.rebuild(this.states, this.states.length);
    this.sensePhase(0, this.members.length);
    this.sharedPhase();
  }

  // Phase 1 for members start .. end-1; needs the crowd built at the tick start.
  sensePhase(start: number, end: number): void {
    for (let i = start; i < end; i++) {
      const c = this.members[i].creature;
      c.sense(this.items, this.crowd, i);
      c.think();
      c.steer();
    }
  }

  // Phase 2, after sensePhase has run for every creature.
  sharedPhase(): void {
    const members = this.members;
    let n = members.length;
    let first = this.rng.int(n);
    for (let k = 0; k < n; k++) {
      const m = members[(first + k) % n];
      const eaten = m.creature.eat(this.items);
      if (eaten < 0) continue;
      if (this.items.kinds[eaten] === HIT_FOOD) {
        this.food--;
        m.eaten++;
      } else this.poison--;
      this.items.removeItem(eaten); // so no one else eats it this tick
    }

    if (this.config.eco.collisions) this.collideAll();

    for (let i = n - 1; i >= 0; i--) {
      settle(this.states[i]);
      if (!this.states[i].alive) this.remove(i);
    }

    n = members.length;
    first = n > 0 ? this.rng.int(n) : 0;
    const eco = this.config.eco;
    for (let k = 0; k < n && members.length < eco.maxPopulation; k++) {
      const parent = members[(first + k) % n];
      const energy = parent.creature.state.energy;
      // Above birthCost too, so a birth never kills the parent whatever the settings.
      if (energy >= eco.birthEnergy && energy > eco.birthCost && this.tick - parent.lastBirthTick >= this.cooldownTicks) this.giveBirth(parent);
    }

    this.regrow();
    this.tick++;
  }

  // Pushes overlapping pairs apart with a bounce, using a grid of the moved positions. Pairs resolve in grid order.
  private collideAll(): void {
    const crowd = this.crowd;
    const states = this.states;
    crowd.rebuild(states, states.length);
    const { cols, rows, cellStart, owners } = crowd;
    const { radius } = this.config.creature;
    const { width, height } = this.config.world;
    const e = 1; // restitution
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const c = cy * cols + cx;
        const end = cellStart[c + 1];
        for (let s = cellStart[c]; s < end; s++) {
          const a = states[owners[s]];
          // Later creatures of this cell, then the cells right, below-left, below and below-right, so each pair is seen once.
          for (let t = s + 1; t < end; t++) this.bump(a, states[owners[t]], radius, e, width, height);
          if (cx + 1 < cols) this.bumpCell(a, c + 1, radius, e, width, height);
          if (cy + 1 < rows) {
            const below = c + cols;
            if (cx > 0) this.bumpCell(a, below - 1, radius, e, width, height);
            this.bumpCell(a, below, radius, e, width, height);
            if (cx + 1 < cols) this.bumpCell(a, below + 1, radius, e, width, height);
          }
        }
      }
    }
  }

  private bumpCell(a: CreatureState, cell: number, radius: number, e: number, width: number, height: number): void {
    const { cellStart, owners } = this.crowd;
    for (let t = cellStart[cell]; t < cellStart[cell + 1]; t++) this.bump(a, this.states[owners[t]], radius, e, width, height);
  }

  private bump(a: CreatureState, b: CreatureState, radius: number, e: number, width: number, height: number): void {
    if (!collide(a, b, radius, e)) return;
    keepInside(a, radius, width, height, this.config.creature.wallBounce);
    keepInside(b, radius, width, height, this.config.creature.wallBounce);
  }

  private giveBirth(parent: EcoCreature): void {
    const { eco, creature: cc, world: w } = this.config;
    const ps = parent.creature.state;
    ps.energy -= eco.birthCost;
    parent.lastBirthTick = this.tick;
    parent.children++;
    const pc = parent.creature;
    const plan = this.childPlan;
    copyPlan(pc.plan, plan);
    let source = pc.brain.genome;
    if (eco.planDrift > 0) driftPlan(plan, eco.planDrift, eco, this.rng);
    if (eco.structuralRate > 0 && this.rng.next() < eco.structuralRate) {
      const maps = mutateStructure(plan, inputLayout(this.config, pc.plan), pc.brain.sizes, eco, this.rng);
      if (maps) {
        this.remapped = refit(this.remapped, genomeLength(maps.map((m) => m.length)));
        remapWeights(pc.brain.sizes, source, maps, this.remapped, this.rng);
        source = this.remapped;
      }
    }
    const genome = (this.childGenome = refit(this.childGenome, source.length));
    genome.set(source);
    mutate(genome, this.mutation, this.rng);
    const angle = this.rng.next() * 2 * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const gap = 2 * cc.radius + 1; // just clear of the parent
    const child = this.spawn(genome, plan, ps.x + cos * gap, ps.y + sin * gap, angle, eco.childEnergy);
    const s = child.creature.state;
    s.vx = cos * eco.birthSpeed;
    s.vy = sin * eco.birthSpeed;
    keepInside(s, cc.radius, w.width, w.height, cc.wallBounce);
    child.parentId = parent.id;
    child.depth = parent.depth + 1;
    child.hue = (((parent.hue + this.rng.normal() * eco.hueDrift) % 360) + 360) % 360;
    this.births++;
  }

  // Adds a creature, reusing a dead one's storage when there is one; genome and plan are copied, except a founder's genome for a new creature.
  private spawn(genome: Genome, plan: PlanView, x: number, y: number, heading: number, energy: number): EcoCreature {
    let m = this.spare.pop();
    if (m) m.creature.reset(genome, x, y, heading, energy, plan);
    else {
      m = new EcoCreature(new Creature(this.config, genome === this.childGenome ? genome.slice() : genome, x, y, heading, plan));
      m.creature.state.energy = energy;
    }
    m.id = this.nextId++;
    m.parentId = -1;
    m.depth = 0;
    m.birthTick = this.tick;
    m.children = 0;
    m.eaten = 0;
    m.lastBirthTick = -Infinity;
    this.members.push(m);
    this.states.push(m.creature.state);
    this.byId.set(m.id, m);
    return m;
  }

  // Swap-removes members[i].
  private remove(i: number): void {
    const m = this.members[i];
    const last = this.members.length - 1;
    this.members[i] = this.members[last];
    this.states[i] = this.states[last];
    this.members.pop();
    this.states.pop();
    this.byId.delete(m.id);
    this.spare.push(m);
    this.deaths++;
  }

  private regrow(): void {
    this.foodDue += this.foodPerTick;
    this.poisonDue += this.poisonPerTick;
    for (; this.foodDue >= 1; this.foodDue--) if (this.food < this.foodCap) this.food += this.grow(HIT_FOOD);
    for (; this.poisonDue >= 1; this.poisonDue--) if (this.poison < this.poisonCap) this.poison += this.grow(HIT_POISON);
  }

  // Places one item at a uniform random position; returns 1, or 0 if no slot was free.
  private grow(kind: HitKind): number {
    const r = this.config.world.itemRadius;
    const { width, height } = this.config.world;
    return this.items.addItem(this.rng.range(r, width - r), this.rng.range(r, height - r), kind) >= 0 ? 1 : 0;
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
    }
    frame.count = n;
    return frame;
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
