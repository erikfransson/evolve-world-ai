import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
console.log(JSON.stringify(process.argv.slice(2).map((id) => envById(id))));
