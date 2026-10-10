import "./base.css";
import "./style.css";
import "./ecosystem.css";
import { DEFAULT_ECO_CONFIG } from "./sim/ecoConfig.ts";
import type { EcoConfig } from "./sim/ecoConfig.ts";
import { fitCanvas } from "./ui/canvas.ts";
import { drawIdleWorld } from "./ui/ecoIdle.ts";
import { createEcoView } from "./ui/ecoPage.ts";

// Page shell only. The simulation attaches by filling in these handlers and drawing instead of drawIdleWorld.
let config: EcoConfig = DEFAULT_ECO_CONFIG;
let running = false;

function drawIdle(): void {
  if (running) return;
  const dpr = fitCanvas(view.canvas);
  drawIdleWorld(view.canvas.getContext("2d")!, config, view.canvas.width, view.canvas.height, dpr);
}

const noop = (): void => {};
const view = createEcoView({
  onStart: (c) => { config = c; running = true; },
  onPause: noop,
  onResume: noop,
  onReset: () => { running = false; config = view.readConfig(); drawIdle(); },
  onReseed: noop,
  onSpeed: noop,
  onZoom: noop,
  onFollow: noop,
  onWorldView: noop,
  onShowRays: noop,
  onConfigChange: (c) => { config = c; drawIdle(); },
});

view.fillConfig(DEFAULT_ECO_CONFIG);
new ResizeObserver(drawIdle).observe(view.canvas);
drawIdle();
