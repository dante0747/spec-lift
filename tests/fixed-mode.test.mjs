// `fixSwaggerBugs: true` fixes Swagger's converter bugs and otherwise keeps
// its output. tests/fixtures/fixed holds one small Swagger 2.0 input per fix
// (NAME.swagger.json, numbered like the fixes in app/converter.ts) and the
// hand-checked fixed-mode output (NAME.openapi.json).

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { diffJson } from "./json-diff.mjs";
import { loadConverter } from "./load-converter.mjs";

const { convertSwagger } = await loadConverter();
const FIXED = { fixSwaggerBugs: true };

async function pairs(folder) {
  const url = new URL(`./fixtures/${folder}/`, import.meta.url);
  const names = (await readdir(url))
    .filter((name) => name.endsWith(".swagger.json"))
    .map((name) => name.replace(/\.swagger\.json$/, ""))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: JSON.parse(await readFile(new URL(`${name}.swagger.json`, url), "utf8")),
      expectedUrl: new URL(`${name}.openapi.json`, url),
    })),
  );
}

const fixedFixtures = await pairs("fixed");
const parityFixtures = await pairs("parity");

test("has fixed-mode fixtures", () => {
  assert.ok(fixedFixtures.length >= 10);
});

for (const { name, source, expectedUrl } of fixedFixtures) {
  test(`fixes Swagger's bugs: ${name}`, async () => {
    const expected = JSON.parse(await readFile(expectedUrl, "utf8"));
    const actual = convertSwagger(source, FIXED);
    if (JSON.stringify(actual, null, 2) !== JSON.stringify(expected, null, 2)) {
      assert.fail(
        `Fixed-mode output differs:\n  ${diffJson(expected, actual)
          .slice(0, 10)
          .join("\n  ")}`,
      );
    }
    // Each fixture exists to show a fix, so exact mode must differ.
    assert.notDeepEqual(convertSwagger(source), actual);
  });
}

function nonExtensionKeys(value) {
  return Object.keys(value ?? {})
    .filter((key) => !key.startsWith("x-"))
    .sort();
}

for (const { name, source } of parityFixtures) {
  test(`fixed mode only adds or corrects values: ${name}`, () => {
    const exact = convertSwagger(source);
    const fixed = convertSwagger(source, FIXED);

    // Fixes add keys or change values; they never drop keys or items (the
    // one exception, an invalid empty form `enum: []`, isn't in these inputs).
    const lost = diffJson(exact, fixed).filter(
      (line) => line.includes("missing key") || line.includes("item(s)"),
    );
    assert.deepEqual(lost, []);

    assert.deepEqual(nonExtensionKeys(fixed.paths), nonExtensionKeys(exact.paths));
    for (const path of nonExtensionKeys(exact.paths)) {
      assert.deepEqual(
        nonExtensionKeys(fixed.paths[path]),
        nonExtensionKeys(exact.paths[path]),
        path,
      );
    }
    assert.deepEqual(
      Object.keys(fixed.components.schemas ?? {}),
      Object.keys(exact.components.schemas ?? {}),
    );
  });
}

test("the default stays Swagger-exact", () => {
  for (const { source } of parityFixtures) {
    assert.deepEqual(
      convertSwagger(source, { fixSwaggerBugs: false }),
      convertSwagger(source),
    );
  }
});

test("fixed mode leaves the input and later exact runs untouched", () => {
  const { source } = fixedFixtures.find(({ name }) => name.includes("shared"));
  const snapshot = structuredClone(source);
  const before = convertSwagger(source);
  convertSwagger(source, FIXED);
  assert.deepEqual(source, snapshot);
  assert.deepEqual(convertSwagger(source), before);
});
