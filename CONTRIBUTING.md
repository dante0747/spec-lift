# Contributing to SpecLift

Thanks for helping make API modernization private and painless. All kinds of
contributions are welcome: bug reports, Swagger mismatches, docs, design, and
code.

## Ground rules

- **Privacy first.** Conversion stays in the browser. Don't add analytics,
  remote conversion services, required network calls, storage of specs, or
  third-party scripts.
- **Never share real specs.** Fixtures, issues and screenshots must use small,
  made-up examples, never internal or customer API definitions.
- **Swagger-exact stays exact.** With `fixSwaggerBugs` off, output must stay
  identical to converter.swagger.io. Intentional differences belong in the
  bug-fix mode.

## Development setup

Requires Node.js 22.13 or newer (`.nvmrc` pins 22).

```bash
npm ci
npm run dev
```

Before opening a pull request, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build:pages
```

`npm test` builds the app, then runs the rendering, converter, parity,
YAML-parity and fixed-mode tests.

## Changing the converter

`app/converter.ts` is a port of Swagger's converter. Every behavior change
needs a fixture that pins it:

| Change | Fixture folder | Expected output comes from |
| ------ | -------------- | -------------------------- |
| Matching Swagger more closely (JSON input) | `tests/fixtures/parity` | converter.swagger.io |
| How YAML input is read | `tests/fixtures/parity-yaml` | converter.swagger.io, sent as YAML |
| A Swagger bug SpecLift fixes | `tests/fixtures/fixed` | Hand-checked, valid OpenAPI 3.0 |

For the first two, add `NAME.swagger.json` or `NAME.swagger.yaml`, then fetch
Swagger's output:

```bash
node scripts/fetch-swagger-reference.mjs tests/fixtures/parity
```

To check a larger set of real specs, see the "Swagger parity" section of the
README.

## Pull requests

- Keep each pull request focused on one change.
- Describe what changed and why, and link the issue it closes.
- Add an entry under a new "Unreleased" heading in `CHANGELOG.md` for
  user-facing changes.
- CI must pass. It runs lint, typecheck, tests and the static build on Node 22
  and 24.

## Reporting issues

Use the issue templates: **Bug report**, **Output differs from Swagger**, or
**Feature request**. Report security issues privately as described in
[SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the MIT
License, and you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).
