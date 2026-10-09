import { defineConfig } from "vite";

// Source lives in src/ to keep the repo root clean; relative base works on any host path.
export default defineConfig({
  root: "src",
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true },
});
