export type JsonRecord = Record<string, unknown>;

export type SwaggerParameterKind =
  | "parameter"
  | "body"
  | "formData"
  | "unknown";

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePointerToken(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function localReferenceName(
  reference: string,
  section: "parameters" | "responses",
): string | null {
  const prefix = `#/${section}/`;
  if (!reference.startsWith(prefix)) return null;

  const token = reference.slice(prefix.length);
  if (!token || token.includes("/")) return null;
  return decodePointerToken(token);
}

function localParameterReferenceName(reference: string): string | null {
  return localReferenceName(reference, "parameters");
}

function localResponseReferenceName(reference: string): string | null {
  return localReferenceName(reference, "responses");
}

export function resolveParameterReference(
  parameter: JsonRecord,
  globalParameters: JsonRecord,
): JsonRecord | null {
  if (typeof parameter.$ref !== "string") return null;

  const name = localParameterReferenceName(parameter.$ref);
  if (!name) return null;

  const resolved = globalParameters[name];
  return isRecord(resolved) ? resolved : null;
}

export function dereferenceParameter(
  parameter: JsonRecord,
  globalParameters: JsonRecord,
): JsonRecord {
  let current = parameter;
  const visited = new Set<JsonRecord>();

  while (!visited.has(current)) {
    visited.add(current);
    const resolved = resolveParameterReference(
      current,
      globalParameters,
    );
    if (!resolved) return current;
    current = resolved;
  }

  return current;
}

export function resolveResponseReference(
  response: JsonRecord,
  globalResponses: JsonRecord,
): JsonRecord | null {
  if (typeof response.$ref !== "string") return null;

  const name = localResponseReferenceName(response.$ref);
  if (!name) return null;

  const resolved = globalResponses[name];
  return isRecord(resolved) ? resolved : null;
}

export function dereferenceResponse(
  response: JsonRecord,
  globalResponses: JsonRecord,
): JsonRecord {
  let current = response;
  const visited = new Set<JsonRecord>();

  while (!visited.has(current)) {
    visited.add(current);
    const resolved = resolveResponseReference(
      current,
      globalResponses,
    );
    if (!resolved) return current;
    current = resolved;
  }

  return current;
}

export function parameterKind(
  parameter: JsonRecord,
  globalParameters: JsonRecord,
  visited = new Set<JsonRecord>(),
): SwaggerParameterKind {
  if (parameter.in === "body") return "body";
  if (parameter.in === "formData") return "formData";
  if (["query", "header", "path", "cookie"].includes(String(parameter.in))) {
    return "parameter";
  }

  if (visited.has(parameter)) return "unknown";
  visited.add(parameter);

  const resolved = resolveParameterReference(parameter, globalParameters);
  return resolved
    ? parameterKind(resolved, globalParameters, visited)
    : "unknown";
}

export function rewriteOpenApiReference(
  reference: string,
  globalParameters: JsonRecord,
): string {
  if (!reference.startsWith("#/")) return reference;

  const parameterName = localParameterReferenceName(reference);
  if (parameterName) {
    const referenced = globalParameters[parameterName];
    const kind = isRecord(referenced)
      ? parameterKind(referenced, globalParameters)
      : "unknown";
    const section =
      kind === "body" || kind === "formData"
        ? "requestBodies"
        : "parameters";

    return reference.replace(
      "#/parameters/",
      `#/components/${section}/`,
    );
  }

  const sectionMappings = [
    ["#/definitions/", "#/components/schemas/"],
    ["#/responses/", "#/components/responses/"],
    [
      "#/securityDefinitions/",
      "#/components/securitySchemes/",
    ],
  ] as const;

  for (const [source, target] of sectionMappings) {
    if (reference.startsWith(source)) {
      return `${target}${reference.slice(source.length)}`;
    }
  }

  return reference;
}

export function convertParameterReference(
  parameter: JsonRecord,
  globalParameters: JsonRecord,
): JsonRecord | null {
  if (typeof parameter.$ref !== "string") return null;
  return {
    $ref: rewriteOpenApiReference(parameter.$ref, globalParameters),
  };
}
