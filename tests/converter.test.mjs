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
        responses: { "200": { description: "ok" } },
      },
      post: {
        parameters: [{ $ref: "#/parameters/Payload" }],
        responses: { "200": { description: "ok" } },
      },
    },
    "/upload": {
      post: {
        consumes: ["multipart/form-data"],
        parameters: [{ $ref: "#/parameters/Upload" }],
        responses: { "200": { description: "ok" } },
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
  },
};

test("matches the reference converter for reusable parameters", () => {
  const converted = convertSwagger(referenceFixture);
  const queryParameter =
    converted.paths["/items"].get.parameters[0];
  const body = converted.paths["/items"].post.requestBody;
  const formBody = converted.paths["/upload"].post.requestBody;

  assert.deepEqual(queryParameter, {
    name: "limit",
    in: "query",
    schema: { type: "integer", format: "int32" },
  });
  assert.equal(queryParameter.$ref, undefined);

  assert.equal(
    body.content["application/json"].schema.$ref,
    "#/components/schemas/Payload",
  );
  assert.equal(body.required, true);
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
