// Regenerates src/sim/wasm/kernels.generated.ts from the .wat sources: `npm run wasm`.
import { writeFileSync } from "node:fs";
import { generatedSource, watText } from "./wasmAssemble.ts";

// `--print brain` writes the expanded text of src/sim/wasm/brain.wat to stdout instead.
if (process.argv.includes("--print")) {
  const printed = process.argv[process.argv.indexOf("--print") + 1];
  if (!printed || printed.startsWith("-")) {
    console.error("usage: --print <kernel>, e.g. --print brain");
    process.exit(1);
  }
  console.log(watText(`${printed}.wat`));
  process.exit(0);
}

const out = new URL("../src/sim/wasm/kernels.generated.ts", import.meta.url);
writeFileSync(out, await generatedSource());
console.log(`wrote ${out.pathname}`);
