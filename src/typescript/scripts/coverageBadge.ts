// Writes coverage/badge.json and coverage/tests-badge.json in the shields.io endpoint format from vitest's json-summary and json reports.
import { readFileSync, writeFileSync } from "node:fs";

const pct: number = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8")).total.lines.pct;
const color = pct >= 80 ? "brightgreen" : pct >= 60 ? "yellow" : pct >= 40 ? "orange" : "red";
writeFileSync("coverage/badge.json", JSON.stringify({ schemaVersion: 1, label: "coverage", message: `${Math.round(pct)}%`, color }));
console.log(`line coverage ${pct}%`);
const tests = JSON.parse(readFileSync("coverage/tests.json", "utf8")) as { numPassedTests: number; numTotalTests: number };
writeFileSync("coverage/tests-badge.json", JSON.stringify({ schemaVersion: 1, label: "tests", message: `${tests.numPassedTests} passing`, color: tests.numPassedTests === tests.numTotalTests ? "brightgreen" : "red" }));
console.log(`tests ${tests.numPassedTests}/${tests.numTotalTests}`);
