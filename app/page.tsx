"use client";

import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useMemo,
  useRef,
  useState,
} from "react";

type JsonRecord = Record<string, unknown>;

const SAMPLE_SWAGGER = {
  swagger: "2.0",
  info: {
    title: "Orders API",
    description: "Create and track customer orders.",
    version: "1.4.0",
  },
  host: "api.example.com",
  basePath: "/v1",
  schemes: ["https"],
  consumes: ["application/json"],
  produces: ["application/json"],
  paths: {
    "/orders": {
      get: {
        summary: "List orders",
        operationId: "listOrders",
        parameters: [
          {
            name: "limit",
            in: "query",
            type: "integer",
            format: "int32",
            default: 20,
          },
        ],
        responses: {
          "200": {
            description: "A list of orders",
            schema: {
              type: "array",
              items: { $ref: "#/definitions/Order" },
            },
          },
        },
      },
      post: {
        summary: "Create an order",
        operationId: "createOrder",
        parameters: [
          {
            name: "order",
            in: "body",
            required: true,
            schema: { $ref: "#/definitions/NewOrder" },
          },
        ],
        responses: {
          "201": {
            description: "Order created",
            schema: { $ref: "#/definitions/Order" },
          },
        },
      },
    },
  },
  definitions: {
    NewOrder: {
      type: "object",
      required: ["productId", "quantity"],
      properties: {
        productId: { type: "string" },
        quantity: { type: "integer", minimum: 1 },
      },
    },
    Order: {
      allOf: [
        { $ref: "#/definitions/NewOrder" },
        {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["pending", "shipped"] },
          },
        },
      ],
    },
  },
};

const SAMPLE_TEXT = JSON.stringify(SAMPLE_SWAGGER, null, 2);
const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rewriteRefs);
  }

  if (!isRecord(value)) {
    return value;
  }

  const output: JsonRecord = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "$ref" && typeof nestedValue === "string") {
      output[key] = nestedValue
        .replace("#/definitions/", "#/components/schemas/")
        .replace("#/parameters/", "#/components/parameters/")
        .replace("#/responses/", "#/components/responses/")
        .replace(
          "#/securityDefinitions/",
          "#/components/securitySchemes/",
        );
    } else {
      output[key] = rewriteRefs(nestedValue);
    }
  }
  return output;
}

function parameterSchema(parameter: JsonRecord): JsonRecord {
  if (isRecord(parameter.schema)) {
    return rewriteRefs(parameter.schema) as JsonRecord;
  }

  const schemaKeys = [
    "type",
    "format",
    "items",
    "default",
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
    "enum",
    "multipleOf",
  ];
  const schema: JsonRecord = {};

  for (const key of schemaKeys) {
    if (parameter[key] !== undefined) {
      schema[key] = rewriteRefs(parameter[key]);
    }
  }

  if (schema.type === "file") {
    schema.type = "string";
    schema.format = "binary";
  }

  return schema;
}

function collectionStyle(collectionFormat: unknown, location: unknown) {
  if (collectionFormat === "multi") {
    return location === "query"
      ? { style: "form", explode: true }
      : { style: "simple", explode: true };
  }
  if (collectionFormat === "ssv") return { style: "spaceDelimited", explode: false };
  if (collectionFormat === "pipes") return { style: "pipeDelimited", explode: false };
  if (collectionFormat === "csv") {
    return location === "query"
      ? { style: "form", explode: false }
      : { style: "simple", explode: false };
  }
  return {};
}

function convertParameter(parameter: JsonRecord): JsonRecord {
  const output: JsonRecord = {};
  const preserved = [
    "name",
    "in",
    "description",
    "required",
    "deprecated",
    "allowEmptyValue",
  ];

  for (const key of preserved) {
    if (parameter[key] !== undefined) {
      output[key] = parameter[key];
    }
  }

  output.schema = parameterSchema(parameter);
  Object.assign(
    output,
    collectionStyle(parameter.collectionFormat, parameter.in),
  );
  return rewriteRefs(output) as JsonRecord;
}

function convertResponse(
  response: unknown,
  mediaTypes: string[],
): unknown {
  if (!isRecord(response)) return response;

  const output: JsonRecord = {};
  for (const [key, value] of Object.entries(response)) {
    if (!["schema", "examples"].includes(key)) {
      output[key] = rewriteRefs(value);
    }
  }

  if (isRecord(response.headers)) {
    const headers: JsonRecord = {};
    for (const [name, header] of Object.entries(response.headers)) {
      headers[name] = isRecord(header)
        ? {
            ...(header.description !== undefined
              ? { description: header.description }
              : {}),
            schema: parameterSchema(header),
          }
        : header;
    }
    output.headers = headers;
  }

  if (response.schema !== undefined || isRecord(response.examples)) {
    const content: JsonRecord = {};
    const types =
      mediaTypes.length > 0
        ? mediaTypes
        : isRecord(response.examples)
          ? Object.keys(response.examples)
          : ["application/json"];

    for (const mediaType of types) {
      const media: JsonRecord = {};
      if (response.schema !== undefined) {
        media.schema = rewriteRefs(response.schema);
      }
      if (isRecord(response.examples) && response.examples[mediaType] !== undefined) {
        media.example = response.examples[mediaType];
      }
      content[mediaType] = media;
    }
    output.content = content;
  }

  return output;
}

function oauthFlow(definition: JsonRecord): JsonRecord {
  const scopes = isRecord(definition.scopes) ? definition.scopes : {};
  switch (definition.flow) {
    case "implicit":
      return {
        implicit: {
          authorizationUrl: definition.authorizationUrl,
          scopes,
        },
      };
    case "password":
      return {
        password: {
          tokenUrl: definition.tokenUrl,
          scopes,
        },
      };
    case "application":
      return {
        clientCredentials: {
          tokenUrl: definition.tokenUrl,
          scopes,
        },
      };
    case "accessCode":
      return {
        authorizationCode: {
          authorizationUrl: definition.authorizationUrl,
          tokenUrl: definition.tokenUrl,
          scopes,
        },
      };
    default:
      return {};
  }
}

function convertSecurityScheme(definition: unknown): unknown {
  if (!isRecord(definition)) return definition;
  if (definition.type === "basic") {
    return {
      type: "http",
      scheme: "basic",
      ...(definition.description
        ? { description: definition.description }
        : {}),
    };
  }
  if (definition.type === "oauth2") {
    return {
      type: "oauth2",
      ...(definition.description
        ? { description: definition.description }
        : {}),
      flows: oauthFlow(definition),
    };
  }
  return rewriteRefs(definition);
}

function convertSwagger(swagger: JsonRecord): JsonRecord {
  if (swagger.swagger !== "2.0") {
    throw new Error('Expected a Swagger document with "swagger": "2.0".');
  }
  if (!isRecord(swagger.info)) {
    throw new Error('The document is missing the required "info" object.');
  }
  if (!isRecord(swagger.paths)) {
    throw new Error('The document is missing the required "paths" object.');
  }

  const output: JsonRecord = {
    openapi: "3.0.3",
    info: rewriteRefs(swagger.info),
  };

  const rootFields = ["tags", "externalDocs", "security"];
  for (const field of rootFields) {
    if (swagger[field] !== undefined) {
      output[field] = rewriteRefs(swagger[field]);
    }
  }

  const schemes = Array.isArray(swagger.schemes)
    ? swagger.schemes.filter((scheme): scheme is string => typeof scheme === "string")
    : [];
  if (typeof swagger.host === "string") {
    const serverSchemes = schemes.length > 0 ? schemes : ["https"];
    output.servers = serverSchemes.map((scheme) => ({
      url: `${scheme}://${swagger.host}${
        typeof swagger.basePath === "string" ? swagger.basePath : ""
      }`,
    }));
  } else if (typeof swagger.basePath === "string") {
    output.servers = [{ url: swagger.basePath }];
  }

  const globalConsumes = Array.isArray(swagger.consumes)
    ? swagger.consumes.filter((value): value is string => typeof value === "string")
    : ["application/json"];
  const globalProduces = Array.isArray(swagger.produces)
    ? swagger.produces.filter((value): value is string => typeof value === "string")
    : ["application/json"];

  const paths: JsonRecord = {};
  for (const [pathName, rawPath] of Object.entries(swagger.paths)) {
    if (!isRecord(rawPath)) {
      paths[pathName] = rawPath;
      continue;
    }

    const pathItem: JsonRecord = {};
    for (const [pathKey, rawOperation] of Object.entries(rawPath)) {
      if (pathKey === "$ref") {
        pathItem[pathKey] = rewriteRefs(rawOperation);
        continue;
      }

      if (pathKey === "parameters" && Array.isArray(rawOperation)) {
        pathItem.parameters = rawOperation
          .filter(isRecord)
          .filter((parameter) => !["body", "formData"].includes(String(parameter.in)))
          .map(convertParameter);
        continue;
      }

      if (!HTTP_METHODS.has(pathKey) || !isRecord(rawOperation)) {
        pathItem[pathKey] = rewriteRefs(rawOperation);
        continue;
      }

      const operation: JsonRecord = {};
      const operationConsumes = Array.isArray(rawOperation.consumes)
        ? rawOperation.consumes.filter(
            (value): value is string => typeof value === "string",
          )
        : globalConsumes;
      const operationProduces = Array.isArray(rawOperation.produces)
        ? rawOperation.produces.filter(
            (value): value is string => typeof value === "string",
          )
        : globalProduces;

      for (const [key, value] of Object.entries(rawOperation)) {
        if (!["parameters", "responses", "consumes", "produces", "schemes"].includes(key)) {
          operation[key] = rewriteRefs(value);
        }
      }

      const parameters = Array.isArray(rawOperation.parameters)
        ? rawOperation.parameters.filter(isRecord)
        : [];
      const regularParameters = parameters.filter(
        (parameter) => !["body", "formData"].includes(String(parameter.in)),
      );
      if (regularParameters.length > 0) {
        operation.parameters = regularParameters.map(convertParameter);
      }

      const bodyParameter = parameters.find(
        (parameter) => parameter.in === "body",
      );
      const formParameters = parameters.filter(
        (parameter) => parameter.in === "formData",
      );

      if (bodyParameter) {
        const content: JsonRecord = {};
        for (const mediaType of operationConsumes.length > 0
          ? operationConsumes
          : ["application/json"]) {
          content[mediaType] = {
            schema: parameterSchema(bodyParameter),
          };
        }
        operation.requestBody = {
          ...(bodyParameter.description !== undefined
            ? { description: bodyParameter.description }
            : {}),
          ...(bodyParameter.required !== undefined
            ? { required: bodyParameter.required }
            : {}),
          content,
        };
      } else if (formParameters.length > 0) {
        const properties: JsonRecord = {};
        const required: string[] = [];
        for (const parameter of formParameters) {
          if (typeof parameter.name !== "string") continue;
          properties[parameter.name] = {
            ...parameterSchema(parameter),
            ...(parameter.description
              ? { description: parameter.description }
              : {}),
          };
          if (parameter.required) required.push(parameter.name);
        }
        const formSchema: JsonRecord = { type: "object", properties };
        if (required.length > 0) formSchema.required = required;

        const content: JsonRecord = {};
        for (const mediaType of operationConsumes.length > 0
          ? operationConsumes
          : ["application/x-www-form-urlencoded"]) {
          content[mediaType] = { schema: formSchema };
        }
        operation.requestBody = { content };
      }

      if (isRecord(rawOperation.responses)) {
        const responses: JsonRecord = {};
        for (const [status, response] of Object.entries(rawOperation.responses)) {
          responses[status] = convertResponse(response, operationProduces);
        }
        operation.responses = responses;
      }

      if (Array.isArray(rawOperation.schemes) && typeof swagger.host === "string") {
        operation.servers = rawOperation.schemes
          .filter((scheme): scheme is string => typeof scheme === "string")
          .map((scheme) => ({
            url: `${scheme}://${swagger.host}${
              typeof swagger.basePath === "string" ? swagger.basePath : ""
            }`,
          }));
      }

      pathItem[pathKey] = operation;
    }
    paths[pathName] = pathItem;
  }
  output.paths = paths;

  const components: JsonRecord = {};
  if (isRecord(swagger.definitions)) {
    components.schemas = rewriteRefs(swagger.definitions);
  }
  if (isRecord(swagger.securityDefinitions)) {
    const securitySchemes: JsonRecord = {};
    for (const [name, definition] of Object.entries(swagger.securityDefinitions)) {
      securitySchemes[name] = convertSecurityScheme(definition);
    }
    components.securitySchemes = securitySchemes;
  }
  if (isRecord(swagger.parameters)) {
    const parameters: JsonRecord = {};
    for (const [name, parameter] of Object.entries(swagger.parameters)) {
      if (isRecord(parameter) && !["body", "formData"].includes(String(parameter.in))) {
        parameters[name] = convertParameter(parameter);
      }
    }
    if (Object.keys(parameters).length > 0) components.parameters = parameters;
  }
  if (isRecord(swagger.responses)) {
    const responses: JsonRecord = {};
    for (const [name, response] of Object.entries(swagger.responses)) {
      responses[name] = convertResponse(response, globalProduces);
    }
    components.responses = responses;
  }
  if (Object.keys(components).length > 0) {
    output.components = components;
  }

  return output;
}

function countOperations(paths: unknown) {
  if (!isRecord(paths)) return 0;
  return Object.values(paths).reduce<number>((count, path) => {
    if (!isRecord(path)) return count;
    return (
      count +
      Object.keys(path).filter((key) => HTTP_METHODS.has(key)).length
    );
  }, 0);
}

function initialOutput() {
  return JSON.stringify(convertSwagger(SAMPLE_SWAGGER), null, 2);
}

export default function Home() {
  const [input, setInput] = useState(SAMPLE_TEXT);
  const [output, setOutput] = useState(initialOutput);
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stats = useMemo(() => {
    try {
      const parsed = JSON.parse(output) as JsonRecord;
      const paths = isRecord(parsed.paths) ? parsed.paths : {};
      const schemas =
        isRecord(parsed.components) && isRecord(parsed.components.schemas)
          ? parsed.components.schemas
          : {};
      return {
        endpoints: Object.keys(paths).length,
        operations: countOperations(paths),
        schemas: Object.keys(schemas).length,
      };
    } catch {
      return { endpoints: 0, operations: 0, schemas: 0 };
    }
  }, [output]);

  function runConversion(source = input) {
    try {
      const parsed: unknown = JSON.parse(source);
      if (!isRecord(parsed)) {
        throw new Error("The top level of your Swagger file must be an object.");
      }
      const converted = convertSwagger(parsed);
      setOutput(JSON.stringify(converted, null, 2));
      setError("");
    } catch (conversionError) {
      setError(
        conversionError instanceof Error
          ? conversionError.message
          : "We could not read this Swagger document.",
      );
    }
  }

  function loadFile(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setError("Please choose a JSON file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      setInput(content);
      runConversion(content);
    };
    reader.onerror = () => setError("We could not read that file.");
    reader.readAsText(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    loadFile(event.dataTransfer.files[0]);
  }

  function handleDropzoneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInputRef.current?.click();
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    loadFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function formatInput() {
    try {
      const parsed = JSON.parse(input);
      setInput(JSON.stringify(parsed, null, 2));
      setError("");
    } catch {
      setError("Fix the JSON syntax before formatting.");
    }
  }

  async function copyOutput() {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function downloadOutput() {
    const blob = new Blob([output], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "openapi.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <nav className="nav shell" aria-label="Main navigation">
        <a className="brand" href="#" aria-label="SpecLift home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <span>SpecLift</span>
        </a>
        <div className="nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="#privacy">Privacy</a>
          <span className="local-pill">
            <span className="pulse-dot" />
            Runs locally
          </span>
        </div>
      </nav>

      <section className="hero shell" aria-labelledby="hero-title">
        <div className="eyebrow">
          <span className="eyebrow-icon">↗</span>
          Swagger 2.0 → OpenAPI 3.0.3
        </div>
        <h1 id="hero-title">
          Modernize your API spec.
          <span> Keep every byte private.</span>
        </h1>
        <p className="hero-copy">
          Convert Swagger 2 JSON into a clean OpenAPI 3 specification,
          instantly. No uploads, no accounts, no external services.
        </p>
        <div className="hero-proof" aria-label="Privacy guarantees">
          <span><b>01</b> Browser-only processing</span>
          <span><b>02</b> Zero data retention</span>
          <span><b>03</b> Ready to download</span>
        </div>
      </section>

      <section className="workspace-shell shell" aria-label="API specification converter">
        <div className="workspace-topbar">
          <div className="window-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="privacy-status">
            <span className="lock-icon" aria-hidden="true">⌾</span>
            <span><strong>Private session</strong> · Nothing leaves this browser</span>
          </div>
          <span className="version-chip">v2 → v3</span>
        </div>

        <div className="workspace">
          <div
            className={`editor-panel input-panel ${isDragging ? "is-dragging" : ""}`}
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
              <div>
                <span className="panel-kicker">INPUT</span>
                <h2>Swagger 2 JSON</h2>
              </div>
              <div className="panel-actions">
                <button type="button" className="text-button" onClick={formatInput}>
                  Format
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setInput("");
                    setError("");
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            <label className="sr-only" htmlFor="swagger-input">
              Swagger 2 JSON input
            </label>
            <textarea
              id="swagger-input"
              spellCheck={false}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              aria-describedby={error ? "conversion-error" : undefined}
            />

            <div
              className="drop-row"
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={handleDropzoneKeyDown}
              aria-label="Upload a Swagger JSON file"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleFileChange}
                hidden
              />
              <span className="upload-icon" aria-hidden="true">↑</span>
              <span>
                <strong>Drop a JSON file here</strong>
                <small>or click to browse · processed on your device</small>
              </span>
            </div>

            <div className="input-footer">
              <span className={error ? "input-state error-state" : "input-state"}>
                <span aria-hidden="true">{error ? "!" : "✓"}</span>
                {error ? "Needs attention" : "Valid Swagger 2.0"}
              </span>
              <button
                type="button"
                className="sample-button"
                onClick={() => {
                  setInput(SAMPLE_TEXT);
                  runConversion(SAMPLE_TEXT);
                }}
              >
                Load sample
              </button>
            </div>
          </div>

          <div className="convert-rail" aria-hidden="true">
            <span>→</span>
          </div>

          <div className="editor-panel output-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">OUTPUT</span>
                <h2>OpenAPI 3.0.3</h2>
              </div>
              <div className="panel-actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={copyOutput}
                  aria-label="Copy converted OpenAPI JSON"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
                <button
                  type="button"
                  className="download-button"
                  onClick={downloadOutput}
                >
                  <span aria-hidden="true">↓</span> Download
                </button>
              </div>
            </div>

            <pre className="output-code" tabIndex={0} aria-label="Converted OpenAPI JSON">
              <code>{output}</code>
            </pre>

            <div className="output-footer">
              <span><b>{stats.endpoints}</b> paths</span>
              <span><b>{stats.operations}</b> operations</span>
              <span><b>{stats.schemas}</b> schemas</span>
            </div>
          </div>
        </div>

        <div className="conversion-bar">
          <div className="error-message" id="conversion-error" aria-live="polite">
            {error || "Ready when you are. Your source never leaves this tab."}
          </div>
          <button type="button" className="convert-button" onClick={() => runConversion()}>
            <span>Convert to OpenAPI 3</span>
            <span className="button-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </section>

      <section className="trust-strip">
        <div className="shell trust-strip-inner">
          <p>Built for APIs that should stay yours.</p>
          <div>
            <span>NO NETWORK REQUESTS</span>
            <span>NO FILE UPLOADS</span>
            <span>NO TELEMETRY</span>
          </div>
        </div>
      </section>

      <section className="privacy-section shell" id="privacy">
        <div className="section-heading">
          <span className="section-number">01 / PRIVACY</span>
          <h2>Security is not a setting.<br />It is the architecture.</h2>
        </div>
        <div className="privacy-grid">
          <article className="privacy-spotlight">
            <div className="orbital" aria-hidden="true">
              <span className="orbital-core">LOCAL</span>
              <span className="orbit-dot dot-one" />
              <span className="orbit-dot dot-two" />
            </div>
            <div>
              <span className="card-label">IN-BROWSER ENGINE</span>
              <h3>Your API definition stays inside your browser.</h3>
              <p>
                SpecLift performs every transformation with frontend code on
                your device. It has no backend, no analytics, and no external
                service dependency.
              </p>
            </div>
          </article>
          <article className="principle-card">
            <span className="principle-icon">00</span>
            <h3>Zero retention</h3>
            <p>Refresh the page and the session is gone. We never store your spec.</p>
          </article>
          <article className="principle-card dark-card">
            <span className="principle-icon">↯</span>
            <h3>Works offline</h3>
            <p>Once loaded, conversion needs no connection to any service.</p>
          </article>
        </div>
      </section>

      <section className="how-section shell" id="how-it-works">
        <div className="section-heading compact-heading">
          <span className="section-number">02 / WORKFLOW</span>
          <h2>From legacy to ready<br />in three quiet steps.</h2>
        </div>
        <ol className="steps">
          <li>
            <span className="step-number">01</span>
            <div>
              <h3>Paste or drop</h3>
              <p>Add your Swagger 2.0 JSON directly in the secure workspace.</p>
            </div>
          </li>
          <li>
            <span className="step-number">02</span>
            <div>
              <h3>Convert locally</h3>
              <p>References, request bodies, servers, and components are remapped.</p>
            </div>
          </li>
          <li>
            <span className="step-number">03</span>
            <div>
              <h3>Copy or download</h3>
              <p>Take the OpenAPI 3.0.3 JSON into your next tool or repository.</p>
            </div>
          </li>
        </ol>
      </section>

      <footer>
        <div className="shell footer-inner">
          <a className="brand footer-brand" href="#" aria-label="SpecLift home">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
            </span>
            <span>SpecLift</span>
          </a>
          <p>Private, practical API modernization.</p>
          <a href="#hero-title">Back to top ↑</a>
        </div>
      </footer>
    </main>
  );
}
