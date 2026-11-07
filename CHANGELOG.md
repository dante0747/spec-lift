# Changelog

All notable changes to SpecLift are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [2.0.1] - 2026-11-07

### Added

- Sponsor links: a badge in the header, a sponsor section, a footer link, a
  README badge, and `.github/FUNDING.yml`. They are plain links, so the page
  still makes no third-party requests.
- A web app manifest with 192 px, 512 px and maskable icons.

### Fixed

- Favicon missing where SVG icons aren't supported: added `favicon.ico`
  (16/32/48 px) and an Apple touch icon.

### Removed

- Unused default Next.js images in `public/`.

## [2.0.0] - 2026-11-07

### Added

- **Swagger-exact mode.** With "Fix Swagger bugs" off, output is identical to
  [converter.swagger.io](https://converter.swagger.io), key order included,
  verified on 99 real-world APIs.
- **Swagger bug fixes (on by default).** SpecLift keeps Swagger's conversion
  rules but fixes the places where Swagger writes invalid OpenAPI 3.0 or drops
  data: `type: file` in schemas, date and array defaults, numeric form enums,
  empty form enums, Java-formatted examples, examples lost on shared
  parameters, and dropped defaults, enums, `readOnly`, discriminators,
  extensions and operation schemes. On 93 real-world APIs this restores
  dropped data in 45 of them.
- Fixed-mode output is validated against the official OpenAPI 3.0 JSON Schema
  in the test suite.
- YAML input and output, read with the same YAML 1.1 rules Swagger uses.
- Live conversion, sample specs, drag and drop, syntax-highlighted editors with
  line numbers, and error-line markers.
- A warning when the output contains `$ref`s that point to nothing.
- Parity test suites with Swagger's reference output for JSON and YAML inputs,
  and scripts to compare more specs against the live converter.

### Changed

- Output follows Swagger's converter: `openapi: 3.0.1` (was 3.0.3), `*/*` as
  the default media type, a default `/` server, and shared parameters and
  responses written inline in each operation.
- New design, self-hosted fonts, and a lighter social preview image.

### Fixed

- Converter tests failed on Windows checkouts with CRLF line endings.
- Two GitHub Actions workflows both deployed to Pages on every push.

## [1.0.0] - 2026-07-28

### Added

- First release: a private, browser-only converter from Swagger 2.0 JSON to
  OpenAPI 3.0.3, deployable to GitHub Pages.

[2.0.1]: https://github.com/dante0747/spec-lift/compare/173652e...HEAD
[2.0.0]: https://github.com/dante0747/spec-lift/compare/8987791...173652e
[1.0.0]: https://github.com/dante0747/spec-lift/tree/8987791
