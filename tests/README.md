# Tests

Recursion uses deterministic module tests first, with guarded live SillyTavern smoke as a separate evidence path.

Primary local gates:

```powershell
npm test
node tools\scripts\run-alpha-gate.mjs
```

Coverage includes:

- settings normalization, behavior policy derivation, card-budget normalization, and session-only provider secrets;
- logical storage keys, scene cache, and bounded run journal behavior;
- Utility/Reasoner provider routing, host connection profile discovery, machine-JSON schema metadata, OpenAI-compatible model discovery, batching, structured JSON parsing, retries, and redaction;
- V1 card catalog, card lifecycle, provider-result conversion, and hand selection;
- prompt packet composition, Reasoner fallback, validation, prompt block generation, and unsafe-content rejection;
- runtime power-off, Auto, Manual, card-scope behavior, sanitized hand journal breadcrumbs, prompt install/clear, stale-run handling, host-generation-stop skipped progress, storage fallback, and provider fallback;
- SillyTavern host adapter prompt/storage/generation contracts, including connection-profile JSON schema parameters;
- Recursion Bar, icon-only mode/card controls, Hero Pixel Array progress menu, options/settings menu, Last Brief dropdown, full viewer, autosaving settings, provider controls, model discovery, and redaction;
- Playwright readiness plus live harness contracts, including dedicated-user rejection and opt-in generation bridge prompt evidence.

Automated live tests must use dedicated `recursion-soak-*` users and must reject `default-user` before login, browser navigation, storage probes, chat mutation, prompt injection, or provider calls.
