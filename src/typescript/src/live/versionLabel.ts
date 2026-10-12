import { VERSION } from "../version.ts";

// "Evolve World v0.1.0", plus the server's version when it runs a different one (e.g. during a deploy). Anything not a plain version from the server is ignored.
export function versionLabel(server: unknown, page = VERSION): string {
  const label = `Evolve World v${page}`;
  return typeof server === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(server) && server !== page ? `${label} · server v${server}` : label;
}
