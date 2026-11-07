// Every fixture in tests/fixtures/parity is a Swagger 2.0 document
// (NAME.swagger.json) plus what Swagger's official converter
// (converter.swagger.io) returned for it (NAME.openapi.json). SpecLift must
// produce the same document, key order included.
//
// To add a case: drop a NAME.swagger.json file in the folder and run
//   node scripts/fetch-swagger-reference.mjs tests/fixtures/parity

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { diffJson } from "./json-diff.mjs";
import { loadConverter } from "./load-converter.mjs";

const { convertSwagger } = await loadConverter();
const fixtures = new URL("./fixtures/parity/", import.meta.url);

const names = (await readdir(fixtures))
  .filter((name) => name.endsWith(".openapi.json"))
  .map((name) => name.replace(/\.openapi\.json$/, ""))
  .sort();

test("has parity fixtures", () => {
  assert.ok(names.length > 0);
});

for (const name of names) {
  test(`matches Swagger's converter: ${name}`, async () => {
    const [source, expected] = await Promise.all(
      [`${name}.swagger.json`, `${name}.openapi.json`].map(async (file) =>
        JSON.parse(await readFile(new URL(file, fixtures), "utf8")),
      ),
    );
    const actual = convertSwagger(source);
    const expectedText = JSON.stringify(expected, null, 2);
    const actualText = JSON.stringify(actual, null, 2);
    if (actualText !== expectedText) {
      assert.fail(
        `Output differs from Swagger's converter:\n  ${diffJson(expected, actual)
          .slice(0, 10)
          .join("\n  ")}`,
      );
    }
  });
}
