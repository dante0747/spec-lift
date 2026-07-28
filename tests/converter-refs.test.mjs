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

const globalParameters = {
  Limit: {
    name: "limit",
    in: "query",
    type: "integer",
  },
  Payload: {
    name: "payload",
    in: "body",
    required: true,
    schema: { $ref: "#/definitions/Payload" },
  },
  Upload: {
    name: "file",
    in: "formData",
    type: "file",
  },
  PayloadAlias: {
    $ref: "#/parameters/Payload",
  },
};

const globalResponses = {
  NotFound: {
    description: "Not found",
    schema: { $ref: "#/definitions/Problem" },
  },
  NotFoundAlias: {
    $ref: "#/responses/NotFound",
  },
};

test("rewrites reusable ordinary parameters as component parameters", () => {
  const parameter = { $ref: "#/parameters/Limit" };

  assert.equal(
    helpers.parameterKind(parameter, globalParameters),
    "parameter",
  );
  assert.deepEqual(
    helpers.convertParameterReference(parameter, globalParameters),
    { $ref: "#/components/parameters/Limit" },
  );
});

test("rewrites reusable body parameters as request bodies", () => {
  const parameter = { $ref: "#/parameters/Payload" };

  assert.equal(
    helpers.parameterKind(parameter, globalParameters),
    "body",
  );
  assert.deepEqual(
    helpers.convertParameterReference(parameter, globalParameters),
    { $ref: "#/components/requestBodies/Payload" },
  );
});

test("resolves aliases and form-data parameter references", () => {
  assert.equal(
    helpers.parameterKind(
      { $ref: "#/parameters/PayloadAlias" },
      globalParameters,
    ),
    "body",
  );
  assert.equal(
    helpers.rewriteOpenApiReference(
      "#/parameters/Upload",
      globalParameters,
    ),
    "#/components/requestBodies/Upload",
  );
  assert.equal(
    helpers.dereferenceParameter(
      { $ref: "#/parameters/PayloadAlias" },
      globalParameters,
    ),
    globalParameters.Payload,
  );
});

test("keeps external references intact", () => {
  assert.equal(
    helpers.rewriteOpenApiReference(
      "shared-parameters.json#/Limit",
      globalParameters,
    ),
    "shared-parameters.json#/Limit",
  );
  assert.equal(
    helpers.rewriteOpenApiReference(
      "models.json#/definitions/Payload",
      globalParameters,
    ),
    "models.json#/definitions/Payload",
  );
  assert.equal(
    helpers.rewriteOpenApiReference(
      "responses.json#/responses/NotFound",
      globalParameters,
    ),
    "responses.json#/responses/NotFound",
  );
  assert.equal(
    helpers.rewriteOpenApiReference(
      "#/x-reference-map/~1definitions~1Payload",
      globalParameters,
    ),
    "#/x-reference-map/~1definitions~1Payload",
  );
});

test("rewrites and resolves reusable response references", () => {
  assert.equal(
    helpers.rewriteOpenApiReference(
      "#/responses/NotFound",
      globalParameters,
    ),
    "#/components/responses/NotFound",
  );
  assert.equal(
    helpers.dereferenceResponse(
      { $ref: "#/responses/NotFoundAlias" },
      globalResponses,
    ),
    globalResponses.NotFound,
  );
});
