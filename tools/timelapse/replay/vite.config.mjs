// Vite config of the replay page (build-replay.sh): its own root, the Live page's modules imported from src/typescript.
const root = import.meta.dirname;
export default { root, base: "./", publicDir: false, logLevel: "warn", build: { outDir: `${root}/../replay-page`, emptyOutDir: true, chunkSizeWarningLimit: 4096 } };
