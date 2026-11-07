/**
 * Swagger 2.0 → OpenAPI 3.0 converter that reproduces Swagger's official
 * converter (converter.swagger.io, swagger-parser 2.1.22) output for output.
 *
 * Swagger converts in three steps and so does this module:
 *   1. read the document into Swagger's v1 object model, which keeps only the
 *      fields that model understands (`read*`),
 *   2. resolve local `$ref`s the way swagger-parser v1 does (`resolve*`),
 *   3. convert to OpenAPI 3 objects (`convert*`) and emit them with the key
 *      order Jackson uses for swagger-core's models (`emit*`).
 *
 * Swagger's quirks are reproduced on purpose (they are marked "Swagger
 * quirk") so the output matches converter.swagger.io exactly. With the
 * `fixSwaggerBugs` option the bugs among them are fixed instead (marked
 * "Fix n", see `ConvertOptions`); everything else stays the same.
 * Everything runs locally: nothing here touches the network.
 */

import {
  isRecord,
  normalizeRef,
  resolveLocalRef,
  responseRef,
  schemaRef,
  simpleRefName,
  type JsonRecord,
} from "./converter-refs";

export const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

export type ConvertOptions = {
  /**
   * Fix the Swagger converter bugs that produce invalid OpenAPI 3.0 or drop
   * information. Off by default, which matches converter.swagger.io exactly.
   *
   *  1. `type: file` in schemas becomes `type: string, format: binary`.
   *  2. Date and date-time values keep their original text.
   *  3. Array parameter defaults stay arrays (not JSON text).
   *  4. Number/integer/boolean form-field enums stay typed.
   *  5. Object/array examples on string schemas keep their JSON value.
   *  6. Shared parameters, headers and schemas keep example/nullable/
   *     discriminator on every use.
   *  7. Properties keep default/enum Swagger drops for some types/formats.
   *  8. Models keep readOnly/minProperties/maxProperties; allOf models keep
   *     example/externalDocs/discriminator.
   *  9. Contact extensions and x- keys of Paths/Responses objects are kept.
   * 10. Operation `schemes` become operation `servers` when they differ.
   */
  fixSwaggerBugs?: boolean;
};

/**
 * Whether the current `convertSwagger` call fixes Swagger's bugs. Conversion
 * is synchronous, so a module-level flag set for the duration of one call is
 * safe and saves threading it through every helper.
 */
let fixBugs = false;

/* -------------------------------------------------------------------------- */
/* Java compatibility helpers                                                 */
/* -------------------------------------------------------------------------- */

type Ext = JsonRecord;

/** Extensions Swagger removes (in place) whenever it copies extensions. */
const STRIPPED_EXTENSIONS = ["x-example", "x-examples", "x-nullable"];

function javaStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }
  return hash;
}

/** Iteration order of a `java.util.HashMap` filled with these keys in order. */
export function javaHashMapOrder(keys: string[]): string[] {
  let capacity = 16;
  while (keys.length > capacity * 0.75) capacity *= 2;
  return keys
    .map((key, index) => {
      const hash = javaStringHash(key);
      return { key, index, bucket: (hash ^ (hash >>> 16)) & (capacity - 1) };
    })
    .sort((a, b) => a.bucket - b.bucket || a.index - b.index)
    .map((entry) => entry.key);
}

/**
 * How Jackson prints a JSON number: whole numbers are integer nodes (plain
 * digits), anything else is a double printed with `Double.toString`.
 */
function javaNumberText(value: number): string {
  if (Number.isInteger(value)) return BigInt(value).toString();
  return javaDoubleToString(value);
}

/** `Double.toString`. */
function javaDoubleToString(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0.0";
  if (magnitude >= 1e-3 && magnitude < 1e7) {
    const text = String(value);
    return text.includes(".") ? text : `${text}.0`;
  }
  const [mantissa, exponent] = value.toExponential().split("e");
  const digits = mantissa.includes(".") ? mantissa : `${mantissa}.0`;
  return `${digits}E${Number(exponent)}`;
}

/** Jackson's `JsonNode.asText()`. Containers give an empty string. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return javaNumberText(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return "";
}

/** `Object.toString()` of a value Jackson converted to plain Java objects. */
function javaToString(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(javaToString).join(", ")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${key}=${javaToString(item)}`)
      .join(", ")}}`;
  }
  return asText(value);
}

function isNotBlank(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Drops x-example/x-examples/x-nullable from copied extensions.
 * Swagger quirk: it deletes them from the shared source object, so the next
 * use of the same parameter/header/schema loses its example and nullable.
 * Fix 6: work on a copy instead.
 */
function stripExtensions(ext: Ext): Ext {
  const target = fixBugs ? { ...ext } : ext;
  for (const key of STRIPPED_EXTENSIONS) delete target[key];
  return target;
}

function readNullable(ext: Ext | null | undefined): boolean | undefined {
  const value = ext?.["x-nullable"];
  return typeof value === "boolean" ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* Readers with the semantics of Swagger's v1 `SwaggerDeserializer`           */
/* -------------------------------------------------------------------------- */

function readString(node: JsonRecord, key: string): string | null {
  const value = node[key];
  if (value === undefined || (typeof value === "object" && value !== null)) {
    return null;
  }
  return asText(value);
}

function readBoolean(node: JsonRecord, key: string): boolean | null {
  const value = node[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return null;
}

function readInteger(node: JsonRecord, key: string): number | null {
  const value = node[key];
  return typeof value === "number" ? Math.trunc(value) : null;
}

function readNumber(node: JsonRecord, key: string): number | null {
  const value = node[key];
  return typeof value === "number" ? value : null;
}

function readObject(node: JsonRecord, key: string): JsonRecord | null {
  const value = node[key];
  return isRecord(value) ? value : null;
}

function readArray(node: JsonRecord, key: string): unknown[] | null {
  const value = node[key];
  return Array.isArray(value) ? value : null;
}

function readStringList(node: JsonRecord, key: string): string[] | null {
  const array = readArray(node, key);
  return array
    ? array.filter((item): item is string => typeof item === "string")
    : null;
}

/** Vendor extensions in document order (a `LinkedHashMap` in Swagger). */
function readExtensions(node: JsonRecord): Ext {
  const ext: Ext = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("x-")) ext[key] = value;
  }
  return ext;
}

/* -------------------------------------------------------------------------- */
/* Swagger v1 model                                                           */
/* -------------------------------------------------------------------------- */

type PropertyClass =
  | "Boolean"
  | "ByteArray"
  | "Binary"
  | "Date"
  | "DateTime"
  | "Integer"
  | "Long"
  | "Float"
  | "Double"
  | "BaseInteger"
  | "Decimal"
  | "File"
  | "Ref"
  | "Email"
  | "UUID"
  | "Object"
  | "Untyped"
  | "Array"
  | "Map"
  | "String"
  | "Composed"
  | "BooleanValue";

interface V1Xml {
  name?: string;
  namespace?: string;
  prefix?: string;
  attribute?: boolean;
  wrapped?: boolean;
}

interface V1Property {
  cls: PropertyClass;
  type: string | null;
  format: string | null;
  title: string | null;
  description: string | null;
  readOnly: boolean | null;
  xml: V1Xml | null;
  /** undefined when absent; raw JSON for object-like classes, text otherwise. */
  example: unknown;
  default: unknown;
  enum: unknown[] | null;
  minLength: number | null;
  maxLength: number | null;
  pattern: string | null;
  minimum: number | null;
  maximum: number | null;
  exclusiveMinimum: boolean | null;
  exclusiveMaximum: boolean | null;
  multipleOf: number | null;
  minItems: number | null;
  maxItems: number | null;
  uniqueItems: boolean | null;
  minProperties: number | null;
  maxProperties: number | null;
  items: V1Property | null;
  additionalProperties: V1Property | null;
  properties: Record<string, V1Property> | null;
  allOf: (V1Property | null)[] | null;
  ref: string | null;
  booleanValue: boolean | null;
  /** Set when a parent object/model lists this property as required. */
  required: boolean;
  /** A `java.util.HashMap` in Swagger, so keys are kept in hash order. */
  ext: Ext;
  /** The JSON this was read from (null for synthesized properties). */
  source: JsonRecord | null;
}

interface V1ModelImpl {
  kind: "impl";
  type: string | null;
  format: string | null;
  title: string | null;
  description: string | null;
  example: unknown;
  default: string | null;
  enum: string[] | null;
  minimum: number | null;
  maximum: number | null;
  exclusiveMinimum: boolean | null;
  exclusiveMaximum: boolean | null;
  multipleOf: number | null;
  pattern: string | null;
  minLength: number | null;
  maxLength: number | null;
  uniqueItems: boolean | null;
  xml: V1Xml | null;
  externalDocs: V1ExternalDocs | null;
  discriminator: string | null;
  properties: Record<string, V1Property> | null;
  additionalProperties: V1Property | null;
  ext: Ext;
  source: JsonRecord;
}

interface V1ArrayModel {
  kind: "array";
  title: string | null;
  description: string | null;
  example: unknown;
  items: V1Property | null;
  minItems: number | null;
  maxItems: number | null;
  uniqueItems: boolean | null;
  xml: V1Xml | null;
  properties: Record<string, V1Property> | null;
  ext: Ext;
  source: JsonRecord;
}

interface V1ComposedModel {
  kind: "composed";
  title: string | null;
  description: string | null;
  allOf: V1Model[];
  properties: Record<string, V1Property> | null;
  ext: Ext;
  source: JsonRecord;
}

interface V1RefModel {
  kind: "ref";
  ref: string;
}

type V1Model = V1ModelImpl | V1ArrayModel | V1ComposedModel | V1RefModel;

interface V1ExternalDocs {
  description: string | null;
  url: string | null;
  ext: Ext;
}

interface V1RefParameter {
  kind: "ref";
  ref: string;
  in: null;
  name: null;
  required: false;
  ext: Ext;
}

interface V1BodyParameter {
  kind: "body";
  in: "body";
  name: string | null;
  description: string | null;
  required: boolean;
  schema: V1Model | null;
  examples: JsonRecord | null;
  ext: Ext;
}

interface V1SerializableParameter {
  kind: "serializable";
  in: "query" | "header" | "path" | "formData";
  name: string | null;
  description: string | null;
  required: boolean;
  type: string | null;
  format: string | null;
  defaultValue: string | null;
  maximum: number | null;
  exclusiveMaximum: boolean | null;
  minimum: number | null;
  exclusiveMinimum: boolean | null;
  maxLength: number | null;
  minLength: number | null;
  pattern: string | null;
  maxItems: number | null;
  minItems: number | null;
  multipleOf: number | null;
  uniqueItems: boolean | null;
  enum: string[] | null;
  readOnly: boolean | null;
  allowEmptyValue: boolean | null;
  items: V1Property | null;
  collectionFormat: string | null;
  ext: Ext;
  source: JsonRecord;
}

type V1Parameter = V1RefParameter | V1BodyParameter | V1SerializableParameter;

interface V1RefResponse {
  kind: "ref";
  ref: string;
}

interface V1PlainResponse {
  kind: "response";
  description: string | null;
  schema: V1Model | null;
  headers: Record<string, V1Property | null> | null;
  examples: JsonRecord | null;
  ext: Ext;
}

type V1Response = V1RefResponse | V1PlainResponse;

interface V1Operation {
  tags: string[] | null;
  summary: string | null;
  description: string | null;
  externalDocs: V1ExternalDocs | null;
  operationId: string | null;
  consumes: string[] | null;
  produces: string[] | null;
  parameters: V1Parameter[];
  responses: Record<string, V1Response | null> | null;
  deprecated: boolean | null;
  security: Record<string, string[]>[] | null;
  ext: Ext;
  source: JsonRecord;
}

/** Operation names in the order Swagger's v1 `Path` stores them. */
const V1_OPERATION_KEYS = [
  "get",
  "put",
  "post",
  "head",
  "delete",
  "patch",
  "options",
] as const;

type V1Method = (typeof V1_OPERATION_KEYS)[number];

interface V1PlainPath {
  kind: "path";
  parameters: V1Parameter[] | null;
  operations: Partial<Record<V1Method, V1Operation>>;
  ext: Ext;
}

interface V1RefPath {
  kind: "ref";
  ref: string;
}

type V1Path = V1PlainPath | V1RefPath;

interface V1SecurityScheme {
  type: "basic" | "apiKey" | "oauth2";
  description: string | null;
  name: string | null;
  in: string | null;
  flow: string | null;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  scopes: Record<string, string> | null;
  ext: Ext;
}

interface V1Tag {
  name: string | null;
  description: string | null;
  externalDocs: V1ExternalDocs | null;
  ext: Ext;
}

interface V1Info {
  title: string | null;
  description: string | null;
  termsOfService: string | null;
  contact: {
    name: string | null;
    url: string | null;
    email: string | null;
    ext: Ext;
  } | null;
  license: { name: string | null; url: string | null; ext: Ext } | null;
  version: string | null;
  ext: Ext;
}

interface V1Swagger {
  swagger: string | null;
  info: V1Info | null;
  host: string | null;
  basePath: string | null;
  schemes: string[] | null;
  consumes: string[] | null;
  produces: string[] | null;
  paths: Record<string, V1Path>;
  definitions: Record<string, V1Model> | null;
  parameters: Record<string, V1Parameter> | null;
  responses: Record<string, V1Response | null> | null;
  securityDefinitions: Record<string, V1SecurityScheme> | null;
  security: Record<string, string[]>[] | null;
  tags: V1Tag[] | null;
  externalDocs: V1ExternalDocs | null;
  ext: Ext | null;
  /** x- keys of the Paths object, which Swagger drops. */
  pathsExt: Ext;
}

/* -------------------------------------------------------------------------- */
/* Step 1a: properties (swagger-core v1 `PropertyDeserializer`)               */
/* -------------------------------------------------------------------------- */

// The property deserializer reads values more loosely than the main reader:
// any present value is turned into text, and non-numbers read as 0/false.
function pdString(node: JsonRecord, key: string): string | null {
  return node[key] === undefined ? null : asText(node[key]);
}

function pdInteger(node: JsonRecord, key: string): number | null {
  const value = node[key];
  if (value === undefined) return null;
  return typeof value === "number" ? Math.trunc(value) : 0;
}

function pdNumber(node: JsonRecord, key: string): number | null {
  const value = node[key];
  return typeof value === "number" ? value : null;
}

function pdBoolean(node: JsonRecord, key: string): boolean | null {
  const value = node[key];
  if (value === undefined) return null;
  return value === true;
}

function pdEnum(node: JsonRecord): string[] | null {
  const value = node.enum;
  if (!Array.isArray(value)) return null;
  const result = value
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map(asText);
  return result.length > 0 ? result : null;
}

/** Property extensions live in a `HashMap`, so use Java's hash order. */
function pdExtensions(node: JsonRecord): Ext {
  const keys = Object.keys(node).filter((key) => key.startsWith("x-"));
  const ext: Ext = {};
  for (const key of javaHashMapOrder(keys)) ext[key] = node[key];
  return ext;
}

function javaAsBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  if (typeof value === "number") return value !== 0;
  return false;
}

function readXml(node: JsonRecord): V1Xml | null {
  const xml = node.xml;
  if (!isRecord(xml)) return null;
  const output: V1Xml = {};
  if (xml.name !== undefined) output.name = asText(xml.name);
  if (xml.namespace !== undefined) output.namespace = asText(xml.namespace);
  if (xml.prefix !== undefined) output.prefix = asText(xml.prefix);
  if (xml.attribute !== undefined) output.attribute = javaAsBoolean(xml.attribute);
  if (xml.wrapped !== undefined) output.wrapped = javaAsBoolean(xml.wrapped);
  return output;
}

function emptyProperty(cls: PropertyClass, type: string | null): V1Property {
  return {
    cls,
    type,
    format: null,
    title: null,
    description: null,
    readOnly: null,
    xml: null,
    example: undefined,
    default: undefined,
    enum: null,
    minLength: null,
    maxLength: null,
    pattern: null,
    minimum: null,
    maximum: null,
    exclusiveMinimum: null,
    exclusiveMaximum: null,
    multipleOf: null,
    minItems: null,
    maxItems: null,
    uniqueItems: null,
    minProperties: null,
    maxProperties: null,
    items: null,
    additionalProperties: null,
    properties: null,
    allOf: null,
    ref: null,
    booleanValue: null,
    required: false,
    ext: {},
    source: null,
  };
}

/** Swagger's `PropertyBuilder.Processor.fromType`, in its lookup order. */
function propertyClassFor(
  type: string | null,
  format: string | null,
): PropertyClass | null {
  if (type === "boolean") return "Boolean";
  if (type === "string" && format === "byte") return "ByteArray";
  if (type === "string" && format === "binary") return "Binary";
  if (type === "string" && format === "date") return "Date";
  if (type === "string" && format === "date-time") return "DateTime";
  if (type === "integer" && format === "int32") return "Integer";
  if (type === "integer" && format === "int64") return "Long";
  if (type === "number" && format === "float") return "Float";
  if (type === "number" && format === "double") return "Double";
  if (type === "integer") return "BaseInteger";
  if (type === "number") return "Decimal";
  if (type === "file") return "File";
  if (type === "ref") return "Ref";
  if (type === "string" && format === "email") return "Email";
  if (type === "string" && format === "uuid") return "UUID";
  if (type === "object") return "Object";
  if (type === null) return "Untyped";
  if (type === "array") return "Array";
  if (type === "string") return "String";
  return null;
}

const DEFAULT_PROPERTY_FORMATS: Partial<Record<PropertyClass, string>> = {
  ByteArray: "byte",
  Binary: "binary",
  Date: "date",
  DateTime: "date-time",
  Integer: "int32",
  Long: "int64",
  Float: "float",
  Double: "double",
  Email: "email",
  UUID: "uuid",
};

const DEFAULT_PROPERTY_TYPES: Partial<Record<PropertyClass, string>> = {
  Boolean: "boolean",
  ByteArray: "string",
  Binary: "string",
  Date: "string",
  DateTime: "string",
  Integer: "integer",
  Long: "integer",
  Float: "number",
  Double: "number",
  BaseInteger: "integer",
  Decimal: "number",
  File: "file",
  Email: "string",
  UUID: "string",
  Object: "object",
  Array: "array",
  String: "string",
};

const BASE64_PATTERN =
  "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

const NUMERIC_CLASSES = new Set<PropertyClass>([
  "Integer",
  "Long",
  "Float",
  "Double",
  "BaseInteger",
  "Decimal",
]);

function nonEmpty<T>(values: T[]): T[] | null {
  return values.length > 0 ? values : null;
}

function parseJavaInteger(text: string, bits: 32 | 64): number | null {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  const limit = bits === 32 ? 2 ** 31 : 2 ** 63;
  return value >= -limit && value < limit ? value : null;
}

function parseJavaFloat(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed.replace(/[fFdD]$/, ""));
}

/** `PropertyBuilder.build(type, format, args)` for the given node. */
function buildProperty(
  node: JsonRecord,
  type: string | null,
  format: string | null,
): V1Property | null {
  const cls = propertyClassFor(type, format);
  if (!cls) return null;

  const property = emptyProperty(cls, DEFAULT_PROPERTY_TYPES[cls] ?? null);
  property.format = DEFAULT_PROPERTY_FORMATS[cls] ?? format;
  property.readOnly = pdBoolean(node, "readOnly");
  property.title = pdString(node, "title");
  property.description = pdString(node, "description");
  const example = pdString(node, "example");
  property.example = example === null ? undefined : example;
  property.ext = pdExtensions(node);

  const enumValues = pdEnum(node);
  const defaultValue = pdString(node, "default");

  if (NUMERIC_CLASSES.has(cls)) {
    property.minimum = pdNumber(node, "minimum");
    property.maximum = pdNumber(node, "maximum");
    property.exclusiveMinimum = pdBoolean(node, "exclusiveMinimum");
    property.exclusiveMaximum = pdBoolean(node, "exclusiveMaximum");
    property.multipleOf = pdNumber(node, "multipleOf");
  }

  switch (cls) {
    case "String":
    case "Email":
    case "ByteArray":
    case "UUID":
      property.default = defaultValue ?? undefined;
      property.minLength = pdInteger(node, "minLength");
      property.maxLength = pdInteger(node, "maxLength");
      property.pattern = pdString(node, "pattern");
      if (cls === "ByteArray") {
        property.pattern = BASE64_PATTERN;
      } else {
        property.enum = enumValues;
      }
      break;
    case "Integer":
    case "Long": {
      const bits = cls === "Integer" ? 32 : 64;
      if (defaultValue !== null) {
        property.default = parseJavaInteger(defaultValue, bits) ?? undefined;
      }
      property.enum = nonEmpty(
        (enumValues ?? [])
          .map((value) => parseJavaInteger(value, bits))
          .filter((value): value is number => value !== null),
      );
      break;
    }
    case "Float":
    case "Double":
      if (defaultValue !== null) {
        property.default = parseJavaFloat(defaultValue) ?? undefined;
      }
      property.enum = nonEmpty(
        (enumValues ?? [])
          .map(parseJavaFloat)
          .filter((value): value is number => value !== null),
      );
      break;
    case "Boolean":
      if (defaultValue !== null) {
        property.default = defaultValue.toLowerCase() === "true";
      }
      break;
    case "Date":
    case "DateTime":
      property.enum = enumValues;
      break;
    case "Array":
      property.minItems = pdInteger(node, "minItems");
      property.maxItems = pdInteger(node, "maxItems");
      property.uniqueItems = pdBoolean(node, "uniqueItems") === true ? true : null;
      break;
    default:
      break;
  }
  return property;
}

/** Reads a property and remembers the JSON it came from. */
function readProperty(node: unknown): V1Property | null {
  const property = readPropertyNode(node);
  if (property && isRecord(node)) property.source = node;
  return property;
}

/** swagger-core v1 `PropertyDeserializer.propertyFromNode`. */
function readPropertyNode(node: unknown): V1Property | null {
  if (typeof node === "boolean") {
    const property = emptyProperty("BooleanValue", null);
    property.booleanValue = node;
    return property;
  }
  if (!isRecord(node)) {
    return buildProperty({}, null, null);
  }

  const type = pdString(node, "type");
  const title = pdString(node, "title");
  const format = pdString(node, "format");
  const readOnly = pdBoolean(node, "readOnly");
  const description = pdString(node, "description");
  const xml = readXml(node);

  if (node.$ref !== undefined) {
    const property = emptyProperty("Ref", "ref");
    property.ref = normalizeRef("definitions", asText(node.$ref));
    return property;
  }

  if (type === "object" || node.properties !== undefined || node.allOf !== undefined) {
    const example = node.example;
    const additional = node.additionalProperties;
    const mapProperty = (items: V1Property): V1Property => {
      const property = emptyProperty("Map", "object");
      property.additionalProperties = items;
      property.description = description;
      property.title = title;
      property.xml = xml;
      property.example = example;
      property.minProperties = pdInteger(node, "minProperties");
      property.maxProperties = pdInteger(node, "maxProperties");
      property.ext = pdExtensions(node);
      property.readOnly = readOnly;
      return property;
    };

    if (isRecord(additional)) {
      const items = readProperty(additional);
      if (items) return mapProperty(items);
    } else if (typeof additional === "boolean") {
      const items = emptyProperty("BooleanValue", null);
      items.booleanValue = additional;
      return mapProperty(items);
    } else {
      const properties: Record<string, V1Property> = {};
      if (node.properties !== undefined) {
        if (isRecord(node.properties)) {
          for (const [name, value] of Object.entries(node.properties)) {
            const property = readProperty(value);
            if (property) properties[name] = property;
          }
        }
      } else if (Array.isArray(node.allOf)) {
        const composed = emptyProperty("Composed", "object");
        composed.description = description;
        composed.title = title;
        composed.example = example;
        composed.ext = pdExtensions(node);
        composed.allOf = node.allOf.map(readProperty);
        return composed;
      }

      const object = emptyProperty("Object", "object");
      object.properties = properties;
      object.description = description;
      object.title = title;
      object.xml = xml;
      object.readOnly = readOnly;
      object.example = example;
      object.ext = pdExtensions(node);
      const required = Array.isArray(node.required)
        ? node.required.map(asText)
        : [];
      for (const name of required) {
        if (properties[name]) properties[name].required = true;
      }
      return object;
    }
  }

  if (type === "array" && node.items !== undefined) {
    const array = emptyProperty("Array", "array");
    array.items = readProperty(node.items);
    array.description = description;
    array.title = title;
    array.xml = xml;
    array.readOnly = readOnly;
    array.minItems = pdInteger(node, "minItems");
    array.maxItems = pdInteger(node, "maxItems");
    array.uniqueItems = pdBoolean(node, "uniqueItems") === true ? true : null;
    array.example = node.example;
    array.ext = pdExtensions(node);
    return array;
  }

  const property = buildProperty(node, type, format);
  if (!property) return null;
  property.xml = xml;
  property.description = description;
  return property;
}

/** `SwaggerDeserializer.property`: infers a missing type from `enum`. */
function readModelProperty(node: JsonRecord): V1Property | null {
  if (node.type === undefined && Array.isArray(node.enum)) {
    const first = node.enum[0];
    const inferred =
      node.enum.length === 0
        ? "string"
        : typeof first === "boolean"
          ? "boolean"
          : typeof first === "number"
            ? "number"
            : "string";
    return readProperty({ ...node, type: inferred });
  }
  return readProperty(node);
}

/* -------------------------------------------------------------------------- */
/* Step 1b: everything else (swagger-parser v1 `SwaggerDeserializer`)         */
/* -------------------------------------------------------------------------- */

function readExternalDocs(node: JsonRecord | null): V1ExternalDocs | null {
  if (!node) return null;
  return {
    description: readString(node, "description"),
    url: readString(node, "url"),
    ext: readExtensions(node),
  };
}

/** Model properties; an empty map is dropped, as in Swagger's output. */
function readModelProperties(
  node: JsonRecord,
): Record<string, V1Property> | null {
  const properties = readObject(node, "properties");
  if (!properties) return null;
  const output: Record<string, V1Property> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (!isRecord(value)) continue;
    const property = readModelProperty(value);
    if (property) output[name] = property;
  }
  return Object.keys(output).length > 0 ? output : null;
}

function markRequired(
  node: JsonRecord,
  properties: Record<string, V1Property> | null,
) {
  const required = readArray(node, "required");
  if (!required || !properties) return;
  for (const name of required) {
    if (typeof name === "string" && properties[name]) {
      properties[name].required = true;
    }
  }
}

function readModel(node: JsonRecord): V1Model {
  if (node.$ref !== undefined) {
    return {
      kind: "ref",
      ref: normalizeRef("definitions", asText(node.$ref)),
    };
  }

  if (node.allOf !== undefined) {
    const allOf = Array.isArray(node.allOf)
      ? node.allOf.filter(isRecord).map(readModel)
      : [];
    const properties = readModelProperties(node);
    markRequired(node, properties);
    return {
      kind: "composed",
      title: readString(node, "title"),
      description: readString(node, "description"),
      allOf,
      properties,
      ext: readExtensions(node),
      source: node,
    };
  }

  const type = readString(node, "type");
  const example = node.example;
  if (type === "array" || node.items !== undefined) {
    const items = readObject(node, "items");
    return {
      kind: "array",
      title: readString(node, "title"),
      description: readString(node, "description"),
      example,
      items: items ? readModelProperty(items) : null,
      minItems: readInteger(node, "minItems"),
      maxItems: readInteger(node, "maxItems"),
      uniqueItems: readBoolean(node, "uniqueItems"),
      xml: readXml(node),
      properties: readModelProperties(node),
      ext: readExtensions(node),
      source: node,
    };
  }

  let additionalProperties: V1Property | null = null;
  if (isRecord(node.additionalProperties)) {
    additionalProperties = readProperty(node.additionalProperties);
  } else if (typeof node.additionalProperties === "boolean") {
    additionalProperties = emptyProperty("BooleanValue", null);
    additionalProperties.booleanValue = node.additionalProperties;
  }

  const enumValues = readArray(node, "enum");
  const properties = readModelProperties(node);
  markRequired(node, properties);
  return {
    kind: "impl",
    type,
    format: readString(node, "format"),
    title: readString(node, "title"),
    description: readString(node, "description"),
    example,
    default: readString(node, "default"),
    enum: nonEmpty(
      (enumValues ?? [])
        .filter((value) => typeof value !== "object" || value === null)
        .map(asText),
    ),
    minimum: readNumber(node, "minimum"),
    maximum: readNumber(node, "maximum"),
    exclusiveMinimum: readBoolean(node, "exclusiveMinimum"),
    exclusiveMaximum: readBoolean(node, "exclusiveMaximum"),
    multipleOf: readNumber(node, "multipleOf"),
    pattern: readString(node, "pattern"),
    minLength: readInteger(node, "minLength"),
    maxLength: readInteger(node, "maxLength"),
    uniqueItems: readBoolean(node, "uniqueItems"),
    xml: readXml(node),
    externalDocs: readExternalDocs(readObject(node, "externalDocs")),
    discriminator: readString(node, "discriminator"),
    properties,
    additionalProperties,
    ext: readExtensions(node),
    source: node,
  };
}

const SERIALIZABLE_LOCATIONS = new Set(["query", "header", "path", "formData"]);

function readParameter(node: JsonRecord): V1Parameter | null {
  if (node.$ref !== undefined) {
    if (typeof node.$ref !== "string") return null;
    return {
      kind: "ref",
      ref: normalizeRef("parameters", node.$ref),
      in: null,
      name: null,
      required: false,
      ext: {},
    };
  }

  const location = readString(node, "in");
  if (location === null) return null;
  const name = readString(node, "name");
  const description = readString(node, "description");
  const required = readBoolean(node, "required") ?? false;

  if (location === "body") {
    const schema = node.schema;
    return {
      kind: "body",
      in: "body",
      name,
      description,
      required,
      schema: isRecord(schema) ? readModel(schema) : null,
      examples: readObject(node, "examples"),
      ext: readExtensions(node),
    };
  }

  if (!SERIALIZABLE_LOCATIONS.has(location)) return null;

  const rawType = readString(node, "type");
  const rawFormat = readString(node, "format");
  const defaultArray = rawType === "array" ? readArray(node, "default") : null;
  const parameter: V1SerializableParameter = {
    kind: "serializable",
    in: location as V1SerializableParameter["in"],
    name,
    description,
    required,
    type: null,
    format: null,
    defaultValue:
      rawType === "array"
        ? defaultArray
          ? JSON.stringify(defaultArray)
          : null
        : readString(node, "default"),
    maximum: readNumber(node, "maximum"),
    exclusiveMaximum: readBoolean(node, "exclusiveMaximum"),
    minimum: readNumber(node, "minimum"),
    exclusiveMinimum: readBoolean(node, "exclusiveMinimum"),
    maxLength: readInteger(node, "maxLength"),
    minLength: readInteger(node, "minLength"),
    pattern: readString(node, "pattern"),
    maxItems: readInteger(node, "maxItems"),
    minItems: readInteger(node, "minItems"),
    multipleOf: readNumber(node, "multipleOf"),
    uniqueItems: readBoolean(node, "uniqueItems"),
    enum: null,
    readOnly: readBoolean(node, "readOnly"),
    allowEmptyValue: readBoolean(node, "allowEmptyValue"),
    items: null,
    collectionFormat: null,
    ext: readExtensions(node),
    source: node,
  };

  const enumValues = readArray(node, "enum");
  if (enumValues) {
    parameter.enum = enumValues
      .filter((value) => typeof value !== "object" || value === null)
      .map(asText);
  }

  // `sp.setProperty(PropertyBuilder.build(type, format, ...))`
  const property = buildProperty(
    {
      ...(parameter.enum ? { enum: enumValues } : {}),
      ...(node.default !== undefined ? { default: node.default } : {}),
    },
    rawType,
    rawFormat,
  );
  if (property) {
    parameter.type = property.type;
    parameter.format = property.format;
    // String and Email properties share the parameter's own enum list, and
    // the other classes don't touch it, so only these cases change it.
    if (property.cls === "ByteArray") {
      parameter.enum = null;
    } else if (
      property.cls === "Integer" ||
      property.cls === "Long" ||
      property.cls === "Float" ||
      property.cls === "Double"
    ) {
      // Swagger quirk: the enum round-trips through Integer/Float/Double,
      // so `2` becomes "2.0" for float parameters.
      parameter.enum = property.enum
        ? property.enum.map((value) =>
            property.cls === "Float" || property.cls === "Double"
              ? javaDoubleToString(value as number)
              : String(value),
          )
        : null;
    }
    const items = readObject(node, "items");
    if (items) parameter.items = readProperty(items);
  }

  parameter.collectionFormat = readString(node, "collectionFormat");
  return parameter;
}

function readParameters(list: unknown): V1Parameter[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter(isRecord)
    .map(readParameter)
    .filter((parameter): parameter is V1Parameter => parameter !== null);
}

function readResponse(node: JsonRecord | null): V1Response | null {
  if (!node) return null;
  if (node.$ref !== undefined) {
    if (typeof node.$ref !== "string") return null;
    return { kind: "ref", ref: normalizeRef("responses", node.$ref) };
  }

  let schema: V1Model | null = null;
  const schemaNode = readObject(node, "schema");
  if (schemaNode) {
    schema =
      typeof schemaNode.$ref === "string"
        ? { kind: "ref", ref: normalizeRef("definitions", schemaNode.$ref) }
        : schemaNode.$ref !== undefined
          ? null
          : readModel(schemaNode);
  }

  let headers: Record<string, V1Property | null> | null = null;
  const headersNode = readObject(node, "headers");
  if (headersNode) {
    headers = {};
    for (const [name, value] of Object.entries(headersNode)) {
      headers[name] = readProperty(value);
    }
  }

  return {
    kind: "response",
    description: readString(node, "description"),
    schema,
    headers,
    examples: readObject(node, "examples"),
    ext: readExtensions(node),
  };
}

function readResponses(
  node: JsonRecord | null,
): Record<string, V1Response | null> | null {
  if (!node) return null;
  const output: Record<string, V1Response | null> = {};
  for (const key of Object.keys(node)) {
    if (key.startsWith("x-")) continue;
    output[key] = readResponse(readObject(node, key));
  }
  return output;
}

function readSecurity(node: JsonRecord, key: string) {
  const array = readArray(node, key);
  if (!array) return null;
  return array.map((item) => {
    const requirement: Record<string, string[]> = {};
    if (isRecord(item)) {
      for (const name of Object.keys(item)) {
        requirement[name] = readStringList(item, name) ?? [];
      }
    }
    return requirement;
  });
}

function readOperation(node: JsonRecord): V1Operation {
  const tags = readArray(node, "tags");
  return {
    tags: tags
      ? tags.filter((tag): tag is string => typeof tag === "string")
      : null,
    summary: readString(node, "summary"),
    description: readString(node, "description"),
    externalDocs: readExternalDocs(readObject(node, "externalDocs")),
    operationId: readString(node, "operationId"),
    consumes: readStringList(node, "consumes"),
    produces: readStringList(node, "produces"),
    parameters: readParameters(node.parameters),
    responses: readResponses(readObject(node, "responses")),
    deprecated: readBoolean(node, "deprecated"),
    security: readSecurity(node, "security"),
    ext: readExtensions(node),
    source: node,
  };
}

function readPath(node: JsonRecord): V1Path | null {
  if (node.$ref !== undefined) {
    return typeof node.$ref === "string"
      ? { kind: "ref", ref: node.$ref }
      : null;
  }
  const operations: V1PlainPath["operations"] = {};
  for (const method of V1_OPERATION_KEYS) {
    const operation = readObject(node, method);
    if (operation) operations[method] = readOperation(operation);
  }
  return {
    kind: "path",
    parameters: readParameters(node.parameters),
    operations,
    ext: readExtensions(node),
  };
}

function readSecurityScheme(node: JsonRecord): V1SecurityScheme | null {
  const type = readString(node, "type");
  const description =
    typeof node.description === "string" ? node.description : null;
  const base = {
    description,
    name: null,
    in: null,
    flow: null,
    authorizationUrl: null,
    tokenUrl: null,
    scopes: null,
    ext: readExtensions(node),
  };
  if (type === "basic") return { ...base, type };
  if (type === "apiKey") {
    const name = readString(node, "name");
    const location = readString(node, "in");
    if (name === null || (location !== "header" && location !== "query")) {
      return null;
    }
    return { ...base, type, name, in: location };
  }
  if (type === "oauth2") {
    const scopes: Record<string, string> = {};
    if (isRecord(node.scopes)) {
      for (const [scope, label] of Object.entries(node.scopes)) {
        scopes[scope] = asText(label);
      }
    }
    return {
      ...base,
      type,
      flow: readString(node, "flow"),
      authorizationUrl: readString(node, "authorizationUrl"),
      tokenUrl: readString(node, "tokenUrl"),
      scopes: isRecord(node.scopes) ? scopes : null,
    };
  }
  return null;
}

const V1_SCHEMES = ["http", "https", "ws", "wss"];

/** Known schemes, lower-cased and de-duplicated, as Swagger keeps them. */
function readSchemes(node: JsonRecord): string[] | null {
  const schemes = readArray(node, "schemes");
  if (!schemes) return null;
  return [
    ...new Set(
      schemes
        .filter((scheme): scheme is string => typeof scheme === "string")
        .map((scheme) => scheme.toLowerCase())
        .filter((scheme) => V1_SCHEMES.includes(scheme)),
    ),
  ];
}

function readSwagger(node: JsonRecord): V1Swagger {
  const info = readObject(node, "info");
  const contact = info ? readObject(info, "contact") : null;
  const license = info ? readObject(info, "license") : null;

  const paths: Record<string, V1Path> = {};
  for (const [name, value] of Object.entries(readObject(node, "paths") ?? {})) {
    if (name.startsWith("x-") || !isRecord(value)) continue;
    const path = readPath(value);
    if (path) paths[name] = path;
  }

  let definitions: Record<string, V1Model> | null = null;
  const definitionsNode = readObject(node, "definitions");
  if (definitionsNode) {
    definitions = {};
    for (const [name, value] of Object.entries(definitionsNode)) {
      if (isRecord(value)) definitions[name] = readModel(value);
    }
  }

  let parameters: Record<string, V1Parameter> | null = null;
  const parametersNode = readObject(node, "parameters");
  if (parametersNode) {
    parameters = {};
    for (const [name, value] of Object.entries(parametersNode)) {
      if (!isRecord(value)) continue;
      const parameter = readParameter(value);
      if (parameter) parameters[name] = parameter;
    }
  }

  let securityDefinitions: Record<string, V1SecurityScheme> | null = null;
  const securityNode = readObject(node, "securityDefinitions");
  if (securityNode) {
    securityDefinitions = {};
    for (const [name, value] of Object.entries(securityNode)) {
      const scheme = isRecord(value) ? readSecurityScheme(value) : null;
      if (scheme) securityDefinitions[name] = scheme;
    }
  }

  const tags = readArray(node, "tags");
  const ext = readExtensions(node);

  return {
    swagger: readString(node, "swagger"),
    info: info
      ? {
          title: readString(info, "title"),
          description: readString(info, "description"),
          termsOfService: readString(info, "termsOfService"),
          contact: contact
            ? {
                name: readString(contact, "name"),
                url: readString(contact, "url"),
                email: readString(contact, "email"),
                ext: readExtensions(contact),
              }
            : null,
          license: license
            ? {
                name: readString(license, "name"),
                url: readString(license, "url"),
                ext: readExtensions(license),
              }
            : null,
          version: readString(info, "version"),
          ext: readExtensions(info),
        }
      : null,
    host: readString(node, "host"),
    basePath: readString(node, "basePath"),
    schemes: readSchemes(node),
    consumes: readStringList(node, "consumes"),
    produces: readStringList(node, "produces"),
    paths,
    definitions,
    parameters,
    responses: readResponses(readObject(node, "responses")),
    securityDefinitions,
    security: readSecurity(node, "security"),
    tags: tags
      ? tags.filter(isRecord).map((tag) => ({
          name: readString(tag, "name"),
          description: readString(tag, "description"),
          externalDocs: readExternalDocs(readObject(tag, "externalDocs")),
          ext: readExtensions(tag),
        }))
      : null,
    externalDocs: readExternalDocs(readObject(node, "externalDocs")),
    ext: Object.keys(ext).length > 0 ? ext : null,
    pathsExt: readExtensions(readObject(node, "paths") ?? {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Step 2: resolve local refs (swagger-parser v1 `SwaggerResolver`)           */
/* -------------------------------------------------------------------------- */

function resolveParameters(
  parameters: V1Parameter[],
  swagger: V1Swagger,
): V1Parameter[] {
  const processed: V1Parameter[] = [];
  const overrides: V1Parameter[] = [];

  for (const parameter of parameters) {
    if (parameter.kind !== "ref") {
      processed.push(parameter);
      continue;
    }
    const resolved = resolveLocalRef(parameter.ref, "parameters", swagger.parameters);
    if (!resolved) {
      processed.push(parameter);
      continue;
    }
    // A referenced parameter replaces one with the same name ("ref wins").
    const matched =
      resolved.name !== null &&
      (processed.some((item) => item.name === resolved.name) ||
        parameters.some((item) => item.name === resolved.name));
    if (matched) {
      overrides.push(resolved);
    } else {
      processed.push(resolved);
    }
  }

  for (const resolved of overrides) {
    const index = processed.findIndex((item) => item.name === resolved.name);
    if (index >= 0) processed[index] = resolved;
  }
  return processed;
}

function resolveOperation(operation: V1Operation, swagger: V1Swagger) {
  operation.parameters = resolveParameters(operation.parameters, swagger);
  if (!operation.responses) return;
  for (const [code, response] of Object.entries(operation.responses)) {
    if (response?.kind !== "ref") continue;
    const resolved = resolveLocalRef(response.ref, "responses", swagger.responses);
    if (resolved) operation.responses[code] = resolved;
  }
}

function resolveSwagger(swagger: V1Swagger) {
  for (const [name, entry] of Object.entries(swagger.paths)) {
    let path = entry;
    if (path.kind === "ref") {
      // `#/paths/...` refs are replaced by the (shared) path they point to.
      const resolved = resolveLocalRef(path.ref, "paths", swagger.paths);
      if (!resolved || resolved.kind !== "path") continue;
      swagger.paths[name] = resolved;
      path = resolved;
      for (const method of V1_OPERATION_KEYS) {
        const operation = path.operations[method];
        if (operation) resolveOperation(operation, swagger);
      }
      continue;
    }

    // Path-level parameters are copied to the front of every operation
    // unless the operation already has one with the same `in` and name.
    const shared = path.parameters;
    if (shared) {
      for (const method of V1_OPERATION_KEYS) {
        const operation = path.operations[method];
        if (!operation) continue;
        const added = shared.filter(
          (candidate) =>
            !operation.parameters.some(
              (existing) =>
                candidate.in !== null &&
                candidate.in === existing.in &&
                candidate.name === existing.name,
            ),
        );
        operation.parameters = [...added, ...operation.parameters];
      }
    }
    path.parameters = null;

    for (const method of V1_OPERATION_KEYS) {
      const operation = path.operations[method];
      if (operation) resolveOperation(operation, swagger);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Step 3a: OpenAPI 3 schemas (swagger-core v3 `Schema` and its subclasses)   */
/* -------------------------------------------------------------------------- */

type SchemaClass =
  | "Schema"
  | "String"
  | "Email"
  | "Password"
  | "Integer"
  | "Number"
  | "Boolean"
  | "Date"
  | "DateTime"
  | "UUID"
  | "ByteArray"
  | "Binary"
  | "Object"
  | "Map"
  | "Array"
  | "Composed"
  | "File";

/** Jackson's property order for swagger-core's `Schema` (3.0 output). */
const SCHEMA_KEYS = [
  "title",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxProperties",
  "minProperties",
  "required",
  "type",
  "not",
  "properties",
  "additionalProperties",
  "description",
  "format",
  "$ref",
  "nullable",
  "readOnly",
  "writeOnly",
  "example",
  "externalDocs",
  "deprecated",
  "xml",
  "discriminator",
  "allOf",
  "anyOf",
  "oneOf",
  "items",
  "default",
  "enum",
] as const;

type SchemaKey = (typeof SCHEMA_KEYS)[number];

class Schema3 {
  readonly fields: Partial<Record<SchemaKey, unknown>> = {};
  ext: Ext | null = null;
  booleanValue: boolean | null = null;

  constructor(
    readonly cls: SchemaClass,
    type: string | null = null,
    format: string | null = null,
  ) {
    this.set("type", type);
    this.set("format", format);
  }

  set(key: SchemaKey, value: unknown) {
    if (value === undefined || value === null) {
      delete this.fields[key];
    } else {
      this.fields[key] = value;
    }
  }

  setDefault(value: unknown) {
    this.set("default", castSchemaValue(this.cls, value));
  }

  setExample(value: unknown) {
    // swagger-core's DateSchema mixin prints examples as yyyy-MM-dd.
    this.set(
      "example",
      this.cls === "Date" && !keepsOriginal(this.cls, value)
        ? castDateExample(value)
        : castSchemaValue(this.cls, value),
    );
  }

  /**
   * An enum read through Jackson (`cast`), or set as-is. Jackson also moves
   * date-times to UTC, which a plain `cast` does not.
   */
  setEnum(values: unknown[] | null | undefined, cast = true) {
    this.set(
      "enum",
      values
        ? values.map((value) =>
            !cast
              ? value
              : this.cls === "DateTime" && !keepsOriginal(this.cls, value)
                ? castDateTime(value, true)
                : castSchemaValue(this.cls, value),
          )
        : null,
    );
  }

  addEnum(value: unknown) {
    const current = (this.fields.enum as unknown[] | undefined) ?? [];
    this.fields.enum = [...current, castSchemaValue(this.cls, value)];
  }
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** `DateSchema.cast` + Jackson's `java.util.Date` output. */
function castDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)-(\d+)-(\d+)$/.exec(value);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (Number.isNaN(date.getTime())) return null;
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )}T00:00:00.000+00:00`;
}

/** `DateSchema` writes examples as `yyyy-MM-dd`. */
function castDateExample(value: unknown): string | null {
  const cast = castDate(value);
  return cast ? cast.slice(0, 10) : null;
}

/**
 * `OffsetDateTime.parse` + Jackson output. Values Jackson deserializes itself
 * are moved to UTC (`toUtc`); values from `cast` keep their offset.
 */
function castDateTime(value: unknown, toUtc = false): string | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([Zz]|[+-]\d{2}:\d{2}(?::\d{2})?)$/.exec(
      value,
    );
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", fraction = "", zone] =
    match;
  let offsetSeconds = 0;
  if (zone !== "Z" && zone !== "z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const [h, m, s = "0"] = zone.slice(1).split(":");
    if (Number(h) > 18 || Number(m) > 59 || Number(s) > 59) return null;
    offsetSeconds = sign * (Number(h) * 3600 + Number(m) * 60 + Number(s));
  }

  // OffsetDateTime.parse is strict: no Feb 30th or 25 o'clock.
  const local = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const check = new Date(local);
  if (
    check.getUTCMonth() !== Number(month) - 1 ||
    check.getUTCDate() !== Number(day) ||
    check.getUTCHours() !== Number(hour) ||
    check.getUTCMinutes() !== Number(minute) ||
    check.getUTCSeconds() !== Number(second)
  ) {
    return null;
  }

  const date = new Date(toUtc ? local - offsetSeconds * 1000 : local);
  const nanos = fraction.padEnd(9, "0").replace(/0+$/, "");
  let offset = "Z";
  if (!toUtc && offsetSeconds !== 0) {
    const total = Math.abs(offsetSeconds);
    const seconds = total % 60;
    offset = `${offsetSeconds < 0 ? "-" : "+"}${pad(Math.floor(total / 3600))}:${pad(
      Math.floor((total % 3600) / 60),
    )}${seconds ? `:${pad(seconds)}` : ""}`;
  }
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(
    date.getUTCSeconds(),
  )}${nanos ? `.${nanos}` : ""}${offset}`;
}

function castUuid(value: unknown): string | null {
  const match =
    /^([0-9a-f]{1,8})-([0-9a-f]{1,4})-([0-9a-f]{1,4})-([0-9a-f]{1,4})-([0-9a-f]{1,12})$/i.exec(
      javaToString(value),
    );
  if (!match) return null;
  const widths = [8, 4, 4, 4, 12];
  return match
    .slice(1)
    .map((part, index) => part.toLowerCase().padStart(widths[index], "0"))
    .join("-");
}

/** Each swagger-core schema subclass coerces default/enum/example values. */
/**
 * Values the bug-fixing mode passes through unchanged. Fix 2: date and
 * date-time text (Swagger turns dates into timestamps and moves date-times to
 * UTC). Fix 5: objects and arrays on string schemas (Swagger stores Java's
 * `toString()`, e.g. `{a=1}`).
 */
function keepsOriginal(cls: SchemaClass, value: unknown): boolean {
  if (!fixBugs) return false;
  if (cls === "Date" || cls === "DateTime") return typeof value === "string";
  if (cls === "String" || cls === "Email" || cls === "Password") {
    return typeof value === "object" && value !== null;
  }
  return false;
}

function castSchemaValue(cls: SchemaClass, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (keepsOriginal(cls, value)) return value;
  switch (cls) {
    case "String":
    case "Email":
    case "Password":
      return javaToString(value);
    case "Integer": {
      const text = javaToString(value);
      return /^-?\d+$/.test(text) && Math.abs(Number(text)) < 2 ** 63
        ? Number(text)
        : null;
    }
    case "Number": {
      const text = javaToString(value);
      return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)
        ? Number(text)
        : null;
    }
    case "Boolean":
      return javaToString(value).toLowerCase() === "true";
    case "Date":
      return castDate(value);
    case "DateTime":
      return castDateTime(value);
    case "UUID":
      return castUuid(value);
    default:
      return value;
  }
}

/** swagger-core v3 `ModelDeserializer`: picks the schema class. */
function schemaClassFor(
  type: string | null,
  format: string | null,
  hasAdditionalProperties: boolean,
): SchemaClass {
  if (type === "array") return "Array";
  if (type === "integer") return "Integer";
  if (type === "number") return "Number";
  if (type === "boolean") return "Boolean";
  if (type === "string") {
    if (format === "date") return "Date";
    if (format === "date-time") return "DateTime";
    if (format === "email") return "Email";
    if (format === "password") return "Password";
    if (format === "uuid") return "UUID";
    return "String";
  }
  if (type === "object" || type === null) {
    return hasAdditionalProperties ? "Map" : "Object";
  }
  return "Schema";
}

/** swagger-parser v3 `SchemaTypeUtil.createSchema`. */
function schemaClassForParameter(
  type: string | null,
  format: string | null,
): SchemaClass {
  switch (type) {
    case "integer":
      return "Integer";
    case "number":
      return "Number";
    case "boolean":
      return "Boolean";
    case "object":
      return "Object";
    case "string":
      switch (format) {
        case "byte":
          return "ByteArray";
        case "binary":
          return "Binary";
        case "date":
          return "Date";
        case "date-time":
          return "DateTime";
        case "password":
          return "Password";
        case "email":
          return "Email";
        case "uuid":
          return "UUID";
        default:
          return "String";
      }
    default:
      return "Schema";
  }
}

/** swagger-core v3 `PrimitiveType.fromTypeAndFormat(...).createProperty()`. */
function primitiveSchema(
  type: string | null,
  format: string | null,
): Schema3 | null {
  if (type === "object") return null;
  const key = `${type?.trim() ? type : ""}_${format?.trim() ? format : ""}`;
  switch (key) {
    case "integer_":
    case "integer_int32":
      return new Schema3("Integer", "integer", "int32");
    case "integer_int64":
      return new Schema3("Integer", "integer", "int64");
    case "number_":
      return new Schema3("Number", "number");
    case "number_float":
      return new Schema3("Number", "number", "float");
    case "number_double":
      return new Schema3("Number", "number", "double");
    case "string_":
      return new Schema3("String", "string");
    case "string_byte":
      return new Schema3("ByteArray", "string", "byte");
    case "string_email":
      return new Schema3("String", "string", "email");
    case "string_binary":
      return new Schema3("Binary", "string", "binary");
    case "string_uri":
      return new Schema3("String", "string", "uri");
    case "string_url":
      return new Schema3("String", "string", "url");
    case "string_uuid":
      return new Schema3("UUID", "string", "uuid");
    case "string_date":
      return new Schema3("Date", "string", "date");
    case "string_date-time":
      return new Schema3("DateTime", "string", "date-time");
    case "string_partial-time":
      return new Schema3("String", "string", "partial-time");
    case "boolean_":
      return new Schema3("Boolean", "boolean");
    default:
      return null;
  }
}

function requiredNames(
  properties: Record<string, V1Property> | null,
): string[] | null {
  if (!properties) return null;
  const names = Object.keys(properties)
    .filter((name) => properties[name].required)
    .sort();
  return names.length > 0 ? names : null;
}

function convertXml(xml: V1Xml | null): JsonRecord | null {
  if (!xml) return null;
  const output: JsonRecord = {};
  for (const key of ["name", "namespace", "prefix", "attribute", "wrapped"] as const) {
    if (xml[key] !== undefined) output[key] = xml[key];
  }
  return output;
}

function convertProperties(
  properties: Record<string, V1Property> | null,
): Record<string, Schema3> | null {
  if (!properties) return null;
  const output: Record<string, Schema3> = {};
  for (const [name, property] of Object.entries(properties)) {
    const schema = convertProperty(property);
    if (schema) output[name] = schema;
  }
  return output;
}

const PROPERTY_DEFAULT_CLASSES = new Set<PropertyClass>([
  "String",
  "Email",
  "ByteArray",
  "UUID",
  "Integer",
  "Long",
  "Float",
  "Double",
  "Boolean",
]);

const PROPERTY_ENUM_CLASSES = new Set<PropertyClass>([
  "String",
  "Email",
  "ByteArray",
  "UUID",
  "Integer",
  "Long",
  "Float",
  "Double",
  "Date",
  "DateTime",
]);

const STRING_PROPERTY_CLASSES = new Set<PropertyClass>([
  "String",
  "Email",
  "ByteArray",
  "UUID",
]);

/**
 * Swagger reads property examples as text, so an object or array example
 * becomes "". Fix 5: keep the JSON value.
 */
function propertyExample(property: V1Property): unknown {
  const raw = property.source?.example;
  if (fixBugs && typeof raw === "object" && raw !== null) return raw;
  return property.example;
}

/** Fix 7: classes whose default Swagger drops, and those whose enum it drops. */
const DROPPED_DEFAULT_CLASSES = new Set<PropertyClass>([
  "BaseInteger",
  "Decimal",
  "Date",
  "DateTime",
]);
const DROPPED_ENUM_CLASSES = new Set<PropertyClass>([
  "BaseInteger",
  "Decimal",
  "Boolean",
]);

/** A value of the schema's type, or null when it doesn't fit. */
function typedValue(cls: SchemaClass, value: unknown): unknown {
  if (cls === "Boolean") {
    if (typeof value === "boolean") return value;
    return typeof value === "string" && /^(true|false)$/i.test(value)
      ? value.toLowerCase() === "true"
      : null;
  }
  return castSchemaValue(cls, value);
}

/**
 * Fix 7: Swagger's property classes for integer/number without a known
 * format, booleans, and dates have no slot for some of default/enum, so it
 * drops them. Put them back, typed for the schema.
 */
function restoreDroppedValues(property: V1Property, schema: Schema3) {
  const source = property.source;
  if (!source) return;
  if (DROPPED_DEFAULT_CLASSES.has(property.cls) && source.default !== undefined) {
    schema.set("default", typedValue(schema.cls, source.default));
  }
  if (DROPPED_ENUM_CLASSES.has(property.cls) && Array.isArray(source.enum)) {
    schema.set(
      "enum",
      nonEmpty(
        source.enum
          .map((value) => typedValue(schema.cls, value))
          .filter((value) => value !== null),
      ),
    );
  }
}

/** `SwaggerConverter.convert(Property)`. */
function convertProperty(property: V1Property | null | undefined): Schema3 | null {
  if (!property) return null;
  if (property.cls === "BooleanValue") {
    const schema = new Schema3("Schema");
    schema.booleanValue = property.booleanValue;
    return schema;
  }

  let schema: Schema3;
  if (property.cls === "Ref") {
    schema = new Schema3("Schema");
    schema.set("$ref", schemaRef(property.ref ?? ""));
  } else if (property.cls === "Array") {
    schema = new Schema3("Array", "array");
    schema.set("title", property.title);
    schema.set("description", property.description);
    schema.set("readOnly", property.readOnly);
    schema.set("example", property.example);
    schema.set("xml", convertXml(property.xml));
    schema.set("items", convertProperty(property.items));
    schema.set("maxItems", property.maxItems);
    schema.set("minItems", property.minItems);
    if (property.uniqueItems) schema.set("uniqueItems", true);
  } else if (property.cls === "File") {
    // Fix 1: "file" isn't an OpenAPI 3 type.
    schema = fixBugs
      ? new Schema3("File", "string", "binary")
      : new Schema3("File", property.type, property.format ?? "binary");
    schema.set("title", property.title);
    schema.set("description", property.description);
    schema.set("readOnly", property.readOnly);
    schema.set("example", property.example);
    schema.set("xml", convertXml(property.xml));
  } else {
    const isMap = property.cls === "Map";
    const cls =
      property.cls === "Composed"
        ? "Composed"
        : schemaClassFor(property.type, property.format, isMap);
    schema = new Schema3(
      cls,
      property.type ?? (cls === "Object" || cls === "Map" ? "object" : null),
      cls === "Integer" && !property.format?.trim() ? null : property.format,
    );
    schema.set("title", property.title);
    schema.set("description", property.description);
    schema.set("readOnly", property.readOnly);
    schema.set("xml", convertXml(property.xml));
    const example = propertyExample(property);
    if (example !== undefined) schema.setExample(example);
    if (PROPERTY_DEFAULT_CLASSES.has(property.cls)) {
      schema.setDefault(property.default);
    }
    if (PROPERTY_ENUM_CLASSES.has(property.cls)) schema.setEnum(property.enum);
    if (fixBugs) restoreDroppedValues(property, schema);
    if (NUMERIC_CLASSES.has(property.cls)) {
      schema.set("minimum", property.minimum);
      schema.set("maximum", property.maximum);
      schema.set("exclusiveMinimum", property.exclusiveMinimum);
      schema.set("exclusiveMaximum", property.exclusiveMaximum);
      schema.set("multipleOf", property.multipleOf);
    }
    if (STRING_PROPERTY_CLASSES.has(property.cls)) {
      schema.set("minLength", property.minLength);
      schema.set("maxLength", property.maxLength);
      schema.set("pattern", property.pattern);
    }
    if (property.cls === "Object") {
      schema.set("required", requiredNames(property.properties));
      schema.set("properties", convertProperties(property.properties));
    }
    if (property.cls === "Map") {
      const additional = property.additionalProperties;
      schema.set(
        "additionalProperties",
        additional?.cls === "BooleanValue"
          ? additional.booleanValue
          : convertProperty(additional),
      );
      schema.set("minProperties", property.minProperties);
      schema.set("maxProperties", property.maxProperties);
    }
    if (property.cls === "Composed") {
      schema.set(
        "allOf",
        (property.allOf ?? [])
          .map(convertProperty)
          .filter((item): item is Schema3 => item !== null),
      );
    }
  }

  // The Ref branch has an empty extension map, so this is a no-op for it.
  schema.set("nullable", readNullable(property.ext));
  schema.ext = stripExtensions(property.ext);
  return schema;
}

/** `SwaggerConverter.convert(Model)`. */
function convertModel(model: V1Model | null): Schema3 | null {
  if (!model) return null;
  let schema: Schema3;

  if (model.kind === "ref") {
    schema = new Schema3("Schema");
    schema.set("$ref", schemaRef(model.ref));
    return schema;
  }

  if (model.kind === "array") {
    schema = new Schema3("Array", "array");
    schema.set("title", model.title);
    schema.set("description", model.description);
    schema.set("example", model.example);
    schema.set("xml", convertXml(model.xml));
    schema.set("maxItems", model.maxItems);
    schema.set("minItems", model.minItems);
    schema.set("uniqueItems", model.uniqueItems);
    schema.set("properties", convertProperties(model.properties));
    schema.set("items", convertProperty(model.items));
    schema.ext = model.ext;
    if (fixBugs) restoreModelKeywords(model.source, schema, false);
  } else if (model.kind === "composed") {
    schema = new Schema3("Composed");
    schema.set("description", model.description);
    schema.set("title", model.title);
    // Swagger quirk: this strips x-nullable before it is read below.
    schema.ext = stripExtensions(model.ext);
    schema.set(
      "allOf",
      model.allOf
        .map(convertModel)
        .filter((item): item is Schema3 => item !== null),
    );
    schema.set("required", requiredNames(model.properties));
    schema.set("properties", convertProperties(model.properties));
    if (fixBugs) {
      // Fix 8: Swagger's allOf model has no slot for these.
      restoreModelKeywords(model.source, schema, true);
      if (model.source.example !== undefined) {
        schema.set("example", model.source.example);
      }
      schema.set(
        "externalDocs",
        convertExternalDocs(readExternalDocs(readObject(model.source, "externalDocs"))),
      );
      const discriminator = readString(model.source, "discriminator");
      if (discriminator !== null) {
        schema.set("discriminator", { propertyName: discriminator });
      }
    }
  } else {
    // Swagger quirk: the discriminator is cleared on the source model, so a
    // second conversion of the same inline schema loses it (fix 6).
    const discriminator = model.discriminator;
    if (!fixBugs) model.discriminator = null;

    const hasAdditional = model.additionalProperties !== null;
    schema =
      model.type === "file"
        ? fixBugs
          ? new Schema3("File", "string", "binary") // Fix 1
          : new Schema3("File", "file", model.format ?? "binary")
        : new Schema3(
            schemaClassFor(model.type, model.format, hasAdditional),
            model.type ?? "object",
            model.type === "integer" && !model.format?.trim() ? null : model.format,
          );
    schema.set("title", model.title);
    schema.set("description", model.description);
    schema.set("minimum", model.minimum);
    schema.set("maximum", model.maximum);
    schema.set("exclusiveMinimum", model.exclusiveMinimum);
    schema.set("exclusiveMaximum", model.exclusiveMaximum);
    schema.set("multipleOf", model.multipleOf);
    schema.set("pattern", model.pattern);
    schema.set("minLength", model.minLength);
    schema.set("maxLength", model.maxLength);
    schema.set("uniqueItems", model.uniqueItems);
    schema.set("xml", convertXml(model.xml));
    schema.set("externalDocs", convertExternalDocs(model.externalDocs));
    schema.set("required", requiredNames(model.properties));
    schema.set("properties", convertProperties(model.properties));
    if (model.example !== undefined) schema.setExample(model.example);
    schema.setDefault(modelDefault(model));
    schema.setEnum(model.enum);

    const additional = model.additionalProperties;
    if (additional) {
      schema.set(
        "additionalProperties",
        additional.cls === "BooleanValue"
          ? additional.booleanValue
          : convertProperty(additional),
      );
    }
    if (discriminator !== null) {
      schema.set("discriminator", { propertyName: discriminator });
    }
    schema.ext = model.ext;
    if (fixBugs) restoreModelKeywords(model.source, schema, true);
  }

  schema.set("nullable", readNullable(model.ext));
  return schema;
}

/**
 * Fix 8: keywords Swagger's v1 models don't read. `minProperties` and
 * `maxProperties` only apply to object-like models.
 */
function restoreModelKeywords(
  source: JsonRecord,
  schema: Schema3,
  objectLike: boolean,
) {
  schema.set("readOnly", readBoolean(source, "readOnly"));
  if (objectLike) {
    schema.set("minProperties", readInteger(source, "minProperties"));
    schema.set("maxProperties", readInteger(source, "maxProperties"));
  }
}

/** `ModelImpl.getDefaultValue`: typed for integer/number models. */
function modelDefault(model: V1ModelImpl): unknown {
  const value = model.default;
  if (value === null) return null;
  if (model.type === "integer") return parseJavaInteger(value, 32);
  if (model.type === "number") {
    return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)
      ? Number(value)
      : null;
  }
  return value;
}

function convertFileSchema(schema: Schema3 | null): Schema3 | null {
  if (schema?.fields.type === "file") {
    schema.set("type", "string");
    schema.set("format", "binary");
  }
  return schema;
}

/* -------------------------------------------------------------------------- */
/* Step 3b: everything else (swagger-parser `SwaggerConverter`)               */
/* -------------------------------------------------------------------------- */

interface ConverterState {
  swagger: V1Swagger;
  globalConsumes: string[];
  globalProduces: string[];
  components: {
    schemas: Record<string, unknown> | null;
    responses: Record<string, unknown> | null;
    parameters: Record<string, unknown> | null;
    requestBodies: Record<string, unknown> | null;
    securitySchemes: Record<string, unknown> | null;
  };
}

/** Builds an object with keys in `order`, skipping null/undefined values. */
function ordered(
  values: JsonRecord,
  order: readonly string[],
  ext?: Ext | null,
): JsonRecord {
  const output: JsonRecord = {};
  for (const key of order) {
    const value = values[key];
    if (value !== undefined && value !== null) output[key] = value;
  }
  if (ext) {
    for (const [key, value] of Object.entries(ext)) output[key] = value;
  }
  return output;
}

function emitSchema(schema: Schema3): unknown {
  if (schema.booleanValue !== null) return schema.booleanValue;
  const values: JsonRecord = {};
  for (const key of SCHEMA_KEYS) {
    values[key] = emitValue(schema.fields[key]);
  }
  return ordered(values, SCHEMA_KEYS, schema.ext);
}

function emitValue(value: unknown): unknown {
  if (value instanceof Schema3) return emitSchema(value);
  if (Array.isArray(value)) return value.map(emitValue);
  if (isRecord(value) && Object.values(value).some((item) => item instanceof Schema3)) {
    const output: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) output[key] = emitValue(item);
    return output;
  }
  return value;
}

function convertExtensions(ext: Ext | null | undefined): Ext | null {
  return ext ? stripExtensions(ext) : null;
}

function convertExternalDocs(docs: V1ExternalDocs | null): JsonRecord | null {
  if (!docs) return null;
  const ext = stripExtensions(docs.ext);
  return ordered(
    { description: docs.description, url: docs.url },
    ["description", "url"],
    Object.keys(ext).length > 0 ? ext : null,
  );
}

function convertServers(swagger: V1Swagger): JsonRecord[] {
  let baseUrl = swagger.basePath ? swagger.basePath : "/";
  if (swagger.host) baseUrl = swagger.host + baseUrl;

  const schemes = swagger.schemes ?? [];
  if (!baseUrl.startsWith("/") && schemes.length > 0) {
    return schemes.map((scheme) => ({ url: `${scheme}://${baseUrl}` }));
  }
  if (!baseUrl.startsWith("/") && baseUrl !== "/") baseUrl = `//${baseUrl}`;
  return [{ url: baseUrl }];
}

function convertSecurityScheme(scheme: V1SecurityScheme): JsonRecord {
  const values: JsonRecord = { description: scheme.description };
  if (scheme.type === "basic") {
    values.type = "http";
    values.scheme = "basic";
  } else if (scheme.type === "apiKey") {
    values.type = "apiKey";
    values.name = scheme.name;
    values.in = scheme.in;
  } else {
    values.type = "oauth2";
    const flow: JsonRecord = {};
    const flows: JsonRecord = {};
    switch (scheme.flow) {
      case "implicit":
        flow.authorizationUrl = scheme.authorizationUrl;
        flows.implicit = flow;
        break;
      case "password":
        flow.tokenUrl = scheme.tokenUrl;
        flows.password = flow;
        break;
      case "application":
        flow.tokenUrl = scheme.tokenUrl;
        flows.clientCredentials = flow;
        break;
      case "accessCode":
        flow.authorizationUrl = scheme.authorizationUrl;
        flow.tokenUrl = scheme.tokenUrl;
        flows.authorizationCode = flow;
        break;
    }
    flow.scopes = { ...(scheme.scopes ?? {}) };
    const flowOrder = ["authorizationUrl", "tokenUrl", "refreshUrl", "scopes"];
    for (const key of Object.keys(flows)) {
      flows[key] = ordered(flows[key] as JsonRecord, flowOrder);
    }
    values.flows = ordered(flows, [
      "implicit",
      "password",
      "clientCredentials",
      "authorizationCode",
    ]);
  }
  return ordered(
    values,
    ["type", "description", "name", "$ref", "in", "scheme", "bearerFormat", "flows", "openIdConnectUrl"],
    stripExtensions(scheme.ext),
  );
}

/** `AbstractSerializableParameter.getDefault`: typed by parameter type. */
function parameterDefault(parameter: V1SerializableParameter): unknown {
  // Fix 3: Swagger keeps array defaults as JSON text.
  if (fixBugs && parameter.type === "array" && Array.isArray(parameter.source.default)) {
    return parameter.source.default;
  }
  const value = parameter.defaultValue;
  if (value === null || value === "") return null;
  if (parameter.type === "integer") {
    return parseJavaInteger(value, 64) ?? value;
  }
  if (parameter.type === "number") return parseJavaFloat(value) ?? value;
  if (parameter.type === "boolean" && /^(true|false)$/i.test(value)) {
    return value.toLowerCase() === "true";
  }
  return value;
}

const COLLECTION_STYLES: Record<string, Partial<Record<string, JsonRecord>>> = {
  ssv: { query: { style: "spaceDelimited" } },
  pipes: { query: { style: "pipeDelimited" } },
  tsv: {},
  multi: { query: { style: "form", explode: true } },
  csv: {
    query: { style: "form", explode: false },
    header: { style: "simple", explode: false },
    path: { style: "simple", explode: false },
  },
};

const PARAMETER_KEYS = [
  "name",
  "in",
  "description",
  "required",
  "deprecated",
  "allowEmptyValue",
  "$ref",
  "style",
  "explode",
  "allowReserved",
  "schema",
  "examples",
  "example",
  "content",
];

/** `SwaggerConverter.convert(Parameter)` for non-body parameters. */
function convertParameter(
  parameter: V1Parameter,
  state: ConverterState,
): JsonRecord {
  const values: JsonRecord = {};
  if (parameter.kind !== "ref" && isNotBlank(parameter.description)) {
    values.description = parameter.description;
  }
  if (parameter.kind === "serializable") {
    values.allowEmptyValue = parameter.allowEmptyValue;
  }
  values.in = parameter.in;
  values.name = parameter.name;
  values.example = parameter.ext["x-example"];

  if (parameter.kind === "ref") {
    if (parameter.ref.startsWith("#/parameters")) {
      const name = simpleRefName(parameter.ref);
      const { requestBodies, schemas } = state.components;
      const section = requestBodies?.[name] !== undefined
        ? "requestBodies"
        : schemas?.[`formData_${name}`] !== undefined
          ? "schemas"
          : "parameters";
      parameter.ref = `#/components/${section}${parameter.ref.slice("#/parameters".length)}`;
    }
    values.$ref = parameter.ref;
  } else if (parameter.kind === "serializable") {
    let schema: Schema3;
    if (parameter.type === "array") {
      schema = new Schema3("Array", "array");
      const format = parameter.collectionFormat || "csv";
      const style =
        (COLLECTION_STYLES[format] ?? COLLECTION_STYLES.csv)[parameter.in];
      Object.assign(values, style ?? {});
      schema.set("items", convertProperty(parameter.items));
      schema.set("maxItems", parameter.maxItems);
      schema.set("minItems", parameter.minItems);
      schema.set("uniqueItems", parameter.uniqueItems);
    } else if (fixBugs && parameter.type === "file") {
      schema = new Schema3("File", "string", "binary"); // Fix 1
    } else {
      schema = new Schema3(
        schemaClassForParameter(parameter.type, parameter.format),
        parameter.type,
        parameter.format,
      );
      schema.set("maximum", parameter.maximum);
      schema.set("exclusiveMaximum", parameter.exclusiveMaximum);
      schema.set("minimum", parameter.minimum);
      schema.set("exclusiveMinimum", parameter.exclusiveMinimum);
      schema.set("minLength", parameter.minLength);
      schema.set("maxLength", parameter.maxLength);
      schema.set("multipleOf", parameter.multipleOf);
      schema.set("pattern", parameter.pattern);
    }

    for (const value of parameter.enum ?? []) {
      switch (parameter.type ?? "object") {
        case "integer": {
          const parsed = parseJavaInteger(value, 32);
          if (parsed !== null) schema.addEnum(parsed);
          break;
        }
        case "number": {
          const parsed = parseJavaFloat(value);
          if (parsed !== null) schema.addEnum(parsed);
          break;
        }
        case "boolean":
          schema.addEnum(value.toLowerCase() === "true");
          break;
        default:
          schema.addEnum(value);
      }
    }

    schema.set("nullable", readNullable(parameter.ext));
    schema.ext = stripExtensions(parameter.ext);
    schema.setDefault(parameterDefault(parameter));
    values.schema = emitSchema(schema);
  }

  if (parameter.required) values.required = true;
  return ordered(values, PARAMETER_KEYS, stripExtensions(parameter.ext));
}

/** `SwaggerConverter.convert(SerializableParameter)` (form fields). */
function convertFormParameter(parameter: V1SerializableParameter): Schema3 {
  let schema: Schema3;
  if (parameter.type === "file") {
    schema = new Schema3("File", "string", "binary");
  } else if (parameter.type === "array") {
    schema = new Schema3("Array", "array");
    if (parameter.items) schema.set("items", convertProperty(parameter.items));
  } else {
    const exact = primitiveSchema(parameter.type, parameter.format);
    const fallback = exact ? null : primitiveSchema(parameter.type, null);
    if (exact) {
      schema = exact;
    } else if (fallback) {
      schema = fallback;
      schema.set("format", parameter.format);
    } else {
      schema = new Schema3("Schema", parameter.type, parameter.format);
    }
  }

  schema.set("description", parameter.description);
  schema.set("readOnly", parameter.readOnly);
  // Swagger quirks: form enums stay strings even for numbers (fix 4), and an
  // empty `enum: []` is copied although OpenAPI 3.0 forbids it (also fixed).
  const typed = fixBugs && ["Integer", "Number", "Boolean"].includes(schema.cls);
  const enumValues = typed
    ? parameter.enum?.map((value) => typedValue(schema.cls, value) ?? value)
    : parameter.enum;
  schema.setEnum(fixBugs ? nonEmpty(enumValues ?? []) : enumValues, false);
  schema.set("maxItems", parameter.maxItems);
  schema.set("minItems", parameter.minItems);
  schema.set("uniqueItems", parameter.uniqueItems);
  schema.set("maximum", parameter.maximum);
  schema.set("exclusiveMaximum", parameter.exclusiveMaximum);
  schema.set("minimum", parameter.minimum);
  schema.set("exclusiveMinimum", parameter.exclusiveMinimum);
  schema.set("minLength", parameter.minLength);
  schema.set("maxLength", parameter.maxLength);
  if (parameter.ext["x-example"] !== undefined) {
    schema.setExample(parameter.ext["x-example"]);
  }
  schema.set("nullable", readNullable(parameter.ext));
  schema.ext = stripExtensions(parameter.ext);
  schema.set("multipleOf", parameter.multipleOf);
  schema.set("pattern", parameter.pattern);
  schema.setDefault(parameterDefault(parameter));
  return schema;
}

function mediaTypesFor(
  local: string[] | null,
  global: string[],
  fallback: string,
): string[] {
  const types = local && local.length > 0 ? local : global;
  return types.length > 0 ? types : [fallback];
}

const REQUEST_BODY_KEYS = ["description", "content", "required", "$ref"];

/** An OpenAPI media type object before it is emitted. */
interface MediaEntry {
  schema?: Schema3 | null;
  hasExample?: boolean;
  example?: unknown;
}

/**
 * Swagger's `convertExamples`. `MediaType.setExample` casts the example with
 * the media type's schema (a string schema turns `{a: 1}` into `"{a=1}"`),
 * keeps an explicit `null`, and drops values the cast rejects.
 */
function addMediaExamples(
  content: Record<string, MediaEntry>,
  examples: JsonRecord | null,
) {
  for (const [type, example] of Object.entries(examples ?? {})) {
    const media = (content[type] ??= {});
    if (!media.schema || example === null) {
      media.example = example;
      media.hasExample = true;
      continue;
    }
    const cast =
      media.schema.cls === "Date" && !keepsOriginal("Date", example)
        ? castDate(example)
        : castSchemaValue(media.schema.cls, example);
    media.example = cast;
    media.hasExample = cast !== null;
  }
}

function emitContent(content: Record<string, MediaEntry>): JsonRecord {
  const output: JsonRecord = {};
  for (const [type, media] of Object.entries(content)) {
    const emitted: JsonRecord = {};
    if (media.schema) emitted.schema = emitSchema(media.schema);
    if (media.hasExample) emitted.example = media.example;
    output[type] = emitted;
  }
  return output;
}

function convertBodyParameter(
  parameter: V1BodyParameter,
  consumes: string[] | null,
  state: ConverterState,
): JsonRecord {
  const content: Record<string, MediaEntry> = {};
  for (const type of mediaTypesFor(consumes, state.globalConsumes, "*/*")) {
    // Converted once per media type, so source mutations show up here.
    content[type] = { schema: convertModel(parameter.schema) };
  }
  addMediaExamples(content, parameter.examples);
  return ordered(
    {
      description: isNotBlank(parameter.description)
        ? parameter.description
        : undefined,
      content: emitContent(content),
      required: parameter.required,
    },
    REQUEST_BODY_KEYS,
    stripExtensions(parameter.ext),
  );
}

function convertFormBody(
  parameters: V1SerializableParameter[],
  consumes: string[] | null,
  state: ConverterState,
): JsonRecord {
  const form = new Schema3("Object", "object");
  const properties: Record<string, Schema3> = {};
  const required: string[] = [];
  for (const parameter of parameters) {
    const schema = convertFormParameter(parameter);
    if (parameter.required && parameter.name !== null) required.push(parameter.name);
    properties[String(parameter.name)] = schema;
  }
  // `Schema.addRequiredItem` keeps the list sorted.
  form.set("required", required.length > 0 ? required.sort() : null);
  form.set("properties", properties);

  const content: Record<string, MediaEntry> = {};
  for (const type of mediaTypesFor(consumes, state.globalConsumes, "multipart/form-data")) {
    content[type] = { schema: form };
  }
  return ordered(
    { content: emitContent(content), required: required.length > 0 ? true : undefined },
    REQUEST_BODY_KEYS,
  );
}

const RESPONSE_KEYS = ["description", "headers", "content", "links", "$ref"];
const HEADER_KEYS = [
  "description",
  "$ref",
  "required",
  "deprecated",
  "style",
  "explode",
  "schema",
  "examples",
  "example",
  "content",
];

function convertResponse(
  response: V1Response,
  produces: string[] | null,
  state: ConverterState,
): JsonRecord {
  if (response.kind === "ref") {
    response.ref = responseRef(response.ref);
    return { $ref: response.ref };
  }

  const types = produces ?? state.globalProduces;
  const mediaTypes = types.length > 0 ? types : ["*/*"];
  const content: Record<string, MediaEntry> = {};
  if (response.schema) {
    // One schema object is shared by every media type here.
    const schema = convertFileSchema(convertModel(response.schema));
    for (const type of mediaTypes) content[type] = { schema };
  }
  addMediaExamples(content, response.examples);

  const ext = convertExtensions(response.ext);
  let headers: JsonRecord | undefined;
  const headerNames = Object.keys(response.headers ?? {});
  if (response.headers && headerNames.length > 0) {
    headers = {};
    // Swagger copies headers into a HashMap, so they come out in hash order.
    for (const name of javaHashMapOrder(headerNames)) {
      const property = response.headers[name];
      const schema = convertProperty(property);
      if (!property || !schema) continue;
      schema.set("description", null);
      headers[name] = ordered(
        { description: property.description, schema: emitSchema(schema) },
        HEADER_KEYS,
      );
    }
  }

  return ordered(
    { description: response.description, headers, content: emitContent(content) },
    RESPONSE_KEYS,
    ext,
  );
}

const OPERATION_KEYS = [
  "tags",
  "summary",
  "description",
  "externalDocs",
  "operationId",
  "parameters",
  "requestBody",
  "responses",
  "callbacks",
  "deprecated",
  "security",
  "servers",
];

/** Whether an unresolved `$ref` names a global body/formData parameter. */
function isGlobalParameter(
  parameter: V1Parameter,
  state: ConverterState,
  location: "body" | "formData",
): boolean {
  if (parameter.kind !== "ref") return false;
  return state.swagger.parameters?.[simpleRefName(parameter.ref)]?.in === location;
}

function convertOperation(
  operation: V1Operation,
  state: ConverterState,
): JsonRecord {
  const values: JsonRecord = {
    description: isNotBlank(operation.description)
      ? operation.description
      : undefined,
    summary: isNotBlank(operation.summary) ? operation.summary : undefined,
    deprecated: operation.deprecated,
    operationId: operation.operationId,
    tags: operation.tags,
  };
  const ext = stripExtensions(operation.ext);

  const parameters: JsonRecord[] = [];
  const formParameters: V1SerializableParameter[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.in === "formData") {
      formParameters.push(parameter as V1SerializableParameter);
    } else if (parameter.kind === "body") {
      values.requestBody = convertBodyParameter(parameter, operation.consumes, state);
      ext["x-codegen-request-body-name"] = parameter.name;
    } else {
      const converted = convertParameter(parameter, state);
      const ref = converted.$ref;
      if (
        typeof ref === "string" &&
        ref.startsWith("#/components/requestBodies/") &&
        isGlobalParameter(parameter, state, "body")
      ) {
        values.requestBody = { $ref: ref };
      } else if (
        typeof ref === "string" &&
        ref.startsWith("#/components/schemas/") &&
        isGlobalParameter(parameter, state, "formData")
      ) {
        // Unreachable after resolution unless the global form field is
        // missing; Swagger itself would fail here.
      } else {
        parameters.push(converted);
      }
    }
  }
  if (parameters.length > 0) values.parameters = parameters;
  if (formParameters.length > 0) {
    values.requestBody = convertFormBody(formParameters, operation.consumes, state);
  }

  if (operation.responses) {
    const responses: JsonRecord = {};
    for (const [code, response] of Object.entries(operation.responses)) {
      if (response) {
        responses[code] = convertResponse(response, operation.produces, state);
      }
    }
    if (fixBugs) {
      // Fix 9: Swagger drops x- keys of the Responses object.
      Object.assign(
        responses,
        readExtensions(readObject(operation.source, "responses") ?? {}),
      );
    }
    values.responses = responses;
  }

  values.externalDocs = convertExternalDocs(operation.externalDocs);
  if (operation.security) {
    values.security = operation.security.map((requirement) => ({ ...requirement }));
  }
  if (fixBugs) values.servers = operationServers(operation, state);
  return ordered(values, OPERATION_KEYS, ext);
}

/**
 * Fix 10: Swagger drops operation-level `schemes`. Turn them into operation
 * `servers` (same URL rules as the document's) when they differ from the
 * document's servers.
 */
function operationServers(
  operation: V1Operation,
  state: ConverterState,
): JsonRecord[] | undefined {
  const schemes = readSchemes(operation.source);
  if (!schemes || schemes.length === 0) return undefined;
  const servers = convertServers({ ...state.swagger, schemes });
  const documentServers = convertServers(state.swagger);
  return JSON.stringify(servers) === JSON.stringify(documentServers)
    ? undefined
    : servers;
}

/** The order `SwaggerConverter.convert(Path)` converts operations in. */
const CONVERSION_ORDER: V1Method[] = [
  "get",
  "put",
  "post",
  "patch",
  "delete",
  "head",
  "options",
];

const PATH_ITEM_KEYS = [
  "summary",
  "description",
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "servers",
  "parameters",
  "$ref",
];

function convertPath(path: V1Path, state: ConverterState): JsonRecord {
  if (path.kind === "ref") return { $ref: path.ref };
  const values: JsonRecord = {};
  for (const method of CONVERSION_ORDER) {
    const operation = path.operations[method];
    if (operation) values[method] = convertOperation(operation, state);
  }
  return ordered(values, PATH_ITEM_KEYS, stripExtensions(path.ext));
}

const COMPONENT_KEYS = [
  "schemas",
  "responses",
  "parameters",
  "examples",
  "requestBodies",
  "headers",
  "securitySchemes",
  "links",
  "callbacks",
];

function addComponent(
  state: ConverterState,
  section: keyof ConverterState["components"],
  name: string,
  value: unknown,
) {
  state.components[section] ??= {};
  (state.components[section] as JsonRecord)[name] = value;
}

const ROOT_KEYS = [
  "openapi",
  "info",
  "externalDocs",
  "servers",
  "security",
  "tags",
  "paths",
  "components",
];

function convertInfo(info: V1Info): JsonRecord {
  return ordered(
    {
      title: info.title,
      description: info.description,
      termsOfService: info.termsOfService,
      // Swagger quirk: contact extensions are dropped (fix 9 keeps them).
      contact: info.contact
        ? ordered(
            info.contact,
            ["name", "url", "email"],
            fixBugs ? stripExtensions(info.contact.ext) : null,
          )
        : undefined,
      license: info.license
        ? ordered(
            { name: info.license.name, url: info.license.url },
            ["name", "url"],
            stripExtensions(info.license.ext),
          )
        : undefined,
      version: info.version,
    },
    ["title", "description", "termsOfService", "contact", "license", "version"],
    stripExtensions(info.ext),
  );
}

function convertDocument(swagger: V1Swagger): JsonRecord {
  const state: ConverterState = {
    swagger,
    globalConsumes: swagger.consumes ?? [],
    globalProduces: swagger.produces ?? [],
    components: {
      schemas: null,
      responses: null,
      parameters: null,
      requestBodies: null,
      securitySchemes: null,
    },
  };

  const rootExt: Ext = convertExtensions(swagger.ext) ?? {};
  rootExt["x-original-swagger-version"] = swagger.swagger;

  const values: JsonRecord = {
    openapi: "3.0.1",
    externalDocs: convertExternalDocs(swagger.externalDocs),
    info: swagger.info ? convertInfo(swagger.info) : undefined,
    servers: convertServers(swagger),
  };

  if (swagger.tags) {
    values.tags = swagger.tags.map((tag) =>
      ordered(
        {
          name: tag.name,
          description: tag.description,
          externalDocs: convertExternalDocs(tag.externalDocs),
        },
        ["name", "description", "externalDocs"],
        stripExtensions(tag.ext),
      ),
    );
  }
  if (swagger.security && swagger.security.length > 0) {
    values.security = swagger.security.map((requirement) => ({ ...requirement }));
  }

  for (const [name, parameter] of Object.entries(swagger.parameters ?? {})) {
    if (parameter.kind === "body") {
      addComponent(state, "requestBodies", name, convertBodyParameter(parameter, null, state));
    } else if (parameter.in === "formData") {
      // `formData_` keeps these from overwriting definitions.
      addComponent(
        state,
        "schemas",
        `formData_${name}`,
        emitSchema(convertFormParameter(parameter as V1SerializableParameter)),
      );
    } else {
      addComponent(state, "parameters", name, convertParameter(parameter, state));
    }
  }

  const paths: JsonRecord = {};
  for (const [name, path] of Object.entries(swagger.paths)) {
    paths[name] = convertPath(path, state);
  }
  // Fix 9: Swagger drops x- keys of the Paths object.
  if (fixBugs) Object.assign(paths, swagger.pathsExt);
  values.paths = paths;

  for (const [name, response] of Object.entries(swagger.responses ?? {})) {
    if (response) {
      addComponent(state, "responses", name, convertResponse(response, null, state));
    }
  }
  for (const [name, model] of Object.entries(swagger.definitions ?? {})) {
    const schema = convertModel(model);
    addComponent(state, "schemas", name, schema ? emitSchema(schema) : null);
  }
  for (const [name, scheme] of Object.entries(swagger.securityDefinitions ?? {})) {
    addComponent(state, "securitySchemes", name, convertSecurityScheme(scheme));
  }
  values.components = ordered(state.components, COMPONENT_KEYS);

  return ordered(values, ROOT_KEYS, rootExt);
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Converts a parsed Swagger 2.0 document to OpenAPI 3.0.1, producing the same
 * document as Swagger's online converter, or, with `fixSwaggerBugs`, that
 * document with Swagger's bugs fixed.
 */
export function convertSwagger(
  swagger: JsonRecord,
  options: ConvertOptions = {},
): JsonRecord {
  if (swagger.swagger !== "2.0") {
    throw new Error('Expected a Swagger document with "swagger": "2.0".');
  }
  if (!isRecord(swagger.info)) {
    throw new Error('The document is missing the required "info" object.');
  }
  if (!isRecord(swagger.paths)) {
    throw new Error('The document is missing the required "paths" object.');
  }

  fixBugs = options.fixSwaggerBugs === true;
  try {
    // Work on a copy: Swagger's conversion mutates its own model as it goes.
    const model = readSwagger(structuredClone(swagger));
    resolveSwagger(model);
    return convertDocument(model);
  } finally {
    fixBugs = false;
  }
}

export function countOperations(paths: unknown) {
  if (!isRecord(paths)) return 0;
  return Object.values(paths).reduce<number>((count, path) => {
    if (!isRecord(path)) return count;
    return (
      count +
      Object.keys(path).filter((key) => HTTP_METHODS.has(key)).length
    );
  }, 0);
}
