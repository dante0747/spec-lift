import type { SpecFormat } from "./spec-format";

/** Above this size we skip highlighting so typing stays responsive. */
export const HIGHLIGHT_LIMIT = 250_000;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function span(kind: string, value: string) {
  return `<span class="tok-${kind}">${escapeHtml(value)}</span>`;
}

const JSON_TOKEN =
  /("(?:\\.|[^"\\\n])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;

function highlightJson(source: string) {
  let html = "";
  let last = 0;
  for (const match of source.matchAll(JSON_TOKEN)) {
    const index = match.index ?? 0;
    html += escapeHtml(source.slice(last, index));
    const [, string, colon, boolean, nullish, number, punctuation] = match;
    if (string !== undefined) {
      if (colon !== undefined) {
        const kind = string === '"$ref"' ? "ref" : "key";
        html += span(kind, string) + span("punct", colon);
      } else {
        html += span("string", string);
      }
    } else if (boolean !== undefined) {
      html += span("bool", boolean);
    } else if (nullish !== undefined) {
      html += span("null", nullish);
    } else if (number !== undefined) {
      html += span("number", number);
    } else if (punctuation !== undefined) {
      html += span("punct", punctuation);
    }
    last = index + match[0].length;
  }
  return html + escapeHtml(source.slice(last));
}

const YAML_SCALAR =
  /^(?:true|false|yes|no|on|off)$/i;
const YAML_NUMBER = /^[-+]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.inf|\.nan)$/i;

function highlightYamlValue(value: string) {
  if (!value) return "";
  const trimmed = value.trim();
  const leading = value.slice(0, value.indexOf(trimmed));
  const trailing = value.slice(leading.length + trimmed.length);
  let kind = "string";
  if (trimmed.startsWith("#")) kind = "comment";
  else if (YAML_SCALAR.test(trimmed)) kind = "bool";
  else if (trimmed === "null" || trimmed === "~") kind = "null";
  else if (YAML_NUMBER.test(trimmed)) kind = "number";
  else if (/^[{}[\]|>-]+$/.test(trimmed)) kind = "punct";
  return escapeHtml(leading) + span(kind, trimmed) + escapeHtml(trailing);
}

const YAML_LINE =
  /^(\s*)(-\s+)?((?:"(?:\\.|[^"\\])*"|'(?:[^']|'')*'|[^\s#:][^:#]*?))(\s*:)(\s.*|$)/;

function highlightYaml(source: string) {
  return source
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return span("comment", line);
      const keyed = YAML_LINE.exec(line);
      if (keyed) {
        const [, indent, dash = "", key, colon, rest] = keyed;
        const keyKind = key === "$ref" || key === '"$ref"' ? "ref" : "key";
        return (
          escapeHtml(indent) +
          (dash ? span("punct", dash) : "") +
          span(keyKind, key) +
          span("punct", colon) +
          highlightYamlValue(rest)
        );
      }
      const listItem = /^(\s*)(-\s+|-$)(.*)$/.exec(line);
      if (listItem) {
        const [, indent, dash, rest] = listItem;
        return (
          escapeHtml(indent) + span("punct", dash) + highlightYamlValue(rest)
        );
      }
      return highlightYamlValue(line);
    })
    .join("\n");
}

export function highlight(source: string, format: SpecFormat): string {
  if (source.length > HIGHLIGHT_LIMIT) return escapeHtml(source);
  return format === "json" ? highlightJson(source) : highlightYaml(source);
}
