#!/usr/bin/env node
// Compares SpecLift's converter with Swagger's reference output.
//
// Usage: node scripts/parity-check.mjs <dir> [--max-diffs=5] [--only=name]
//
// <dir> holds pairs of files: NAME.swagger.json (input) and NAME.openapi.json
// (what converter.swagger.io returned for it; see
// scripts/fetch-swagger-reference.mjs). A pair passes only when both outputs
// serialize to identical JSON text, so key order counts too.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadConverter } from "../tests/load-converter.mjs";
import { diffJson } from "../tests/json-diff.mjs";

const args = process.argv.slice(2);
const dir = args.find((arg) => !arg.startsWith("--"));
if (!dir) {
  console.error("Usage: node scripts/parity-check.mjs <dir> [--max-diffs=5] [--only=name]");
  process.exit(1);
}
const option = (name, fallback) => {
  const match = args.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const maxDiffs = Number(option("max-diffs", "5"));
const only = option("only", "");

const { convertSwagger } = await loadConverter();

const names = (await readdir(dir))
  .filter((name) => name.endsWith(".openapi.json"))
  .map((name) => name.replace(/\.openapi\.json$/, ""))
  .filter((name) => !only || name.includes(only))
  .sort();

let passed = 0;
const failed = [];
for (const name of names) {
  const [source, expectedText] = await Promise.all([
    readFile(path.join(dir, `${name}.swagger.json`), "utf8"),
    readFile(path.join(dir, `${name}.openapi.json`), "utf8"),
  ]);
  const expected = JSON.parse(expectedText);

  let actual;
  try {
    actual = convertSwagger(JSON.parse(source));
  } catch (error) {
    failed.push(name);
    console.log(`✖ ${name}: converter threw ${error.message}`);
    continue;
  }

  if (JSON.stringify(actual, null, 2) === JSON.stringify(expected, null, 2)) {
    passed += 1;
    console.log(`✔ ${name}`);
    continue;
  }

  failed.push(name);
  const diffs = diffJson(expected, actual);
  console.log(`✖ ${name}: ${diffs.length} difference(s)`);
  for (const diff of diffs.slice(0, maxDiffs)) console.log(`    ${diff}`);
}

console.log(`\n${passed}/${names.length} identical`);
if (failed.length > 0) {
  console.log(`Different: ${failed.join(", ")}`);
  process.exitCode = 1;
}
