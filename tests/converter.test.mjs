import assert from "node:assert/strict";
import test from "node:test";
import { loadConverter } from "./load-converter.mjs";

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

test("resolves reusable parameters and responses the way Swagger does", () => {
  const converted = convertSwagger(referenceFixture);
  const items = converted.paths["/items"];
  const upload = converted.paths["/upload"].post;

  // Swagger inlines `#/parameters` and `#/responses` refs into operations…
  assert.deepEqual(items.get.parameters[0], {
    name: "limit",
    in: "query",
    schema: { type: "integer", format: "int32" },
  });
  assert.deepEqual(items.post.requestBody, {
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Payload" },
      },
    },
    required: true,
  });
  assert.equal(items.post["x-codegen-request-body-name"], "payload");
  assert.deepEqual(
    upload.requestBody.content["multipart/form-data"].schema.properties.file,
    { type: "string", format: "binary" },
  );
  assert.equal(upload.requestBody.required, true);
  assert.equal(items.get.responses["404"].description, "Entity not found");
  assert.equal(
    upload.responses["400"].content["application/problem+json"].schema.$ref,
    "#/components/schemas/Problem",
  );

  // …and still lists them as reusable components.
  assert.deepEqual(converted.components.parameters.Limit, {
    name: "limit",
    in: "query",
    schema: { type: "integer", format: "int32" },
  });
  assert.equal(
    converted.components.requestBodies.Payload.content["application/json"]
      .schema.$ref,
    "#/components/schemas/Payload",
  );
  assert.deepEqual(converted.components.schemas.formData_Upload, {
    type: "string",
    format: "binary",
  });
  assert.equal(
    converted.components.responses.NotFound.content["application/json"]
      .schema.$ref,
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
  // Swagger's online converter rejects documents like this one because it
  // tries to download the referenced files. SpecLift never makes network
  // requests, so it converts the document and leaves the refs alone.
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
    converted.paths["/external"].get.responses["201"].content["*/*"].schema
      .$ref,
    "models.json#/definitions/Created",
  );
});

test("does not modify the input document", () => {
  const input = structuredClone(referenceFixture);
  input.parameters.Limit["x-example"] = 10;
  const snapshot = structuredClone(input);

  convertSwagger(input);
  assert.deepEqual(input, snapshot);
});

test("rejects documents that are not Swagger 2.0", () => {
  assert.throws(
    () => convertSwagger({ openapi: "3.0.0", info: {}, paths: {} }),
    /"swagger": "2.0"/,
  );
  assert.throws(
    () => convertSwagger({ swagger: "2.0", paths: {} }),
    /"info"/,
  );
  assert.throws(
    () => convertSwagger({ swagger: "2.0", info: { title: "x", version: "1" } }),
    /"paths"/,
  );
});
