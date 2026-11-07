import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadReferenceHelpers() {
  const source = await readFile(
    new URL("../app/converter-refs.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(
    outputText,
  ).toString("base64")}`;
  return import(moduleUrl);
}

const helpers = await loadReferenceHelpers();

test("classifies refs like Swagger's GenericRef", () => {
  assert.equal(helpers.refFormat("#/definitions/Pet"), "internal");
  assert.equal(helpers.refFormat("Pet"), "internal");
  assert.equal(helpers.refFormat("models.json#/Pet"), "relative");
  assert.equal(helpers.refFormat("./models.json"), "relative");
  assert.equal(helpers.refFormat("/abs/models.json"), "relative");
  assert.equal(helpers.refFormat("https://example.com/x.json"), "url");
});

test("expands bare names into the matching section", () => {
  assert.equal(
    helpers.normalizeRef("definitions", "Pet"),
    "#/definitions/Pet",
  );
  assert.equal(
    helpers.normalizeRef("parameters", "Limit"),
    "#/parameters/Limit",
  );
  assert.equal(
    helpers.normalizeRef("definitions", "#/definitions/Pet"),
    "#/definitions/Pet",
  );
  assert.equal(
    helpers.normalizeRef("definitions", "models.json#/Pet"),
    "models.json#/Pet",
  );
});

test("resolves local parameter, response, and path refs", () => {
  const parameters = { Limit: { name: "limit" }, "a/b": { name: "slash" } };

  assert.equal(
    helpers.resolveLocalRef("#/parameters/Limit", "parameters", parameters),
    parameters.Limit,
  );
  assert.equal(
    helpers.resolveLocalRef("#/parameters/a~1b", "parameters", parameters),
    parameters["a/b"],
  );
  assert.equal(
    helpers.resolveLocalRef("#/parameters/Missing", "parameters", parameters),
    undefined,
  );
  assert.equal(
    helpers.resolveLocalRef("#/responses/Limit", "parameters", parameters),
    undefined,
  );
  assert.equal(
    helpers.resolveLocalRef("#/paths/~1pets", "paths", { "/pets": 1 }),
    1,
  );
});

test("rewrites refs into OpenAPI component locations", () => {
  assert.equal(
    helpers.schemaRef("#/definitions/Pet"),
    "#/components/schemas/Pet",
  );
  assert.equal(
    helpers.responseRef("#/responses/NotFound"),
    "#/components/responses/NotFound",
  );
});

test("keeps external refs intact", () => {
  assert.equal(
    helpers.schemaRef("models.json#/definitions/Pet"),
    "models.json#/definitions/Pet",
  );
  assert.equal(
    helpers.responseRef("responses.json#/responses/NotFound"),
    "responses.json#/responses/NotFound",
  );
  assert.equal(
    helpers.schemaRef("#/x-reference-map/~1definitions~1Payload"),
    "#/x-reference-map/~1definitions~1Payload",
  );
});

test("takes the last segment as the simple name of internal refs", () => {
  assert.equal(helpers.simpleRefName("#/parameters/Limit"), "Limit");
  assert.equal(
    helpers.simpleRefName("models.json#/Limit"),
    "models.json#/Limit",
  );
});
