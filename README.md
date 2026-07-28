# SpecLift

SpecLift is a private, browser-only converter from Swagger 2.0 JSON to an
OpenAPI 3.0.3 specification. It is designed for teams that cannot send API
definitions to third-party services.

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

SpecLift targets the common Swagger 2.0 surface. Always review generated specs
before using them in production, especially when the source relies on
vendor-specific extensions or uncommon edge cases.

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
