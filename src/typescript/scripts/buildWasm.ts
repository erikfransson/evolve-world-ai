// Regenerates src/sim/wasm/kernels.generated.ts from the .wat sources: `npm run wasm`.
import { writeFileSync } from "node:fs";
import { generatedSource } from "./wasmAssemble.ts";

const out = new URL("../src/sim/wasm/kernels.generated.ts", import.meta.url);
writeFileSync(out, await generatedSource());
console.log(`wrote ${out.pathname}`);
