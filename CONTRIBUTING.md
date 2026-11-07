# Contributing to SpecLift

Thanks for helping improve private API modernization.

## Development

1. Fork and clone the repository.
2. Install dependencies with `npm ci`.
3. Start the site with `npm run dev`.
4. Keep conversion logic deterministic and browser-only.
5. Do not add analytics, remote conversion services, or required network calls.

Before opening a pull request, run:

```bash
npm run lint
npm test
npm run build:pages
```

For converter changes, add a small Swagger 2.0 example to
`tests/fixtures/parity` (or `tests/fixtures/parity-yaml` for YAML-specific
behavior), fetch Swagger's reference output with
`node scripts/fetch-swagger-reference.mjs <that folder>`, and make sure
`npm test` passes. SpecLift's output must stay identical to Swagger's.

By contributing, you agree that your contributions are licensed under the MIT
License.
