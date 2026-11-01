// Work held back until the world is revealed, one task per key, the latest kept: a page that never reveals (a tab opened in the background)
// holds at most one task per key however many messages arrive, and the reveal runs each once, in the order the keys were first asked.
export class RevealGate {
  private tasks: Map<string, () => void> | null = new Map();

  get open(): boolean {
    return this.tasks === null;
  }

  // Tasks waiting, at most one per key.
  get waiting(): number {
    return this.tasks?.size ?? 0;
  }

  // Runs fn now once revealed, else keeps it as the task for key (replacing an earlier one).
  later(key: string, fn: () => void): void {
    if (this.tasks) this.tasks.set(key, fn);
    else fn();
  }

  // Reveals: runs the waiting tasks and every later one at once.
  reveal(): void {
    const tasks = this.tasks;
    this.tasks = null;
    for (const fn of tasks?.values() ?? []) fn();
  }
}
