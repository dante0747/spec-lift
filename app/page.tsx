"use client";

import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  convertParameterReference,
  dereferenceParameter,
  dereferenceResponse,
  isRecord,
  parameterKind,
  rewriteOpenApiReference,
  type JsonRecord,
} from "./converter-refs";

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

function rewriteRefs(
  value: unknown,
  globalParameters: JsonRecord = {},
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteRefs(item, globalParameters));
  }

  if (!isRecord(value)) {
    return value;
  }

  const output: JsonRecord = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "$ref" && typeof nestedValue === "string") {
      output[key] = rewriteOpenApiReference(
        nestedValue,
        globalParameters,
      );
    } else {
      output[key] = rewriteRefs(nestedValue, globalParameters);
    }
  }
  return output;
}

function parameterSchema(
  parameter: JsonRecord,
  globalParameters: JsonRecord = {},
): JsonRecord {
  if (isRecord(parameter.schema)) {
    return rewriteRefs(parameter.schema, globalParameters) as JsonRecord;
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
      schema[key] = rewriteRefs(parameter[key], globalParameters);
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

function convertParameter(
  parameter: JsonRecord,
  globalParameters: JsonRecord = {},
): JsonRecord {
  const reference = convertParameterReference(
    parameter,
    globalParameters,
  );
  if (reference) return reference;

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

  output.schema = parameterSchema(parameter, globalParameters);
  Object.assign(
    output,
    collectionStyle(parameter.collectionFormat, parameter.in),
  );
  return rewriteRefs(output, globalParameters) as JsonRecord;
}

function convertBodyParameter(
  parameter: JsonRecord,
  mediaTypes: string[],
  globalParameters: JsonRecord,
  inlineReference = false,
): JsonRecord {
  if (inlineReference) {
    const resolved = dereferenceParameter(
      parameter,
      globalParameters,
    );
    if (resolved !== parameter) {
      return convertBodyParameter(
        resolved,
        mediaTypes,
        globalParameters,
        false,
      );
    }
  }

  const reference = convertParameterReference(
    parameter,
    globalParameters,
  );
  if (reference) return reference;

  const content: JsonRecord = {};
  for (const mediaType of mediaTypes.length > 0
    ? mediaTypes
    : ["application/json"]) {
    content[mediaType] = {
      schema: parameterSchema(parameter, globalParameters),
    };
  }

  return {
    ...(parameter.description !== undefined
      ? { description: parameter.description }
      : {}),
    ...(parameter.required !== undefined
      ? { required: parameter.required }
      : {}),
    content,
  };
}

function convertFormParameters(
  parameters: JsonRecord[],
  mediaTypes: string[],
  globalParameters: JsonRecord,
): JsonRecord {
  const properties: JsonRecord = {};
  const required: string[] = [];

  for (const parameter of parameters) {
    const resolved = dereferenceParameter(
      parameter,
      globalParameters,
    );
    if (typeof resolved.name !== "string") continue;

    properties[resolved.name] = {
      ...parameterSchema(resolved, globalParameters),
      ...(resolved.description
        ? { description: resolved.description }
        : {}),
    };
    if (resolved.required) required.push(resolved.name);
  }

  const formSchema: JsonRecord = { type: "object", properties };
  if (required.length > 0) formSchema.required = required;

  const content: JsonRecord = {};
  for (const mediaType of mediaTypes.length > 0
    ? mediaTypes
    : ["application/x-www-form-urlencoded"]) {
    content[mediaType] = { schema: formSchema };
  }

  return {
    content,
    ...(required.length > 0 ? { required: true } : {}),
  };
}

function convertResponse(
  response: unknown,
  mediaTypes: string[],
  globalResponses: JsonRecord = {},
  inlineReference = false,
): unknown {
  if (!isRecord(response)) return response;

  if (inlineReference) {
    const resolved = dereferenceResponse(response, globalResponses);
    if (resolved !== response) {
      return convertResponse(
        resolved,
        mediaTypes,
        globalResponses,
        false,
      );
    }
  }

  if (typeof response.$ref === "string") {
    return {
      $ref: rewriteOpenApiReference(response.$ref, {}),
    };
  }

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

  const globalParameters = isRecord(swagger.parameters)
    ? swagger.parameters
    : {};
  const globalResponses = isRecord(swagger.responses)
    ? swagger.responses
    : {};
  const output: JsonRecord = {
    openapi: "3.0.3",
    info: rewriteRefs(swagger.info, globalParameters),
  };

  const rootFields = ["tags", "externalDocs", "security"];
  for (const field of rootFields) {
    if (swagger[field] !== undefined) {
      output[field] = rewriteRefs(
        swagger[field],
        globalParameters,
      );
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

    const inheritedParameters = Array.isArray(rawPath.parameters)
      ? rawPath.parameters.filter(isRecord)
      : [];
    const pathItem: JsonRecord = {};
    for (const [pathKey, rawOperation] of Object.entries(rawPath)) {
      if (pathKey === "$ref") {
        pathItem[pathKey] = rewriteRefs(
          rawOperation,
          globalParameters,
        );
        continue;
      }

      if (pathKey === "parameters" && Array.isArray(rawOperation)) {
        pathItem.parameters = rawOperation
          .filter(isRecord)
          .filter((parameter) =>
            ["parameter", "unknown"].includes(
              parameterKind(parameter, globalParameters),
            ),
          )
          .map((parameter) =>
            convertParameter(
              parameter,
              globalParameters,
            ),
          );
        continue;
      }

      if (!HTTP_METHODS.has(pathKey) || !isRecord(rawOperation)) {
        pathItem[pathKey] = rewriteRefs(
          rawOperation,
          globalParameters,
        );
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
          operation[key] = rewriteRefs(value, globalParameters);
        }
      }

      const operationParameters = Array.isArray(rawOperation.parameters)
        ? rawOperation.parameters.filter(isRecord)
        : [];
      const inheritedRequestParameters = inheritedParameters.filter(
        (parameter) =>
          ["body", "formData"].includes(
            parameterKind(parameter, globalParameters),
          ),
      );
      const requestParameters = [
        ...operationParameters,
        ...inheritedRequestParameters,
      ];
      const regularParameters = operationParameters.filter(
        (parameter) =>
          ["parameter", "unknown"].includes(
            parameterKind(parameter, globalParameters),
          ),
      );
      if (regularParameters.length > 0) {
        operation.parameters = regularParameters.map((parameter) =>
          convertParameter(
            parameter,
            globalParameters,
          ),
        );
      }

      const bodyParameter = requestParameters.find(
        (parameter) =>
          parameterKind(parameter, globalParameters) === "body",
      );
      const formParameters = requestParameters.filter(
        (parameter) =>
          parameterKind(parameter, globalParameters) ===
          "formData",
      );

      if (bodyParameter) {
        operation.requestBody = convertBodyParameter(
          bodyParameter,
          operationConsumes,
          globalParameters,
          Array.isArray(rawOperation.consumes),
        );
        const resolvedBodyParameter = dereferenceParameter(
          bodyParameter,
          globalParameters,
        );
        if (typeof resolvedBodyParameter.name === "string") {
          operation["x-codegen-request-body-name"] =
            resolvedBodyParameter.name;
        }
      } else if (formParameters.length > 0) {
        const reusableFormBody =
          formParameters.length === 1 &&
          !Array.isArray(rawOperation.consumes)
            ? convertParameterReference(
                formParameters[0],
                globalParameters,
              )
            : null;
        operation.requestBody =
          reusableFormBody ??
          convertFormParameters(
            formParameters,
            operationConsumes,
            globalParameters,
          );
      }

      if (isRecord(rawOperation.responses)) {
        const responses: JsonRecord = {};
        for (const [status, response] of Object.entries(rawOperation.responses)) {
          responses[status] = convertResponse(
            response,
            operationProduces,
            globalResponses,
            Array.isArray(rawOperation.produces),
          );
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
    components.schemas = rewriteRefs(
      swagger.definitions,
      globalParameters,
    );
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
    const requestBodies: JsonRecord = {};
    for (const [name, parameter] of Object.entries(swagger.parameters)) {
      if (!isRecord(parameter)) continue;

      const kind = parameterKind(parameter, globalParameters);
      if (kind === "body") {
        requestBodies[name] = convertBodyParameter(
          parameter,
          globalConsumes,
          globalParameters,
        );
      } else if (kind === "formData") {
        requestBodies[name] = convertFormParameters(
          [parameter],
          globalConsumes,
          globalParameters,
        );
      } else {
        parameters[name] = convertParameter(
          parameter,
          globalParameters,
        );
      }
    }
    if (Object.keys(parameters).length > 0) components.parameters = parameters;
    if (Object.keys(requestBodies).length > 0) {
      components.requestBodies = requestBodies;
    }
  }
  if (isRecord(swagger.responses)) {
    const responses: JsonRecord = {};
    for (const [name, response] of Object.entries(swagger.responses)) {
      responses[name] = convertResponse(
        response,
        globalProduces,
        globalResponses,
      );
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

type InputAssessment = {
  status: "empty" | "invalid" | "valid";
  label: string;
  message: string;
};

function assessInput(source: string): InputAssessment {
  if (!source.trim()) {
    return {
      status: "empty",
      label: "Waiting for input",
      message: "Paste JSON or choose a Swagger 2.0 file.",
    };
  }

  try {
    const parsed: unknown = JSON.parse(source);
    if (!isRecord(parsed)) {
      return {
        status: "invalid",
        label: "JSON object required",
        message: "The top level of the document must be an object.",
      };
    }
    if (parsed.swagger !== "2.0") {
      return {
        status: "invalid",
        label: "Swagger 2.0 required",
        message: 'Expected a document with "swagger": "2.0".',
      };
    }
    if (!isRecord(parsed.info)) {
      return {
        status: "invalid",
        label: "Missing info object",
        message: 'Add the required top-level "info" object.',
      };
    }
    if (!isRecord(parsed.paths)) {
      return {
        status: "invalid",
        label: "Missing paths object",
        message: 'Add the required top-level "paths" object.',
      };
    }

    return {
      status: "valid",
      label: "Valid Swagger 2.0",
      message: "Ready to convert locally.",
    };
  } catch (parseError) {
    return {
      status: "invalid",
      label: "Invalid JSON",
      message:
        parseError instanceof SyntaxError
          ? parseError.message
          : "Check the JSON syntax and try again.",
    };
  }
}

function textMetrics(value: string) {
  return {
    characters: value.length,
    lines: value ? value.split("\n").length : 0,
  };
}

export default function Home() {
  const [input, setInput] = useState(SAMPLE_TEXT);
  const [output, setOutput] = useState(initialOutput);
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lastConvertedInput, setLastConvertedInput] = useState(SAMPLE_TEXT);
  const [notice, setNotice] = useState(
    "Sample converted. Replace it with your Swagger document.",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const inputAssessment = useMemo(() => assessInput(input), [input]);
  const inputMetrics = useMemo(() => textMetrics(input), [input]);
  const outputMetrics = useMemo(() => textMetrics(output), [output]);
  const outputIsStale = input !== lastConvertedInput;

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
      setLastConvertedInput(source);
      setError("");
      setNotice("Conversion complete. Review the result before production use.");
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
    if (file.size > 10 * 1024 * 1024) {
      setError("That file is over 10 MB. Choose a smaller Swagger document.");
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
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setError("");
      setNotice("OpenAPI JSON copied to your clipboard.");
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copy failed. Select the output and copy it manually.");
    }
  }

  function downloadOutput() {
    if (!output) return;
    const blob = new Blob([output], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "openapi.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="site-frame">
      <header className="site-header">
        <div className="shell header-inner">
          <a className="brand" href="#top" aria-label="SpecLift home">
            <span className="brand-glyph" aria-hidden="true">&gt;_</span>
            <span>SpecLift</span>
          </a>
          <nav className="nav-links" aria-label="Main navigation">
            <a href="#converter">Converter</a>
            <a href="#workflow">How it works</a>
            <span className="local-pill">
              <span className="pulse-dot" aria-hidden="true" />
              Local only
            </span>
          </nav>
        </div>
      </header>

      <section className="hero shell" id="top" aria-labelledby="hero-title">
        <div className="hero-copy-block">
          <div className="eyebrow">
            <span aria-hidden="true">●</span>
            Swagger 2.0 → OpenAPI 3.0.3
          </div>
          <h1 id="hero-title">
            Modernize your API spec.
            <span> Keep it local.</span>
          </h1>
          <p className="hero-copy">
            A focused, browser-only workspace for converting Swagger JSON.
            No uploads, accounts, telemetry, or hidden network calls.
          </p>
        </div>
        <div className="hero-terminal" aria-label="Privacy summary">
          <div className="terminal-command">
            <span>$</span> speclift --privacy
          </div>
          <dl>
            <div>
              <dt>processing</dt>
              <dd>in browser</dd>
            </div>
            <div>
              <dt>retention</dt>
              <dd>none</dd>
            </div>
            <div>
              <dt>network</dt>
              <dd>offline-ready</dd>
            </div>
          </dl>
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
          <span className="workspace-title">speclift / converter</span>
          <div className="privacy-status">
            <span className="lock-icon" aria-hidden="true">◇</span>
            <span>Nothing leaves this browser</span>
          </div>
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
              <div className="panel-title">
                <span className="panel-kicker">INPUT</span>
                <h2>swagger.json</h2>
              </div>
              <div className="panel-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Open file
                </button>
                <button type="button" className="ghost-button" onClick={formatInput}>
                  Format
                </button>
                <button
                  type="button"
                  className="ghost-button danger-button"
                  onClick={() => {
                    setInput("");
                    setOutput("");
                    setLastConvertedInput("");
                    setError("");
                    setNotice("Input and output cleared.");
                  }}
                  disabled={!input && !output}
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
              wrap="off"
              value={input}
              placeholder={'{\n  "swagger": "2.0",\n  "info": { ... },\n  "paths": { ... }\n}'}
              onChange={(event) => {
                setInput(event.target.value);
                setError("");
                setCopied(false);
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  runConversion();
                }
              }}
              aria-describedby="input-status conversion-message"
              aria-invalid={inputAssessment.status === "invalid"}
            />

            <div
              className="drop-row"
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={handleDropzoneKeyDown}
              aria-label="Choose a Swagger JSON file, or drop one anywhere in the input panel"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleFileChange}
                hidden
              />
              <span className="upload-icon" aria-hidden="true">+</span>
              <span>
                <strong>Drop .json anywhere in this pane</strong>
                <small>or choose a file · 10 MB maximum</small>
              </span>
            </div>

            <div className="panel-footer">
              <span
                className={`input-state state-${inputAssessment.status}`}
                id="input-status"
              >
                <span aria-hidden="true">
                  {inputAssessment.status === "valid"
                    ? "●"
                    : inputAssessment.status === "invalid"
                      ? "×"
                      : "○"}
                </span>
                {inputAssessment.label}
              </span>
              <span className="editor-metrics">
                Ln {inputMetrics.lines} · {inputMetrics.characters.toLocaleString()} chars
              </span>
            </div>
          </div>

          <div className="convert-rail" aria-hidden="true">
            <span>→</span>
          </div>

          <div className="editor-panel output-panel">
            <div className="panel-heading">
              <div className="panel-title">
                <span className="panel-kicker">OUTPUT</span>
                <h2>openapi.json</h2>
              </div>
              <div className="panel-actions">
                <span
                  className={`sync-chip ${outputIsStale ? "is-stale" : ""}`}
                >
                  {outputIsStale ? "Not converted" : "Up to date"}
                </span>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={copyOutput}
                  disabled={!output}
                  aria-label="Copy converted OpenAPI JSON"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className="download-button"
                  onClick={downloadOutput}
                  disabled={!output}
                >
                  <span aria-hidden="true">↓</span> Download
                </button>
              </div>
            </div>

            <pre
              className="output-code"
              tabIndex={0}
              aria-label="Converted OpenAPI JSON"
              aria-live="polite"
            >
              <code>
                {output ||
                  "// Converted OpenAPI 3.0.3 JSON will appear here."}
              </code>
            </pre>

            <div className="panel-footer output-footer">
              <div className="output-stats" aria-label="Output summary">
                <span><b>{stats.endpoints}</b> paths</span>
                <span><b>{stats.operations}</b> operations</span>
                <span><b>{stats.schemas}</b> schemas</span>
              </div>
              <span className="editor-metrics">Ln {outputMetrics.lines}</span>
            </div>
          </div>
        </div>

        <div className="conversion-bar">
          <div
            className={`conversion-message ${error ? "has-error" : ""}`}
            id="conversion-message"
            role="status"
            aria-live="polite"
          >
            <span className="message-symbol" aria-hidden="true">
              {error ? "!" : "i"}
            </span>
            <span>
              <strong>{error ? "Could not convert" : "Local session"}</strong>
              {error || (inputAssessment.status === "invalid"
                ? inputAssessment.message
                : notice)}
            </span>
          </div>
          <div className="conversion-actions">
            <span className="shortcut-hint">
              <kbd>Ctrl</kbd><span>+</span><kbd>Enter</kbd>
            </span>
            <button
              type="button"
              className="convert-button"
              onClick={() => runConversion()}
              disabled={inputAssessment.status !== "valid"}
            >
              <span>Convert to OpenAPI 3</span>
              <span className="button-arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </section>

      <section className="support-strip shell" aria-label="Converter guarantees">
        <span><b>01</b> Browser-only processing</span>
        <span><b>02</b> Zero data retention</span>
        <span><b>03</b> No telemetry</span>
        <button
          type="button"
          className="sample-button"
          onClick={() => {
            setInput(SAMPLE_TEXT);
            runConversion(SAMPLE_TEXT);
          }}
        >
          Reset to sample <span aria-hidden="true">↗</span>
        </button>
      </section>

      <section className="workflow-section shell" id="workflow">
        <div className="section-intro">
          <span className="section-label">HOW IT WORKS</span>
          <h2>Legacy in. Production-ready foundation out.</h2>
          <p>
            SpecLift remaps the common Swagger 2.0 surface while keeping the
            workflow small enough to understand at a glance.
          </p>
        </div>
        <ol className="workflow-grid">
          <li>
            <span className="step-number">01</span>
            <div>
              <h3>Paste or drop</h3>
              <p>Add Swagger 2.0 JSON directly to the scrollable input editor.</p>
            </div>
          </li>
          <li>
            <span className="step-number">02</span>
            <div>
              <h3>Convert locally</h3>
              <p>Servers, bodies, responses, references, and components are remapped.</p>
            </div>
          </li>
          <li>
            <span className="step-number">03</span>
            <div>
              <h3>Review and export</h3>
              <p>Inspect the result, then copy or download the OpenAPI JSON.</p>
            </div>
          </li>
        </ol>
      </section>

      <footer className="site-footer">
        <div className="shell footer-inner">
          <span className="footer-brand"><span aria-hidden="true">&gt;_</span> SpecLift</span>
          <p>Private, practical API modernization.</p>
          <a href="#top">Back to top ↑</a>
        </div>
      </footer>
    </main>
  );
}
