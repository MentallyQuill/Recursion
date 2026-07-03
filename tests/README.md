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
- model-evaluation harness contracts for scenario fixtures, provider-call estimates, card-bias metrics, prompt-compilation metrics, dedicated-user policy, and artifact redaction.

Automated live tests must use dedicated `recursion-soak-*` users and must reject `default-user` before login, browser navigation, storage probes, chat mutation, prompt injection, or provider calls.

The real-call model evaluation runner is opt-in:

```powershell
npm run test:model-eval
node tools\scripts\eval-recursion-models.mjs --dry-run --pack smoke --profile auto-normal --runs 1 --write-artifacts
node tools\scripts\eval-recursion-models.mjs --live --pack smoke --profile auto-normal --runs 1 --user recursion-soak-a --target-model <model-id> --judge-model <model-id> --character-name Story --chat-file "Branch #790 - 2025-08-28@18h02m24s" --write-artifacts
```

Use live model evaluation only with a dedicated `recursion-soak-*` user and explicit provider-call or cost caps. Story-chat runs require the character card and chat file to be seeded into that soak user before running the command.
