#!/usr/bin/env node
// Fetches Swagger's own conversion (converter.swagger.io) for every
// *.swagger.json or *.swagger.yaml file in a directory and saves it next to
// it as *.openapi.json. YAML files are sent as YAML, so Swagger's own YAML
// reading rules apply. Used only to build parity fixtures; the app itself never
// talks to this service.
//
// Usage: node scripts/fetch-swagger-reference.mjs <dir> [--force]

import { readdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

const ENDPOINT = "https://converter.swagger.io/api/convert";
const DELAY_MS = 300;

const [dir, ...flags] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: node scripts/fetch-swagger-reference.mjs <dir> [--force]");
  process.exit(1);
}
const force = flags.includes("--force");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const files = (await readdir(dir))
  .filter((name) => /\.swagger\.(json|ya?ml)$/.test(name))
  .sort();

let failures = 0;
for (const name of files) {
  const source = path.join(dir, name);
  const target = path.join(
    dir,
    name.replace(/\.swagger\.(json|ya?ml)$/, ".openapi.json"),
  );
  const contentType = name.endsWith(".json")
    ? "application/json"
    : "application/yaml";
  if (!force && (await exists(target))) continue;

  const body = await readFile(source, "utf8");
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": contentType, accept: "application/json" },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    failures += 1;
    console.error(`✖ ${name}: HTTP ${response.status} ${text.slice(0, 200)}`);
  } else {
    await writeFile(target, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    console.log(`✔ ${name}`);
  }
  await sleep(DELAY_MS);
}

if (failures > 0) process.exitCode = 1;
