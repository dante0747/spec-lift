import { readFile } from "node:fs/promises";
import ts from "typescript";

function transpile(source, fileName) {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString(
    "base64",
  )}`;
}

async function readApp(fileName) {
  return readFile(new URL(`../app/${fileName}`, import.meta.url), "utf8");
}

/** Loads app/converter.ts (and its helper module) without a build step. */
export async function loadConverter() {
  const [helperSource, converterSource] = await Promise.all([
    readApp("converter-refs.ts"),
    readApp("converter.ts"),
  ]);
  const helperUrl = dataModule(transpile(helperSource, "converter-refs.ts"));
  const engine = transpile(converterSource, "converter.ts").replace(
    /(["'])\.\/converter-refs\1/g,
    `"${helperUrl}"`,
  );
  return import(dataModule(engine));
}

/** Loads app/spec-format.ts (the JSON/YAML reader the UI uses). */
export async function loadSpecFormat() {
  const source = transpile(await readApp("spec-format.ts"), "spec-format.ts");
  // Data-URL modules cannot resolve bare specifiers, so point at js-yaml directly.
  const yamlUrl = import.meta.resolve("js-yaml");
  return import(
    dataModule(source.replace(/(["'])js-yaml\1/g, `"${yamlUrl}"`)),
  );
}
