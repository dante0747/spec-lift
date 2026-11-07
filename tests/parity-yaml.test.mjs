// Every fixture in tests/fixtures/parity-yaml is a YAML Swagger 2.0 document
// (NAME.swagger.yaml) plus what Swagger's official converter returned when
// given that exact YAML text (NAME.openapi.json). Each one pins a YAML reading
// rule Swagger follows (YAML 1.1 booleans, octal numbers, unquoted versions…),
// so it goes through the same parseSpec the UI uses before conversion.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { diffJson } from "./json-diff.mjs";
import { loadConverter, loadSpecFormat } from "./load-converter.mjs";

const { convertSwagger } = await loadConverter();
const { parseSpec, serializeSpec } = await loadSpecFormat();
const fixtures = new URL("./fixtures/parity-yaml/", import.meta.url);

const names = (await readdir(fixtures))
  .filter((name) => name.endsWith(".swagger.yaml"))
  .map((name) => name.replace(/\.swagger\.yaml$/, ""))
  .sort();

test("has YAML parity fixtures", () => {
  assert.ok(names.length > 0);
});

for (const name of names) {
  test(`matches Swagger's converter for YAML input: ${name}`, async () => {
    const [source, expectedText] = await Promise.all(
      [`${name}.swagger.yaml`, `${name}.openapi.json`].map((file) =>
        readFile(new URL(file, fixtures), "utf8"),
      ),
    );
    const parsed = parseSpec(source);
    assert.equal(parsed.ok, true, parsed.message);
    assert.equal(parsed.format, "yaml");

    const expected = JSON.parse(expectedText);
    const actual = convertSwagger(parsed.value);
    if (
      JSON.stringify(actual, null, 2) !== JSON.stringify(expected, null, 2)
    ) {
      assert.fail(
        `Output differs from Swagger's converter:\n  ${diffJson(expected, actual)
          .slice(0, 10)
          .join("\n  ")}`,
      );
    }
  });
}

test("YAML output reads back to the same document", async () => {
  for (const name of names) {
    const expected = JSON.parse(
      await readFile(new URL(`${name}.openapi.json`, fixtures), "utf8"),
    );
    const roundTrip = parseSpec(serializeSpec(expected, "yaml"));
    assert.equal(roundTrip.ok, true);
    assert.deepEqual(roundTrip.value, expected, name);
  }
});

test("reads unquoted swagger and info versions as Swagger does", () => {
  const parsed = parseSpec(
    "swagger: 2.0\ninfo:\n  title: t\n  version: 1.0\npaths: {}\n",
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.swagger, "2.0");
  assert.equal(parsed.value.info.version, "1.0");
});

test("reads numeric JSON versions as Swagger does", () => {
  const parsed = parseSpec(
    '{"swagger": 2.0, "info": {"title": "t", "version": 1.0}, "paths": {},' +
      ' "x-meta": {"title": "t", "version": 1.0}}',
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.swagger, "2.0");
  // Swagger formats the number like Java's Double.toString: 1.0 stays "1.0".
  assert.equal(parsed.value.info.version, "1.0");
  // Only info.version is text in Swagger; other numbers stay numbers.
  assert.equal(parsed.value["x-meta"].version, 1);
});

test("reports YAML and JSON syntax errors with a line number", () => {
  const yaml = parseSpec('swagger: "2.0"\ninfo: [oops\n  title: x\n');
  assert.equal(yaml.ok, false);
  assert.equal(yaml.format, "yaml");
  assert.equal(typeof yaml.line, "number");

  const json = parseSpec('{\n  "swagger": "2.0",\n  oops\n}');
  assert.equal(json.ok, false);
  assert.equal(json.format, "json");
});
