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
  test: {
    dir: "../../tests/typescript",
    globals: true,
  },
});
