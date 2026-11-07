// Fixed-mode output must be valid OpenAPI 3.0 according to the official
// JSON Schema, for every committed fixture input (JSON and YAML).

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { loadConverter, loadSpecFormat } from "./load-converter.mjs";
import { validateOpenApi30 } from "./oas3-validator.mjs";

const { convertSwagger } = await loadConverter();
const { parseSpec } = await loadSpecFormat();

/**
 * Inputs whose own content can't become valid OpenAPI 3.0 without inventing
 * data, so fixed mode keeps the problem.
 */
const INVALID_INPUTS = {
  "parity/path-ref-and-misc":
    "has an operation without responses, which OpenAPI 3.0 requires",
};

async function inputs(folder, extension) {
  const url = new URL(`./fixtures/${folder}/`, import.meta.url);
  const files = (await readdir(url)).filter((name) => name.endsWith(extension));
  return Promise.all(
    files.sort().map(async (file) => {
      const text = await readFile(new URL(file, url), "utf8");
      const parsed = parseSpec(text);
      assert.equal(parsed.ok, true, `${folder}/${file}: ${parsed.message}`);
      return { id: `${folder}/${file.slice(0, -extension.length)}`, source: parsed.value };
    }),
  );
}

const all = [
  ...(await inputs("parity", ".swagger.json")),
  ...(await inputs("parity-yaml", ".swagger.yaml")),
  ...(await inputs("fixed", ".swagger.json")),
];

test("the validator rejects invalid documents", () => {
  assert.equal(validateOpenApi30({ openapi: "3.0.1" }).valid, false);
  assert.equal(
    validateOpenApi30({
      openapi: "3.0.1",
      info: { title: "t", version: "1" },
      paths: { "/a": { get: { responses: { 200: { description: "ok" } } } } },
      components: { schemas: { F: { type: "file" } } },
    }).valid,
    false,
  );
});

for (const { id, source } of all) {
  test(`fixed mode is valid OpenAPI 3.0: ${id}`, () => {
    const { valid, errors } = validateOpenApi30(
      convertSwagger(source, { fixSwaggerBugs: true }),
    );
    if (INVALID_INPUTS[id]) {
      assert.equal(valid, false, `${id} is valid now; remove it from INVALID_INPUTS`);
    } else {
      assert.ok(valid, `Invalid OpenAPI 3.0:\n  ${errors.slice(0, 8).join("\n  ")}`);
    }
  });
}
