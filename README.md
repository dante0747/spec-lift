# SpecLift

SpecLift is a private, browser-only converter from Swagger 2.0 (JSON or YAML)
to OpenAPI 3. It produces the same output as Swagger's official converter
([converter.swagger.io](https://converter.swagger.io)), without sending your
spec anywhere. It is designed for teams that cannot send API definitions to
third-party services.

The conversion engine runs entirely in frontend JavaScript. There is no
backend, upload endpoint, account system, analytics SDK, or telemetry.

## What it converts

- hosts, schemes, and base paths into OpenAPI servers
- body and form-data parameters into request bodies
- parameter types and collection formats into OpenAPI 3 schemas and styles
- response schemas, headers, media types, and examples
- definitions into reusable component schemas
- basic, API key, and OAuth 2 security definitions
- Swagger references into their OpenAPI 3 component locations

Input can be pasted, opened, or dropped as `.json`, `.yaml`, or `.yml`, and the
result can be copied or downloaded as JSON or YAML. Live mode re-converts as you
type.

SpecLift targets the common Swagger 2.0 surface. Always review generated specs
before using them in production, especially when the source relies on
vendor-specific extensions or uncommon edge cases.

## Matching Swagger's converter

SpecLift's converter is a port of the rules in Swagger's own converter
(swagger-parser and swagger-core), including its output version
(`openapi: 3.0.1`), default media types (`*/*`), key order, and quirks.
Output is compared as text, so key order counts:

- `tests/fixtures/parity` holds Swagger 2.0 JSON inputs with the output
  converter.swagger.io returned for them.
- `tests/fixtures/parity-yaml` does the same for YAML input, pinning Swagger's
  YAML 1.1 reading rules (`yes`/`no`/`on`/`off` are booleans, `010` is octal,
  unquoted `version: 1.0` stays `"1.0"`).
- `npm test` checks every fixture offline.

To compare against more specs, put `NAME.swagger.json` files in a folder, then:

```bash
node scripts/fetch-swagger-reference.mjs <folder>
node scripts/parity-check.mjs <folder>
```

`scripts/build-apis-guru-corpus.mjs` downloads a sample of public Swagger 2.0
specs from APIs.guru for this. These scripts call converter.swagger.io; the
app itself never does.

Known differences:

- External `$ref`s (other files or URLs) are left as they are. Swagger
  downloads them and rejects the spec if it can't.
- JSON numbers lose some detail in JavaScript: a JSON `1.0` reads as `1`, and
  integers above 2^53 lose precision.
- A parameter reused through a YAML alias (`*name`) is kept. Swagger drops it.
- Swagger 1.x input and Swagger's convert-from-URL option are not supported.

Swagger's converter also has a few quirks that produce output which is not
valid OpenAPI 3.0, such as `type: file` inside schemas and array defaults
written as strings. SpecLift reproduces them so results stay identical.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

The terminal prints the local address. All conversion continues to happen in
your browser.

## Validate and build

```bash
npm run lint
npm test
npm run build:pages
```

`npm run build:pages` creates a fully static site in `out/`. It can be served
from any static file host.

To validate a repository-style GitHub Pages base path locally:

```bash
NEXT_PUBLIC_BASE_PATH=/swagger-to-openapi npm run build:pages
```

In PowerShell:

```powershell
$env:NEXT_PUBLIC_BASE_PATH="/swagger-to-openapi"
npm run build:pages
```

## Publish with GitHub Pages

The workflow in `.github/workflows/pages.yml` validates every pull request and
deploys `main` automatically.

1. Push this repository to GitHub.
2. Open **Settings → Pages**.
3. Set **Source** to **GitHub Actions**.
4. Push to `main` or run the workflow manually.

The workflow reads GitHub Pages' resolved base path, so it works for both
project sites and `username.github.io` repositories.

## Privacy model

SpecLift reads files with the browser `FileReader` API, transforms the parsed
object in memory, and creates downloads with a temporary browser `Blob`. It
does not make network requests as part of conversion.

Hosting the static files may still produce ordinary web-server access logs.
That is separate from the converter: the contents of API specifications are
never sent to the host.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the development and validation checklist.

## License

[MIT](LICENSE) © SpecLift contributors.
