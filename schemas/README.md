# Schemas

Standalone schema files are not required for the current pre-alpha runtime.

Recursion V1 keeps its structured contracts close to the source modules that validate them:

- settings and provider preferences in `src/settings.mjs`;
- scene cache and run journal payloads in `src/storage.mjs`;
- card catalog and card lifecycle payloads in `src/cards.mjs`;
- card-scope family and sub-item payloads in `src/card-scope.mjs`;
- progress-row and Hero Pixel Array view models in `src/progress.mjs`;
- prompt packet contracts in `src/prompt.mjs`;
- provider response parsing and diagnostics in `src/providers.mjs`.

Use this folder only if those contracts are later extracted into shared standalone schemas.
