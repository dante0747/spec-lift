#!/usr/bin/env node
// Downloads a sample of real-world Swagger 2.0 specs from APIs.guru into a
// directory as NAME.swagger.json, for use with parity-check.mjs (run
// fetch-swagger-reference.mjs afterwards to get Swagger's conversions).
// The corpus is for local testing only and is not committed.
//
// Usage: node scripts/build-apis-guru-corpus.mjs <dir> [count=40] [maxKb=1500] [offset=0]
// A different offset picks a different sample.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [dir, countArg = "40", maxKbArg = "1500", offsetArg = "0"] =
  process.argv.slice(2);
if (!dir) {
  console.error(
    "Usage: node scripts/build-apis-guru-corpus.mjs <dir> [count] [maxKb] [offset]",
  );
  process.exit(1);
}
const wanted = Number(countArg);
const maxBytes = Number(maxKbArg) * 1024;
const offset = Number(offsetArg);
await mkdir(dir, { recursive: true });

const list = await (await fetch("https://api.apis.guru/v2/list.json")).json();
const candidates = Object.entries(list)
  .map(([id, api]) => ({ id, version: api.versions[api.preferred] }))
  .filter(({ version }) => version?.openapiVer === "2.0" && version.swaggerUrl)
  .sort((a, b) => a.id.localeCompare(b.id));

// Spread the picks over the alphabet, at most one API per provider.
const providers = new Set();
const step = Math.max(1, Math.floor(candidates.length / (wanted * 3)));
let saved = 0;
for (let index = offset; index < candidates.length && saved < wanted; index += step) {
  const { id, version } = candidates[index];
  const provider = id.split(":")[0];
  if (providers.has(provider)) continue;

  const response = await fetch(version.swaggerUrl);
  const text = await response.text();
  if (!response.ok || text.length > maxBytes) continue;
  // Some entries labelled 2.0 are already OpenAPI 3 documents.
  try {
    if (JSON.parse(text).swagger !== "2.0") continue;
  } catch {
    continue;
  }

  providers.add(provider);
  const name = id.replace(/[^a-z0-9.-]+/gi, "_");
  await writeFile(path.join(dir, `${name}.swagger.json`), text);
  saved += 1;
  console.log(`${saved}. ${id} (${Math.round(text.length / 1024)} KB)`);
}
