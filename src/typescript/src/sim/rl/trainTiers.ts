// Training tiers for the Live page's "Add your creature" (data only: no imports, so the Live page bundle stays small).
// A tier runs its phases in order on the Arena worker; phase k gets share[k] of the tier's TOTAL seconds, passes its best genome on, and
// keeps the best brain seen on the held-out layouts (live/training.ts does the keeping). Env ids are those of envs.ts.
// Chosen in docs/rl-notes/t10-b1-tiers.md: PPO (method "backprop") on the Arena's recommended mix beats today's ES protocol at every budget.

export interface TrainPhase {
  envs: readonly string[]; // repeated ids weight an env (episodes go round the list)
  share: number; // of the tier's seconds, the shares of a tier add to 1
  seconds?: number; // cap on each env's episode length (copies of the longer envs); left out: the env's own
  method: "es" | "backprop";
  es?: { pairs: number; sigma: number; lr: number; decay: number; episodes: number }; // method "es"
  backprop?: { lr: number; episodes: number }; // method "backprop": the Arena's PPO form fields
}

export interface TrainTier {
  id: "light" | "medium" | "strong";
  label: string;
  seconds: number; // TOTAL visible-tab time of the tier (today's 30 s is per kind, so 60 s in all)
  phases: readonly TrainPhase[];
}

// The Arena's RECOMMENDED_MIX (a test keeps the two equal).
const MIX = ["nibble", "live-now", "far-food", "live-patch", "minefield", "live-famine", "stings", "live-now"] as const;

export const TRAIN_TIERS: readonly TrainTier[] = [
  { id: "light", label: "Light", seconds: 30, phases: [{ envs: MIX, share: 1, seconds: 30, method: "backprop", backprop: { lr: 0.01, episodes: 16 } }] },
  { id: "medium", label: "Medium", seconds: 75, phases: [{ envs: MIX, share: 1, method: "backprop", backprop: { lr: 0.003, episodes: 16 } }] },
  { id: "strong", label: "Strong", seconds: 200, phases: [{ envs: MIX, share: 1, method: "backprop", backprop: { lr: 0.001, episodes: 16 } }] },
];
