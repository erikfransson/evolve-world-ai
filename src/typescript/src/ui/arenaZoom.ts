import type { TileGrid, ZoomTarget } from "./arenaTiles.ts";

// The opened-large replay of one tile: fullscreen when the browser allows it, else a fixed overlay. Esc, the backdrop and the close button close it.
export class Zoom {
  private readonly grid: TileGrid;
  private readonly root: HTMLElement;
  private readonly target: ZoomTarget;

  constructor(grid: TileGrid, root: HTMLElement, target: ZoomTarget, closeButton: HTMLElement) {
    this.grid = grid;
    this.root = root;
    this.target = target;
    closeButton.addEventListener("click", () => this.close());
    root.addEventListener("click", (ev) => {
      if (ev.target === root) this.close();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !root.hidden) this.close();
    });
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && !root.hidden) this.close(); // the browser's own Esc leaves fullscreen first
    });
  }

  open(k: number): void {
    this.root.hidden = false;
    this.grid.setZoom(k, this.target);
    this.root.requestFullscreen?.().catch(() => {}); // the fixed overlay stays when fullscreen is refused
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.grid.setZoom(null);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }
}
