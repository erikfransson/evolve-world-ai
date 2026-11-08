// Builds only the B4 harness page, with the site's public/ files (pool.json, rl/library.json, live-founders.json) beside it. Usage: vite build --config <this file> --outDir DIR
import { resolve } from "node:path";
export default {
  root: import.meta.dirname,
  base: "./",
  publicDir: resolve(import.meta.dirname, "../../../../src/typescript/public"),
  server: { fs: { allow: [resolve(import.meta.dirname, "../../../..")] } },
  build: { emptyOutDir: true, rollupOptions: { input: resolve(import.meta.dirname, "index.html") } },
};
