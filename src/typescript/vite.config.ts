import { defineConfig } from "vitest/config";

// Relative base works on any host path (e.g. GitHub Pages project sites).
export default defineConfig({
  base: "./",
  test: {
    dir: "../../tests/typescript",
    globals: true,
  },
});
