# Tests

Recursion uses deterministic module tests first, with guarded live SillyTavern smoke as a separate evidence path.

Primary local gates:

```powershell
npm test
node tools\scripts\run-alpha-gate.mjs
```

Coverage includes:

- settings normalization and session-only provider secrets;
- logical storage keys, scene cache, and bounded run journal behavior;
- Utility/Reasoner provider routing, batching, structured JSON parsing, retries, and redaction;
- V1 card catalog, card lifecycle, provider-result conversion, and hand selection;
- prompt packet composition, Reasoner fallback, validation, prompt block generation, and unsafe-content rejection;
- runtime Off/Observe/Auto behavior, prompt install/clear, stale-run handling, storage fallback, and provider fallback;
- SillyTavern host adapter prompt/storage/generation contracts;
- Recursion Bar, Activity Ribbon, Actions menu, Last Hand dropdown, full viewer, settings, provider controls, and redaction;
- Playwright-backed live harness contracts, including dedicated-user rejection and opt-in generation bridge prompt evidence.

Automated live tests must use dedicated `recursion-soak-*` users and must reject `default-user` before login, browser navigation, storage probes, chat mutation, prompt injection, or provider calls.
