import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// One HTML entry per page: the landing page plus a folder per mode.
const pages = ["index.html", "trials/index.html", "ecosystem/index.html", "live/index.html"];

// Relative base works on any host path (e.g. GitHub Pages project sites).
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: pages.map((p) => resolve(import.meta.dirname, p)),
    },
  },
  // Tests live outside this folder; the DOM test environment fetches them through the dev server.
  server: { fs: { allow: [".", "../../tests"] } },
  test: {
    dir: "../../tests/typescript",
    globals: true,
    testTimeout: 20_000, // the simulation tests slow down a lot under coverage or a busy machine
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // CLI scripts and worker entry stubs run as their own processes, so tests cover them by spawning (cli.test.ts), which v8 cannot see.
      exclude: ["src/headless.ts", "src/bench.ts", "src/worker/evalWorker.ts", "src/worker/evalWorkerNode.ts"],
      reporter: ["text-summary", "html", "json-summary"],
    },
  },
});
