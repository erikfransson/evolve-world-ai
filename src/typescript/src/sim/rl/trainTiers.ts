// Training tiers for the Live page's "Add your creature" (data only: no imports, so the Live page bundle stays small).
// A tier runs its phases in order on the Arena worker; phase k gets share[k] of the tier's TOTAL seconds, passes its best genome on, and
// keeps the best brain seen on the held-out layouts (live/training.ts does the keeping). Env ids are those of envs.ts.
// Light caps episodes at 20 s (docs/rl-notes/t10-b6-light.md: shorter episodes buy more updates in 30 s).
// Chosen in docs/rl-notes/t10-b1-tiers.md: PPO (method "backprop") on the Arena's recommended mix beats today's ES protocol at every budget.
// TRAIN_TIERS_TRAINED is for a start that is trained already (a founder or an upload), chosen in docs/rl-notes/t10-b2-trained-starts.md.

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
  rescore?: number; // after the phases: the start and the kept brain on this many held-out seeds per env of the last phase's envs; the start stays unless the kept brain scores higher
}

// The Arena's RECOMMENDED_MIX (a test keeps the two equal).
const MIX = ["nibble", "live-now", "far-food", "live-patch", "minefield", "live-famine", "stings", "live-now"] as const;

export const TRAIN_TIERS: readonly TrainTier[] = [
  { id: "light", label: "Light", seconds: 30, phases: [{ envs: MIX, share: 1, seconds: 20, method: "backprop", backprop: { lr: 0.01, episodes: 16 } }] },
  { id: "medium", label: "Medium", seconds: 75, phases: [{ envs: MIX, share: 1, method: "backprop", backprop: { lr: 0.003, episodes: 16 } }] },
  { id: "strong", label: "Strong", seconds: 200, phases: [{ envs: MIX, share: 1, method: "backprop", backprop: { lr: 0.001, episodes: 16 } }] },
];

// A trained start (founder or upload): PPO at the worker's lowest lr on the same mix at every tier, then a re-score on 32 held-out seeds
// that keeps the start unless the trained brain wins (the 4-seed keep-best during training passes noise). Today's ES protocol lowered food
// and survival of trained starts at every tier, and without the re-score PPO lowered the founders Juggernaut and Oracle a little.
const TRAINED = [{ envs: MIX, share: 1, method: "backprop", backprop: { lr: 0.0005, episodes: 16 } }] as const;
export const TRAIN_TIERS_TRAINED: readonly TrainTier[] = [
  { id: "light", label: "Light", seconds: 30, phases: TRAINED, rescore: 32 },
  { id: "medium", label: "Medium", seconds: 75, phases: TRAINED, rescore: 32 },
  { id: "strong", label: "Strong", seconds: 200, phases: TRAINED, rescore: 32 },
];
