# Security policy

## Supported versions

Only the latest release, deployed from `main`, receives fixes.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Report it
privately through
[GitHub's private vulnerability reporting](https://github.com/dante0747/spec-lift/security/advisories/new).

Include the affected version or commit, reproduction steps, and potential
impact. Do not include real organizational API specifications or credentials.
You can expect a first response within a week.

## Security model

SpecLift is a static frontend application:

- Specs are read with the browser's `FileReader` or from the editor, converted
  in memory, and downloaded from a local `Blob`.
- There is no backend, remote conversion API, account system, analytics,
  telemetry, or browser storage of specs.
- Fonts and all other assets are served from the same site; there are no
  third-party scripts or CDNs.
- Converted output is rendered as escaped text, never as HTML.

Changes that introduce network access, telemetry, persistence, or third-party
scripts must be clearly disclosed and justified during review. The scripts in
`scripts/` call converter.swagger.io to build test fixtures; they are
development tools and never run in the app.
