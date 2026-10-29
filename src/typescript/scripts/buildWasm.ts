// Regenerates src/sim/wasm/kernels.generated.ts from the .wat sources: `npm run wasm`.
import { writeFileSync } from "node:fs";
import { generatedSource, watText } from "./wasmAssemble.ts";

// `--print brain` writes the expanded text of src/sim/wasm/brain.wat to stdout instead.
const printed = process.argv[process.argv.indexOf("--print") + 1];
if (process.argv.includes("--print")) {
  console.log(watText(`${printed}.wat`));
  process.exit(0);
}

const out = new URL("../src/sim/wasm/kernels.generated.ts", import.meta.url);
writeFileSync(out, await generatedSource());
console.log(`wrote ${out.pathname}`);
