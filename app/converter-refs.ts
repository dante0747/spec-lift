// $ref helpers that follow the rules of Swagger's own parser
// (swagger-models 1.6 `GenericRef` and swagger-parser 1.0 `ResolverCache`),
// so references are normalized and resolved exactly like converter.swagger.io.

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Swagger 2.0 sections a `$ref` can point into. */
export type RefSection = "definitions" | "parameters" | "responses" | "paths";

export type RefFormat = "internal" | "relative" | "url";

/** Classifies a `$ref` the way Swagger's `GenericRef.computeRefFormat` does. */
export function refFormat(ref: string): RefFormat {
  if (ref.startsWith("http:") || ref.startsWith("https:")) return "url";
  if (ref.startsWith("#/")) return "internal";
  if (ref.startsWith(".") || ref.startsWith("/")) return "relative";
  if (!ref.includes(":") && !ref.startsWith("#") && ref.includes(".")) {
    return "relative";
  }
  return "internal";
}

/**
 * Swagger expands a bare name such as `"Pet"` to `"#/definitions/Pet"`
 * (or the matching section) before doing anything else with it.
 */
export function normalizeRef(section: RefSection, ref: string): string {
  return refFormat(ref) === "internal" && !ref.startsWith("#/")
    ? `#/${section}/${ref}`
    : ref;
}

/** The last path segment of an internal ref (`#/parameters/Limit` → `Limit`). */
export function simpleRefName(ref: string): string {
  return refFormat(ref) === "internal"
    ? ref.slice(ref.lastIndexOf("/") + 1)
    : ref;
}

/** Decodes one JSON-pointer token like Swagger does (URL decoding first). */
export function unescapePointer(token: string): string {
  let decoded = token;
  try {
    decoded = decodeURIComponent(token.replace(/\+/g, " "));
  } catch {
    // Java's URLDecoder would fail too; keep the raw token.
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Looks up `#/<section>/<name>` in a top-level Swagger map, or returns
 * undefined when the ref points anywhere else.
 */
export function resolveLocalRef<T>(
  ref: string,
  section: "parameters" | "responses" | "paths",
  map: Record<string, T> | null,
): T | undefined {
  const prefix = `#/${section}/`;
  if (!ref.startsWith(prefix) || ref.length === prefix.length) {
    return undefined;
  }
  const name = unescapePointer(ref.slice(prefix.length));
  return map && Object.hasOwn(map, name) ? map[name] : undefined;
}

/**
 * Swagger rewrites refs with a plain string prefix check
 * (`ref.indexOf("#/definitions") == 0`), so this does too.
 */
export function replaceRefPrefix(
  ref: string,
  from: string,
  to: string,
): string {
  return ref.startsWith(from) ? `${to}${ref.slice(from.length)}` : ref;
}

/** `#/definitions/X` → `#/components/schemas/X`; other refs are unchanged. */
export function schemaRef(ref: string): string {
  return replaceRefPrefix(ref, "#/definitions", "#/components/schemas");
}

/** `#/responses/X` → `#/components/responses/X`; other refs are unchanged. */
export function responseRef(ref: string): string {
  return replaceRefPrefix(ref, "#/responses", "#/components/responses");
}
