# Contributor Instructions

## Pre-Alpha Compatibility

Recursion is pre-alpha. Do not preserve legacy compatibility for old code paths, old data shapes, or hypothetical existing users when a cleaner V1 contract is available.

When changing a contract, update the code, docs, schemas, tests, and examples in place to the best current version. Prefer one coherent implementation over compatibility shims.

## Design Guidance

Before creating or changing visible UI, read `DESIGN.md` and `docs/design/UI_SPEC.md`. `DESIGN.md` is the model-facing visual identity contract: keep Recursion SillyTavern-native, compact, graphite-dark, and operational rather than marketing-like or dashboard-heavy.

When the visual contract changes, update `DESIGN.md`, the relevant design docs, styles, tests, and examples in place.
