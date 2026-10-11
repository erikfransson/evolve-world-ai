import { parseCreatureFile } from "../sim/rl/creatureFile.ts";
import type { CreatureFile } from "../sim/rl/creatureFile.ts";

// Favourite creatures kept in this browser: creature files, newest first, at most MAX_FAVOURITES.
export const FAVOURITES_KEY = "evolve-arena-favourites";
export const MAX_FAVOURITES = 20;

type Store = Pick<Storage, "getItem" | "setItem">;

const defaultStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

// The saved creatures that still pass the creature file check; unreadable storage gives an empty list.
export function loadFavourites(store: Store | null = defaultStore()): CreatureFile[] {
  try {
    const data: unknown = JSON.parse(store?.getItem(FAVOURITES_KEY) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.map((d) => parseCreatureFile(d)).filter((f): f is CreatureFile => typeof f !== "string").slice(0, MAX_FAVOURITES);
  } catch {
    return [];
  }
}

function write(list: readonly CreatureFile[], store: Store | null): boolean {
  try {
    store!.setItem(FAVOURITES_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

// Adds a creature at the front, dropping the oldest beyond the limit. False when the browser refuses to store it.
export function addFavourite(file: CreatureFile, store: Store | null = defaultStore()): boolean {
  return write([file, ...loadFavourites(store)].slice(0, MAX_FAVOURITES), store);
}

export function removeFavourite(index: number, store: Store | null = defaultStore()): boolean {
  return write(loadFavourites(store).filter((_, i) => i !== index), store);
}
