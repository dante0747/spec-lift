"use client";

import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CodeEditor, CodeView } from "./code-editor";
import { convertSwagger, countOperations } from "./converter";
import { isRecord, type JsonRecord } from "./converter-refs";
import { highlight } from "./highlight";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  CpuIcon,
  DownloadIcon,
  EyeOffIcon,
  GitHubIcon,
  HeartIcon,
  LockIcon,
  LogoMark,
  ScaleIcon,
  ShieldIcon,
  TrashIcon,
  UploadIcon,
  WandIcon,
} from "./icons";
import { SAMPLES } from "./samples";
import { parseSpec, serializeSpec, type SpecFormat } from "./spec-format";

const REPO_URL = "https://github.com/dante0747/spec-lift";
const SPONSOR_URL = "https://github.com/sponsors/dante0747";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const LIVE_LIMIT = 2 * 1024 * 1024;

type Assessment = {
  status: "empty" | "invalid" | "valid";
  format: SpecFormat;
  label: string;
  message: string;
  document?: JsonRecord;
  errorLine?: number;
};

function assess(source: string): Assessment {
  if (!source.trim()) {
    return {
      status: "empty",
      format: "json",
      label: "Waiting for input",
      message: "Paste Swagger 2.0 JSON or YAML, or drop a file.",
    };
  }

  const parsed = parseSpec(source);
  const formatName = parsed.format.toUpperCase();
  if (!parsed.ok) {
    return {
      status: "invalid",
      format: parsed.format,
      label: `Invalid ${formatName}`,
      message: parsed.line
        ? `Line ${parsed.line}: ${parsed.message}`
        : parsed.message,
      errorLine: parsed.line,
    };
  }

  const document = parsed.value;
  const invalid = (label: string, message: string): Assessment => ({
    status: "invalid",
    format: parsed.format,
    label,
    message,
  });

  if (!isRecord(document)) {
    return invalid(
      "Object required",
      "The top level of the document must be an object.",
    );
  }
  if (typeof document.openapi === "string") {
    return invalid(
      "Already OpenAPI 3",
      `This document is already OpenAPI ${document.openapi}. Paste a Swagger 2.0 spec instead.`,
    );
  }
  if (document.swagger !== "2.0") {
    return invalid(
      "Swagger 2.0 required",
      'Expected a document with swagger: "2.0".',
    );
  }
  if (!isRecord(document.info)) {
    return invalid("Missing info", 'Add the required top-level "info" object.');
  }
  if (!isRecord(document.paths)) {
    return invalid(
      "Missing paths",
      'Add the required top-level "paths" object.',
    );
  }

  return {
    status: "valid",
    format: parsed.format,
    label: `Swagger 2.0 · ${formatName}`,
    message: "Ready to convert locally.",
    document,
  };
}

function lineCount(value: string) {
  return value ? value.split("\n").length : 0;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Local `#/...` references in the output that point at nothing. */
function unresolvedRefs(document: JsonRecord): string[] {
  const missing = new Set<string>();
  const resolve = (pointer: string) =>
    pointer
      .slice(2)
      .split("/")
      .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce<unknown>(
        (node, token) =>
          isRecord(node) || Array.isArray(node)
            ? (node as Record<string, unknown>)[token]
            : undefined,
        document,
      );
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") {
          if (value.startsWith("#/") && resolve(value) === undefined) {
            missing.add(value);
          }
        } else {
          visit(value);
        }
      }
    }
  };
  visit(document);
  return [...missing];
}

function initialConversion() {
  const result = assess(SAMPLES[0].source);
  return result.document
    ? convertSwagger(result.document, { fixSwaggerBugs: true })
    : null;
}

const HERO_BEFORE = `swagger: "2.0"
host: api.example.com
basePath: /v1
schemes: [https]
consumes: [application/json]
definitions:
  Order:
    $ref: "#/definitions/NewOrder"`;

const HERO_AFTER = `openapi: 3.0.1
servers:
- url: https://api.example.com/v1
components:
  schemas:
    Order:
      $ref: "#/components/schemas/NewOrder"`;

const MAPPINGS = [
  ["host + basePath + schemes", "servers[].url"],
  ["definitions", "components.schemas"],
  ["in: body", "requestBody.content"],
  ["in: formData", "requestBody (form / multipart)"],
  ["consumes / produces", "content media types"],
  ["type: file", "type: string, format: binary"],
  ["collectionFormat", "style + explode"],
  ["securityDefinitions", "components.securitySchemes"],
  ["type: basic", "type: http, scheme: basic"],
  ["flow: accessCode", "flows.authorizationCode"],
  ["parameters / responses", "components.*"],
  ["#/definitions/…", "#/components/schemas/…"],
] as const;

const BUG_FIXES = [
  {
    swagger: "type: file inside schemas stays file",
    fixed: "type: string, format: binary",
  },
  {
    swagger: 'date defaults become "…T00:00:00.000+00:00"',
    fixed: 'dates stay "2021-01-01"',
  },
  {
    swagger: 'array defaults become text "[\\"a\\"]"',
    fixed: 'real arrays ["a"]',
  },
  {
    swagger: 'numeric form enums become ["1", "5"]',
    fixed: "numbers stay numbers",
  },
  {
    swagger: 'object examples become Java text "{a=1}"',
    fixed: "examples stay JSON",
  },
  {
    swagger: "shared params lose example / nullable after first use",
    fixed: "every use keeps them",
  },
  {
    swagger: "defaults, enums, readOnly, discriminators silently dropped",
    fixed: "kept in the output",
  },
  {
    swagger: "operation schemes and x- extensions dropped",
    fixed: "operation servers and extensions kept",
  },
] as const;

export default function Home() {
  const [input, setInput] = useState(SAMPLES[0].source);
  const [sampleId, setSampleId] = useState(SAMPLES[0].id);
  const [converted, setConverted] = useState<JsonRecord | null>(
    initialConversion,
  );
  const [lastConvertedInput, setLastConvertedInput] = useState(
    SAMPLES[0].source,
  );
  const [outputFormat, setOutputFormat] = useState<SpecFormat>("json");
  const [outputPinned, setOutputPinned] = useState(false);
  const [live, setLive] = useState(true);
  const [fixBugs, setFixBugs] = useState(true);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(
    "Sample converted. Paste your own Swagger 2.0 spec to begin.",
  );
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pulse, setPulse] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const deferredInput = useDeferredValue(input);
  const assessment = useMemo(() => assess(deferredInput), [deferredInput]);
  const output = useMemo(
    () => (converted ? serializeSpec(converted, outputFormat) : ""),
    [converted, outputFormat],
  );
  const outputIsStale = input !== lastConvertedInput;

  const stats = useMemo(() => {
    const paths = isRecord(converted?.paths) ? converted.paths : {};
    const components = isRecord(converted?.components)
      ? converted.components
      : {};
    const size = (value: unknown) =>
      isRecord(value) ? Object.keys(value).length : 0;
    return [
      { label: "paths", value: Object.keys(paths).length },
      { label: "operations", value: countOperations(paths) },
      { label: "schemas", value: size(components.schemas) },
      { label: "security", value: size(components.securitySchemes) },
    ];
  }, [converted]);

  const runConversion = useCallback(
    (source: string, quiet = false, fix = fixBugs) => {
      const result = assess(source);
      if (!result.document) {
        if (!quiet) setError(result.message);
        return;
      }
      try {
        const started = performance.now();
        const next = convertSwagger(result.document, { fixSwaggerBugs: fix });
        const elapsed = performance.now() - started;
        setConverted(next);
        setLastConvertedInput(source);
        setError("");
        setWarnings(unresolvedRefs(next));
        if (!outputPinned) setOutputFormat(result.format);
        setNotice(
          `Converted in ${elapsed < 1 ? "<1" : Math.round(elapsed)} ms${
            fix ? " with Swagger's bugs fixed" : " in Swagger-exact mode"
          }, entirely in this tab.`,
        );
        setPulse((value) => value + 1);
      } catch (conversionError) {
        setError(
          conversionError instanceof Error
            ? conversionError.message
            : "We could not convert this Swagger document.",
        );
      }
    },
    [outputPinned, fixBugs],
  );

  // Live mode converts shortly after typing stops.
  useEffect(() => {
    if (!live || deferredInput !== input) return;
    if (input === lastConvertedInput || input.length > LIVE_LIMIT) return;
    if (assessment.status !== "valid") return;
    const timer = window.setTimeout(() => runConversion(input, true), 350);
    return () => window.clearTimeout(timer);
  }, [
    live,
    input,
    deferredInput,
    lastConvertedInput,
    assessment.status,
    runConversion,
  ]);

  function updateInput(value: string) {
    setInput(value);
    setError("");
    setCopied(false);
  }

  function loadSample(id: string) {
    const sample = SAMPLES.find((item) => item.id === id);
    if (!sample) return;
    setSampleId(id);
    updateInput(sample.source);
    runConversion(sample.source);
  }

  function loadFile(file?: File) {
    if (!file) return;
    if (!/\.(json|ya?ml)$/i.test(file.name)) {
      setError("Choose a .json, .yaml or .yml file.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("That file is over 10 MB. Choose a smaller Swagger document.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      setSampleId("");
      updateInput(content);
      runConversion(content);
      setNotice(`Loaded ${file.name} (${formatBytes(file.size)}).`);
    };
    reader.onerror = () => setError("We could not read that file.");
    reader.readAsText(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    loadFile(event.dataTransfer.files[0]);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    loadFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function formatInput() {
    const parsed = parseSpec(input);
    if (!parsed.ok) {
      setError(`Fix the ${parsed.format.toUpperCase()} syntax before formatting.`);
      return;
    }
    updateInput(serializeSpec(parsed.value, parsed.format));
  }

  function chooseOutputFormat(format: SpecFormat) {
    setOutputFormat(format);
    setOutputPinned(true);
  }

  async function copyOutput() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setError("");
      setNotice(`OpenAPI ${outputFormat.toUpperCase()} copied to your clipboard.`);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copy failed. Select the output and copy it manually.");
    }
  }

  function downloadOutput() {
    if (!output) return;
    const blob = new Blob([output], {
      type: outputFormat === "json" ? "application/json" : "application/yaml",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `openapi.${outputFormat === "json" ? "json" : "yaml"}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const inputFileName = `swagger.${assessment.format === "json" ? "json" : "yaml"}`;
  const outputFileName = `openapi.${outputFormat === "json" ? "json" : "yaml"}`;
  const hasProblem = Boolean(error) || assessment.status === "invalid";
  const hasWarning = !hasProblem && !outputIsStale && warnings.length > 0;
  const statusMessage =
    error ||
    (assessment.status === "invalid"
      ? assessment.message
      : hasWarning
        ? `${notice} ${warnings.length} reference${
            warnings.length === 1 ? " points" : "s point"
          } to nothing: ${warnings.slice(0, 3).join(", ")}${
            warnings.length > 3 ? ", …" : ""
          }`
        : notice);

  return (
    <div className="page">
      <div className="backdrop" aria-hidden="true">
        <div className="aurora aurora-a" />
        <div className="aurora aurora-b" />
        <div className="aurora aurora-c" />
        <div className="grid-lines" />
      </div>

      <header className="site-header">
        <div className="shell header-inner">
          <a className="brand" href="#top" aria-label="SpecLift home">
            <LogoMark className="brand-mark" />
            <span>SpecLift</span>
          </a>
          <nav className="nav-links" aria-label="Main navigation">
            <a href="#converter">Converter</a>
            <a href="#mapping">What changes</a>
            <a href="#privacy">Privacy</a>
            <a
              className="sponsor-badge"
              href={SPONSOR_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Sponsor SpecLift on GitHub"
            >
              <HeartIcon />
              <span>Sponsor</span>
            </a>
            <a
              className="nav-icon"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="SpecLift on GitHub"
            >
              <GitHubIcon />
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="hero shell" id="top" aria-labelledby="hero-title">
          <div className="hero-copy-block">
            <a className="eyebrow" href="#bugs">
              <span className="eyebrow-dot" aria-hidden="true" />
              Swagger&apos;s converter, minus its bugs
              <ArrowRightIcon />
            </a>
            <h1 id="hero-title">
              Lift your API spec to{" "}
              <span className="gradient-text">OpenAPI&nbsp;3</span>
            </h1>
            <p className="hero-copy">
              Drop in a Swagger 2.0 spec as JSON or YAML and get the OpenAPI 3
              output Swagger&apos;s official converter produces, with its bugs
              fixed. Every step runs in your browser. Nothing leaves this
              browser.
            </p>
            <div className="hero-actions">
              <a className="primary-button" href="#converter">
                Start converting <ArrowDownIcon />
              </a>
              <a className="secondary-button" href="#mapping">
                See what changes
              </a>
            </div>
            <ul className="hero-facts" aria-label="Highlights">
              <li>
                <LockIcon /> 100% client-side
              </li>
              <li>
                <WandIcon /> JSON &amp; YAML
              </li>
              <li>
                <ShieldIcon /> No sign-up, no tracking
              </li>
            </ul>
          </div>

          <div className="hero-visual" aria-hidden="true">
            <div className="spec-card spec-before">
              <div className="spec-card-bar">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
                <span className="spec-card-name">swagger.yaml</span>
                <span className="version-chip is-old">2.0</span>
              </div>
              <pre>
                <code
                  dangerouslySetInnerHTML={{
                    __html: highlight(HERO_BEFORE, "yaml"),
                  }}
                />
              </pre>
            </div>
            <div className="lift-beam">
              <span />
              <span />
              <span />
            </div>
            <div className="spec-card spec-after">
              <div className="spec-card-bar">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
                <span className="spec-card-name">openapi.yaml</span>
                <span className="version-chip">3.0</span>
              </div>
              <pre>
                <code
                  dangerouslySetInnerHTML={{
                    __html: highlight(HERO_AFTER, "yaml"),
                  }}
                />
              </pre>
            </div>
          </div>
        </section>

        <section
          className="workspace-shell shell"
          id="converter"
          aria-label="API specification converter"
        >
          <div className="workspace-topbar">
            <div className="window-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="sample-picker" role="group" aria-label="Load a sample">
              <span className="sample-label">Samples</span>
              {SAMPLES.map((sample) => (
                <button
                  key={sample.id}
                  type="button"
                  className={`chip ${sampleId === sample.id ? "is-active" : ""}`}
                  aria-pressed={sampleId === sample.id}
                  onClick={() => loadSample(sample.id)}
                >
                  {sample.label}
                </button>
              ))}
            </div>
            <div className="privacy-status">
              <LockIcon />
              <span>Nothing leaves this browser</span>
            </div>
          </div>

          <div className="workspace">
            <div
              className={`editor-panel ${isDragging ? "is-dragging" : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setIsDragging(false);
                }
              }}
              onDrop={handleDrop}
            >
              <div className="panel-heading">
                <div className="panel-title">
                  <span className="panel-kicker">Swagger 2.0</span>
                  <h2>{inputFileName}</h2>
                </div>
                <div className="panel-actions">
                  <button
                    type="button"
                    className="tool-button"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <UploadIcon /> <span>Open</span>
                  </button>
                  <button
                    type="button"
                    className="tool-button"
                    onClick={formatInput}
                    disabled={!input.trim()}
                  >
                    <WandIcon /> <span>Format</span>
                  </button>
                  <button
                    type="button"
                    className="tool-button is-danger"
                    onClick={() => {
                      setSampleId("");
                      updateInput("");
                      setConverted(null);
                      setLastConvertedInput("");
                      setNotice("Input and output cleared.");
                    }}
                    disabled={!input && !converted}
                    aria-label="Clear input and output"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>

              <label className="sr-only" htmlFor="swagger-input">
                Swagger 2.0 JSON or YAML input
              </label>
              <CodeEditor
                id="swagger-input"
                value={input}
                format={assessment.format}
                onChange={(value) => {
                  setSampleId("");
                  updateInput(value);
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    runConversion(input);
                  }
                }}
                placeholder={'swagger: "2.0"\ninfo:\n  title: My API\n  version: "1.0"\npaths: {}'}
                describedBy="input-status conversion-message"
                invalid={assessment.status === "invalid"}
                errorLine={assessment.errorLine}
              />

              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
                onChange={handleFileChange}
                hidden
              />

              <div className="drop-overlay" aria-hidden="true">
                <UploadIcon />
                <strong>Drop to load</strong>
                <span>JSON or YAML · up to 10 MB</span>
              </div>

              <div className="panel-footer">
                <span
                  className={`input-state state-${assessment.status}`}
                  id="input-status"
                >
                  <span className="state-dot" aria-hidden="true" />
                  {assessment.label}
                </span>
                <span className="editor-metrics">
                  {lineCount(input).toLocaleString()} lines ·{" "}
                  {formatBytes(input.length)}
                </span>
              </div>
            </div>

            <div className="convert-rail">
              <button
                type="button"
                className={`lift-button ${outputIsStale && assessment.status === "valid" ? "is-ready" : ""}`}
                onClick={() => runConversion(input)}
                disabled={assessment.status !== "valid"}
                aria-label="Convert to OpenAPI 3"
                title="Convert (Ctrl + Enter)"
              >
                <ArrowRightIcon />
              </button>
            </div>

            <div
              className="editor-panel output-panel"
              data-pulse={pulse === 0 ? undefined : pulse % 2 === 0 ? "a" : "b"}
            >
              <div className="panel-heading">
                <div className="panel-title">
                  <span className="panel-kicker is-new">
                    OpenAPI 3.0 · {fixBugs ? "bugs fixed" : "Swagger-exact"}
                  </span>
                  <h2>{outputFileName}</h2>
                </div>
                <div className="panel-actions">
                  <div className="segmented" role="group" aria-label="Output format">
                    {(["json", "yaml"] as const).map((format) => (
                      <button
                        key={format}
                        type="button"
                        aria-pressed={outputFormat === format}
                        className={outputFormat === format ? "is-active" : ""}
                        onClick={() => chooseOutputFormat(format)}
                      >
                        {format.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="tool-button"
                    onClick={copyOutput}
                    disabled={!output}
                    aria-label={`Copy converted OpenAPI ${outputFormat.toUpperCase()}`}
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    <span>{copied ? "Copied" : "Copy"}</span>
                  </button>
                  <button
                    type="button"
                    className="tool-button is-accent"
                    onClick={downloadOutput}
                    disabled={!output}
                  >
                    <DownloadIcon /> <span>Download</span>
                  </button>
                </div>
              </div>

              <CodeView
                value={output}
                format={outputFormat}
                label={`Converted OpenAPI ${outputFormat.toUpperCase()}`}
                placeholder="// Your OpenAPI 3 spec will appear here."
              />

              <div className="panel-footer">
                <div className="output-stats" aria-label="Output summary">
                  {stats.map((stat) => (
                    <span key={stat.label}>
                      <b>{stat.value}</b> {stat.label}
                    </span>
                  ))}
                </div>
                <span className={`sync-chip ${outputIsStale ? "is-stale" : ""}`}>
                  {outputIsStale ? "Out of date" : "Up to date"}
                </span>
              </div>
            </div>
          </div>

          <div className="conversion-bar">
            <div
              className={`conversion-message ${hasProblem ? "has-error" : ""} ${
                hasWarning ? "has-warning" : ""
              }`}
              id="conversion-message"
              role="status"
              aria-live="polite"
            >
              <span className="message-symbol" aria-hidden="true">
                {hasProblem || hasWarning ? "!" : <CheckIcon />}
              </span>
              <span>{statusMessage}</span>
            </div>
            <div className="conversion-actions">
              <div className="conversion-options">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={live}
                    onChange={(event) => setLive(event.target.checked)}
                  />
                  <span className="toggle-track" aria-hidden="true" />
                  Live convert
                </label>
                <label
                  className="toggle"
                  title="Off gives byte-for-byte the same output as converter.swagger.io"
                >
                  <input
                    type="checkbox"
                    checked={fixBugs}
                    onChange={(event) => {
                      setFixBugs(event.target.checked);
                      if (assessment.status === "valid" && converted) {
                        runConversion(input, true, event.target.checked);
                      }
                    }}
                  />
                  <span className="toggle-track" aria-hidden="true" />
                  Fix Swagger bugs
                </label>
              </div>
              <span className="shortcut-hint" aria-hidden="true">
                <kbd>Ctrl</kbd>
                <kbd>Enter</kbd>
              </span>
              <button
                type="button"
                className="convert-button"
                onClick={() => runConversion(input)}
                disabled={assessment.status !== "valid"}
              >
                <span>
                  Convert<span className="long-label"> to OpenAPI 3</span>
                </span>
                <ArrowRightIcon />
              </button>
            </div>
          </div>
        </section>

        <section className="mapping-section shell" id="mapping">
          <div className="section-intro">
            <span className="section-label">What changes</span>
            <h2>
              Every Swagger 2.0 concept, <span className="gradient-text">remapped</span>.
            </h2>
            <p>
              SpecLift follows the same rules as Swagger&apos;s converter, so
              tooling that expects its output keeps working.
            </p>
          </div>
          <ul className="mapping-grid">
            {MAPPINGS.map(([from, to]) => (
              <li key={from}>
                <code className="from">{from}</code>
                <ArrowRightIcon className="mapping-arrow" />
                <code className="to">{to}</code>
              </li>
            ))}
          </ul>
        </section>

        <section className="bugs-section shell" id="bugs">
          <div className="section-intro">
            <span className="section-label">Swagger&apos;s bugs, fixed</span>
            <h2>
              Same rules. <span className="gradient-text">Fewer surprises.</span>
            </h2>
            <p>
              In a few places Swagger&apos;s converter writes invalid OpenAPI or
              quietly drops data. SpecLift fixes these by default. Turn off
              &ldquo;Fix Swagger bugs&rdquo; for byte-for-byte Swagger output.
            </p>
          </div>
          <ul className="bug-grid">
            {BUG_FIXES.map((bug) => (
              <li key={bug.swagger}>
                <span className="bug-label is-swagger">Swagger</span>
                <code>{bug.swagger}</code>
                <span className="bug-label is-fixed">SpecLift</span>
                <code className="is-fixed">{bug.fixed}</code>
              </li>
            ))}
          </ul>
        </section>

        <section className="trust-section shell" id="privacy">
          <div className="section-intro">
            <span className="section-label">Private by design</span>
            <h2>Your API never leaves the tab.</h2>
            <p>
              Internal specs often describe systems nobody outside your team
              should see. SpecLift has no backend to send them to.
            </p>
          </div>
          <div className="trust-grid">
            <article className="trust-card">
              <span className="trust-icon">
                <CpuIcon />
              </span>
              <h3>Runs in your browser</h3>
              <p>
                Files are read with the FileReader API, converted in memory
                and downloaded from a local Blob.
              </p>
            </article>
            <article className="trust-card">
              <span className="trust-icon">
                <EyeOffIcon />
              </span>
              <h3>No tracking, no storage</h3>
              <p>
                No accounts, analytics, telemetry or third-party fonts. Close
                the tab and nothing remains.
              </p>
            </article>
            <article className="trust-card" id="parity">
              <span className="trust-icon">
                <ScaleIcon />
              </span>
              <h3>Swagger-exact on demand</h3>
              <p>
                With bug fixes off, output is identical to
                converter.swagger.io, key order included. That is tested on 99
                real-world APIs and 54 edge-case fixtures.
              </p>
            </article>
          </div>
        </section>

        <section className="sponsor-band shell" aria-labelledby="sponsor-title">
          <div>
            <h2 id="sponsor-title">Free, open source, and staying that way.</h2>
            <p>
              If SpecLift saves you an afternoon of hand-migrating specs,
              sponsoring keeps it maintained and bug-for-bug current with
              Swagger.
            </p>
          </div>
          <a
            className="sponsor-badge is-large"
            href={SPONSOR_URL}
            target="_blank"
            rel="noreferrer"
          >
            <HeartIcon />
            <span>Sponsor on GitHub</span>
          </a>
        </section>
      </main>

      <footer className="site-footer">
        <div className="shell footer-inner">
          <span className="brand footer-brand">
            <LogoMark className="brand-mark" />
            SpecLift
          </span>
          <p>Private Swagger 2.0 → OpenAPI 3 conversion. MIT licensed.</p>
          <div className="footer-links">
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              <GitHubIcon /> Source
            </a>
            <a
              className="footer-sponsor"
              href={SPONSOR_URL}
              target="_blank"
              rel="noreferrer"
            >
              <HeartIcon /> Sponsor
            </a>
            <a href="#top">Back to top ↑</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
