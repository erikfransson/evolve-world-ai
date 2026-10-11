import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Body markup of a mode page (`<name>/index.html`) without scripts or stylesheet links, so happy-dom loads nothing over the network.
export function pageBody(name: string): string {
  const html = readFileSync(resolve(import.meta.dirname, `../../src/typescript/${name}/index.html`), "utf8");
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1];
  if (body === undefined) throw new Error(`no <body> in ${name}/index.html`);
  return body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, "");
}
