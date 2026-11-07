// Validates documents against the official OpenAPI 3.0 JSON Schema
// (https://spec.openapis.org/oas/3.0/schema/2021-09-28, committed under
// tests/fixtures so tests run offline).

import { readFile } from "node:fs/promises";
import Ajv from "ajv-draft-04";

const schema = JSON.parse(
  await readFile(
    new URL("./fixtures/oas-3.0-schema-2021-09-28.json", import.meta.url),
    "utf8",
  ),
);

// The schema uses formats such as `uri-reference` and `regex`; ajv's format
// plugins aren't needed to check document structure, so formats are skipped.
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile(schema);

/**
 * @returns {{ valid: boolean, errors: string[] }} errors as
 *   `<json pointer>: <message>` lines, most specific first.
 */
export function validateOpenApi30(document) {
  const valid = validate(document);
  const errors = (validate.errors ?? [])
    // `oneOf`/`anyOf` failures repeat what their branches already say, and
    // "must have required property '$ref'" is the Reference branch of a
    // `oneOf: [Schema, Reference]`.
    .filter((error) => !["oneOf", "anyOf", "if", "not"].includes(error.keyword))
    .filter((error) => error.params?.missingProperty !== "$ref")
    .map((error) => `${error.instancePath || "/"}: ${error.message}`);
  return { valid, errors: [...new Set(errors)] };
}
