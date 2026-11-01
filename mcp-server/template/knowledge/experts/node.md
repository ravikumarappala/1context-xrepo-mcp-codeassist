# Node / TypeScript expert pack (example)

## Architecture
- Express routes -> services -> repositories. Validation at the route boundary.
- Wire format is snake_case; internal code camelCase.

## Do / don't
- Do: add fields in a backward-compatible way; update the API contract in the same change.
- Don't: log tokens, emails or request bodies.

## Checks
- npm test (unit + contract) before finishing.
