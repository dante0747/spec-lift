import { CORE_SCHEMA, dump, load, Type, YAMLException } from "js-yaml";

export type SpecFormat = "json" | "yaml";

export type ParsedSpec =
  | { ok: true; format: SpecFormat; value: unknown }
  | {
      ok: false;
      format: SpecFormat;
      message: string;
      line?: number;
      column?: number;
    };

/*
 * Swagger's converter reads YAML with Jackson + SnakeYAML, which follow
 * YAML 1.1 scalar rules. These types reproduce what its output shows:
 * yes/no/on/off are booleans, 010 is octal, 1_000 is a number, while
 * values such as 018, 0o10 and dates stay strings.
 */
const BOOL_PATTERN =
  /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const INT_PATTERN =
  /^(?:[-+]?0b_*[01][01_]*|[-+]?0_*[0-7][0-7_]*|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x_*[0-9a-fA-F][0-9a-fA-F_]*)$/;
const FLOAT_PATTERN =
  /^(?:[-+]?(?:(?:0|[1-9][0-9_]*)?\.[0-9_]*(?:[eE][-+]?[0-9]+)?|(?:0|[1-9][0-9_]*)[eE][-+]?[0-9]+)|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

const yamlBool = new Type("tag:yaml.org,2002:bool", {
  kind: "scalar",
  resolve: (data: string | null) => data !== null && BOOL_PATTERN.test(data),
  construct: (data: string) => /^(?:yes|true|on)$/i.test(data),
  predicate: (value: unknown) => typeof value === "boolean",
  represent: (value: unknown) => (value ? "true" : "false"),
});

const yamlInt = new Type("tag:yaml.org,2002:int", {
  kind: "scalar",
  resolve: (data: string | null) => data !== null && INT_PATTERN.test(data),
  construct: (data: string) => {
    let text = data.replace(/_/g, "");
    const sign = text[0] === "-" ? -1 : 1;
    if (text[0] === "-" || text[0] === "+") text = text.slice(1);
    if (text.startsWith("0b")) return sign * parseInt(text.slice(2), 2);
    if (text.startsWith("0x")) return sign * parseInt(text.slice(2), 16);
    if (text.length > 1 && text[0] === "0") {
      return sign * parseInt(text.slice(1), 8);
    }
    return sign * Number(text);
  },
  predicate: (value: unknown) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Object.is(value, -0),
  represent: (value: unknown) => String(value),
});

const yamlFloat = new Type("tag:yaml.org,2002:float", {
  kind: "scalar",
  resolve: (data: string | null) =>
    data !== null && data !== "." && FLOAT_PATTERN.test(data),
  construct: (data: string) => {
    const text = data.replace(/_/g, "").toLowerCase();
    if (text.endsWith(".inf")) return text[0] === "-" ? -Infinity : Infinity;
    if (text === ".nan") return NaN;
    return Number(text);
  },
  predicate: (value: unknown) =>
    typeof value === "number" &&
    (!Number.isInteger(value) || Object.is(value, -0)),
  represent: (value: unknown) => {
    const number = value as number;
    if (Number.isNaN(number)) return ".nan";
    if (number === Infinity) return ".inf";
    if (number === -Infinity) return "-.inf";
    return Object.is(number, -0) ? "-0.0" : String(number);
  },
});

// Same-tag implicit types replace the core ones in place.
export const YAML_SCHEMA = CORE_SCHEMA.extend({
  implicit: [yamlBool, yamlInt, yamlFloat],
});

/** Java's Double.toString, used where Swagger turns a YAML float into text. */
function javaDoubleText(value: number) {
  if (Number.isInteger(value) && Math.abs(value) < 1e7) return `${value}.0`;
  return String(value);
}

/**
 * Finds the raw text of an unquoted numeric `version:` directly under a
 * block-style top-level `info:` mapping, so `version: 1.0` keeps its ".0".
 */
function rawInfoVersion(source: string): string | undefined {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^info:\s*(?:#.*)?$/.test(line));
  if (start < 0) return undefined;
  let childIndent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    childIndent ??= indent;
    if (indent !== childIndent) continue;
    const match = /^\s+version:\s+([-+]?[0-9][0-9_]*\.[0-9_]*)\s*(?:#.*)?$/.exec(
      line,
    );
    if (match) return match[1];
  }
  return undefined;
}

/** Applies Swagger's text handling for the two top-level version fields. */
function normalizeVersions(value: unknown, source: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const document = value as Record<string, unknown>;
  if (typeof document.swagger === "number") {
    document.swagger = javaDoubleText(document.swagger);
  }
  const info = document.info;
  if (
    typeof info === "object" &&
    info !== null &&
    !Array.isArray(info) &&
    typeof (info as Record<string, unknown>).version === "number"
  ) {
    const raw = rawInfoVersion(source);
    const version = (info as Record<string, unknown>).version as number;
    (info as Record<string, unknown>).version =
      raw !== undefined && Number(raw.replace(/_/g, "")) === version
        ? javaDoubleText(version)
        : String(version);
  }
  return document;
}

/** JSON documents start with an object or array; anything else is YAML. */
export function detectFormat(source: string): SpecFormat {
  const first = source.trimStart()[0];
  return first === "{" || first === "[" ? "json" : "yaml";
}

function jsonErrorPosition(source: string, message: string) {
  const lineColumn = /line (\d+) column (\d+)/i.exec(message);
  if (lineColumn) {
    return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  }
  const offset = /position (\d+)/i.exec(message);
  if (!offset) return {};
  const before = source.slice(0, Number(offset[1]));
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

export function parseSpec(source: string): ParsedSpec {
  const format = detectFormat(source);

  if (format === "json") {
    try {
      const value: unknown = JSON.parse(source);
      if (
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>).swagger === 2
      ) {
        (value as Record<string, unknown>).swagger = "2.0";
      }
      return { ok: true, format, value };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid JSON syntax.";
      return {
        ok: false,
        format,
        message,
        ...jsonErrorPosition(source, message),
      };
    }
  }

  try {
    const value = normalizeVersions(load(source, { schema: YAML_SCHEMA }), source);
    return { ok: true, format, value };
  } catch (error) {
    if (error instanceof YAMLException) {
      return {
        ok: false,
        format,
        message: error.reason || error.message,
        line: error.mark ? error.mark.line + 1 : undefined,
        column: error.mark ? error.mark.column + 1 : undefined,
      };
    }
    return { ok: false, format, message: "Invalid YAML syntax." };
  }
}

export function serializeSpec(value: unknown, format: SpecFormat): string {
  if (format === "json") return JSON.stringify(value, null, 2);
  return dump(value, {
    schema: YAML_SCHEMA,
    lineWidth: -1,
    noRefs: true,
    noArrayIndent: true,
    quotingType: '"',
  });
}
