import type { BodyPlan } from "./sensors.ts";

// A run's records: the creatures with the longest life, most children, most food and most kills, dead ones included.
export type Board = "age" | "children" | "eaten" | "kills";
export const BOARDS: readonly Board[] = ["age", "children", "eaten", "kills"];
// A creature's value on a board; age is in seconds when dt is the tick length. Kills are hunts and lethal bumps it survived.
export const boardValue = (m: { ageTicks: number; children: number; eaten: number; kills: number; bumpKills: number }, board: Board, dt = 1): number =>
  board === "age" ? m.ageTicks * dt : board === "kills" ? m.kills + m.bumpKills : m[board];

export interface LeaderEntry {
  id: number;
  species: number;
  hue: number;
  value: number; // seconds for age, else a count
  from: number; // sim time of birth
  to: number; // sim time of death, or of the last look while alive
  alive: boolean;
  plan: BodyPlan; // its own copy
}

export interface Leaders {
  species: number;
  board: Board;
  entries: LeaderEntry[]; // best first
}

// The best few entries per species and board; memory stays at species x boards x top entries however long the run.
export class Leaderboard {
  private readonly lists = new Map<string, LeaderEntry[]>();

  private readonly top: number;

  constructor(top = 3) {
    this.top = top;
  }

  // Records a creature's value now. build runs only when the creature enters the list, so living creatures can be offered every second.
  // An id already listed is updated (values only grow while alive, and a creature is offered once more at its death).
  offer(board: Board, species: number, id: number, value: number, to: number, alive: boolean, build: () => Omit<LeaderEntry, "value" | "to" | "alive">): void {
    if (value <= 0) return;
    const key = `${species}:${board}`;
    let list = this.lists.get(key);
    if (!list) this.lists.set(key, (list = []));
    const at = list.findIndex((e) => e.id === id);
    if (at >= 0) {
      const e = list[at]!;
      e.value = value;
      e.to = to;
      e.alive = alive;
    } else if (list.length < this.top || value > list[list.length - 1]!.value) {
      list.push({ ...build(), value, to, alive });
    } else return;
    list.sort((a, b) => b.value - a.value || a.id - b.id);
    if (list.length > this.top) list.length = this.top;
  }

  // Copies of the non-empty lists, for a message.
  snapshot(): Leaders[] {
    const out: Leaders[] = [];
    for (const [key, list] of this.lists) {
      const [species, board] = key.split(":");
      if (list.length) out.push({ species: Number(species), board: board as Board, entries: list.map((e) => ({ ...e, plan: { ...e.plan, hiddenLayers: e.plan.hiddenLayers.slice() } })) });
    }
    return out;
  }
}
