// Writes coverage/badge.svg and coverage/tests-badge.svg (flat badges, served by the site) from vitest's json-summary and json reports,
// so the README does not depend on a third-party badge service.
import { readFileSync, writeFileSync } from "node:fs";

// Approximate Verdana 11 px widths, good enough to size the badge boxes.
const charWidth = (c: string): number => ("ilj.,:;|!'1 ".includes(c) ? 4 : "mwMW%".includes(c) ? 10 : c >= "A" && c <= "Z" ? 7.5 : 6.6);
const textWidth = (s: string): number => [...s].reduce((w, c) => w + charWidth(c), 0);

function badge(label: string, message: string, color: string): string {
  const lw = Math.round(textWidth(label) + 12);
  const mw = Math.round(textWidth(message) + 12);
  const w = lw + mw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${message}"><title>${label}: ${message}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text><text x="${lw / 2}" y="14">${label}</text><text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3">${message}</text><text x="${lw + mw / 2}" y="14">${message}</text></g></svg>`;
}

const pct: number = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8")).total.lines.pct;
const pctColor = pct >= 80 ? "#4c1" : pct >= 60 ? "#dfb317" : pct >= 40 ? "#fe7d37" : "#e05d44";
writeFileSync("coverage/badge.svg", badge("coverage", `${Math.round(pct)}%`, pctColor));
console.log(`line coverage ${pct}%`);
const tests = JSON.parse(readFileSync("coverage/tests.json", "utf8")) as { numPassedTests: number; numTotalTests: number };
writeFileSync("coverage/tests-badge.svg", badge("tests", `${tests.numPassedTests} passing`, tests.numPassedTests === tests.numTotalTests ? "#4c1" : "#e05d44"));
console.log(`tests ${tests.numPassedTests}/${tests.numTotalTests}`);
