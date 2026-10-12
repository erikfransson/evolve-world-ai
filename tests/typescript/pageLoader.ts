import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ecoBody } from "../../src/typescript/src/ui/ecoMarkup.ts";
import { ECOSYSTEM_PAGE } from "../../src/typescript/src/ui/ecoModes.ts";

const GENERATED = { ecosystem: ECOSYSTEM_PAGE };

// Body markup of a mode page (`<name>/index.html`) without scripts or stylesheet links, so happy-dom loads nothing over the network.
// The Ecosystem structure is built from its ModePage, as the page script does.
export function pageBody(name: string): string {
  const html = readFileSync(resolve(import.meta.dirname, `../../src/typescript/${name}/index.html`), "utf8");
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1];
  if (body === undefined) throw new Error(`no <body> in ${name}/index.html`);
  const page = GENERATED[name as keyof typeof GENERATED];
  return ((page ? ecoBody(page) : "") + body).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, "");
}
