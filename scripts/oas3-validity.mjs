#!/usr/bin/env node
// Counts how many Swagger 2.0 inputs convert to INVALID OpenAPI 3.0, in
// Swagger-exact mode and in fixSwaggerBugs mode, using the official OAS 3.0
// JSON Schema.
//
// Usage: node scripts/oas3-validity.mjs <dir> [<dir> ...] [--details]
// Each <dir> holds NAME.swagger.json inputs (other files are ignored).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadConverter } from "../tests/load-converter.mjs";
import { validateOpenApi30 } from "../tests/oas3-validator.mjs";

const args = process.argv.slice(2);
const details = args.includes("--details");
const dirs = args.filter((arg) => !arg.startsWith("--"));
if (dirs.length === 0) {
  console.error("Usage: node scripts/oas3-validity.mjs <dir> [...] [--details]");
  process.exit(1);
}

const { convertSwagger } = await loadConverter();
const modes = { exact: {}, fixed: { fixSwaggerBugs: true } };

for (const dir of dirs) {
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".swagger.json"))
    .sort();
  const invalid = { exact: [], fixed: [] };

  for (const name of names) {
    const source = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    for (const [mode, options] of Object.entries(modes)) {
      let result;
      try {
        result = validateOpenApi30(convertSwagger(source, options));
      } catch (error) {
        result = { valid: false, errors: [`converter threw: ${error.message}`] };
      }
      if (!result.valid) invalid[mode].push({ name, errors: result.errors });
    }
  }

  console.log(
    `${dir}: ${names.length} specs, invalid OAS 3.0 → exact: ${invalid.exact.length}, fixed: ${invalid.fixed.length}`,
  );
  if (details) {
    for (const mode of Object.keys(modes)) {
      for (const { name, errors } of invalid[mode]) {
        console.log(`  [${mode}] ${name}`);
        for (const error of errors.slice(0, 4)) console.log(`      ${error}`);
      }
    }
  }
}
