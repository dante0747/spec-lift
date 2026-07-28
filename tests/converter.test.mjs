import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

function transpile(source, fileName) {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString(
    "base64",
  )}`;
}

async function loadConverter() {
  const [helperSource, pageSource] = await Promise.all([
    readFile(
      new URL("../app/converter-refs.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  const helperUrl = dataModule(
    transpile(helperSource, "converter-refs.ts"),
  );
  const importStart = pageSource.indexOf(
    "import {\n  convertParameterReference",
  );
  const importEnd =
    pageSource.indexOf('} from "./converter-refs";') +
    '} from "./converter-refs";'.length;
  const engineStart = pageSource.indexOf("const HTTP_METHODS");
  const engineEnd = pageSource.indexOf("function countOperations");

  assert.ok(importStart >= 0 && importEnd > importStart);
  assert.ok(engineStart >= 0 && engineEnd > engineStart);

  const helperImport = pageSource
    .slice(importStart, importEnd)
    .replace('"./converter-refs"', `"${helperUrl}"`);
  const engineSource = `${helperImport}\n${pageSource.slice(
    engineStart,
    engineEnd,
  )}\nexport { convertSwagger };`;

  return import(
    dataModule(transpile(engineSource, "converter-engine.ts"))
  );
}

const { convertSwagger } = await loadConverter();

const referenceFixture = {
  swagger: "2.0",
  info: { title: "Reference fixture", version: "1.0.0" },
  consumes: ["application/json"],
  produces: ["application/json"],
  paths: {
    "/items": {
      get: {
        parameters: [{ $ref: "#/parameters/Limit" }],
        responses: {
          "200": { description: "ok" },
          "404": { $ref: "#/responses/NotFound" },
        },
      },
      post: {
        parameters: [{ $ref: "#/parameters/Payload" }],
        responses: { "200": { description: "ok" } },
      },
    },
    "/upload": {
      post: {
        consumes: ["multipart/form-data"],
        produces: ["application/problem+json"],
        parameters: [{ $ref: "#/parameters/Upload" }],
        responses: {
          "400": { $ref: "#/responses/NotFound" },
        },
      },
    },
  },
  parameters: {
    Limit: {
      name: "limit",
      in: "query",
      type: "integer",
      format: "int32",
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
      required: true,
      type: "file",
    },
  },
  definitions: {
    Payload: {
      type: "object",
      properties: { id: { type: "string" } },
    },
    Problem: {
      type: "object",
      properties: { detail: { type: "string" } },
    },
  },
  responses: {
    NotFound: {
      description: "Entity not found",
      schema: { $ref: "#/definitions/Problem" },
    },
  },
};

test("preserves reusable component references at operation level", () => {
  const converted = convertSwagger(referenceFixture);
  const queryParameter =
    converted.paths["/items"].get.parameters[0];
  const body = converted.paths["/items"].post.requestBody;
  const formBody = converted.paths["/upload"].post.requestBody;
  const response = converted.paths["/items"].get.responses["404"];
  const overriddenResponse =
    converted.paths["/upload"].post.responses["400"];

  assert.deepEqual(queryParameter, {
    $ref: "#/components/parameters/Limit",
  });

  assert.deepEqual(body, {
    $ref: "#/components/requestBodies/Payload",
  });
  assert.equal(
    converted.paths["/items"].post[
      "x-codegen-request-body-name"
    ],
    "payload",
  );

  assert.deepEqual(
    formBody.content["multipart/form-data"].schema.properties.file,
    { type: "string", format: "binary" },
  );
  assert.equal(formBody.required, true);

  assert.deepEqual(response, {
    $ref: "#/components/responses/NotFound",
  });
  assert.equal(
    overriddenResponse.content["application/problem+json"].schema.$ref,
    "#/components/schemas/Problem",
  );
  assert.equal(overriddenResponse.$ref, undefined);

  assert.deepEqual(converted.components.parameters.Limit, {
    name: "limit",
    in: "query",
    schema: { type: "integer", format: "int32" },
  });
  assert.equal(
    converted.components.requestBodies.Payload.content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/Payload",
  );
  assert.equal(
    converted.components.responses.NotFound.content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/Problem",
  );
});

test("never emits an incomplete parameter reference object", () => {
  const converted = convertSwagger(referenceFixture);

  for (const path of Object.values(converted.paths)) {
    for (const operation of Object.values(path)) {
      if (
        typeof operation !== "object" ||
        operation === null ||
        !Array.isArray(operation.parameters)
      ) {
        continue;
      }

      for (const parameter of operation.parameters) {
        const isReference = typeof parameter.$ref === "string";
        const isParameter =
          typeof parameter.name === "string" &&
          typeof parameter.in === "string" &&
          (parameter.schema !== undefined ||
            parameter.content !== undefined);
        assert.ok(isReference || isParameter);
      }
    }
  }
});

function collectReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return references;
  }
  if (typeof value !== "object" || value === null) return references;

  for (const [key, nested] of Object.entries(value)) {
    if (key === "$ref" && typeof nested === "string") {
      references.push(nested);
    } else {
      collectReferences(nested, references);
    }
  }
  return references;
}

function resolveJsonPointer(document, reference) {
  if (!reference.startsWith("#/")) return undefined;
  return reference
    .slice(2)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce(
      (current, token) =>
        typeof current === "object" &&
        current !== null &&
        token in current
          ? current[token]
          : undefined,
      document,
    );
}

test("every emitted local reference resolves to an output component", () => {
  const converted = convertSwagger(referenceFixture);
  const references = collectReferences(converted);

  assert.ok(references.length > 0);
  for (const reference of references) {
    assert.notEqual(
      resolveJsonPointer(converted, reference),
      undefined,
      `Unresolved local reference: ${reference}`,
    );
  }
});

test("keeps external schema and response references unchanged", () => {
  const converted = convertSwagger({
    swagger: "2.0",
    info: { title: "External references", version: "1.0.0" },
    paths: {
      "/external": {
        get: {
          responses: {
            "200": { $ref: "responses.json#/responses/Success" },
            "201": {
              description: "Created",
              schema: { $ref: "models.json#/definitions/Created" },
            },
          },
        },
      },
    },
  });

  assert.equal(
    converted.paths["/external"].get.responses["200"].$ref,
    "responses.json#/responses/Success",
  );
  assert.equal(
    converted.paths["/external"].get.responses["201"].content[
      "application/json"
    ].schema.$ref,
    "models.json#/definitions/Created",
  );
});
