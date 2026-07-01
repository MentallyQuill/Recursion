# Recursion

Recursion is a pre-alpha SillyTavern extension that compiles compact, current-scene prompt guidance for the next roleplay generation. It observes the active chat, builds a short-lived scene deck and turn hand, then installs an inspectable prompt packet when Auto mode is active.

Recursion is not a memory manager, lore database, summary engine, vector recall layer, campaign save system, or card-editing product. It is a focused prompt compiler for the scene in front of the user.

<Render Needed>: assets/documentation/renders/recursion-bar-desktop.png - Recursion Bar mounted in SillyTavern on desktop, showing mode, hand count, Utility state, Reasoner state, Actions, Hand, and Open controls.

## Current Status

- Package version: `0.1.0-pre-alpha.1`
- Manifest version: `0.1.0-pre-alpha.1`
- SillyTavern minimum client version: `1.12.0`
- Extension key: `recursion`
- Entrypoint: `src/extension/index.js`
- Stylesheet: `styles/recursion.css`
- License: [MIT](LICENSE)

V1 currently covers settings, provider lanes, scene cards, runtime coordination, SillyTavern host integration, prompt packet composition/injection, Recursion Bar UI surfaces, and focused automated tests. Live SillyTavern smoke is guarded and must use a dedicated `recursion-soak-*` user, not `default-user`.

## Fast Start

1. Install or serve Recursion as a SillyTavern extension.
2. Enable the `Recursion` extension in SillyTavern.
3. Configure the Utility provider.
4. Leave Reasoner disabled unless you want the optional composition lane.
5. Use `Observe` to inspect without prompt injection, or `Auto` to prepare and install the next prompt packet.
6. Watch the Activity Ribbon, then inspect the Last Hand or Full Viewer when you need details.

## Key Features

| Feature | Current V1 contract |
| --- | --- |
| Recursion Bar | Chat-attached top bar for mode, hand count, provider health, actions, last hand, and viewer access. |
| Activity Ribbon | Visible progress for snapshot reading, Utility planning, card generation, prompt composition, prompt install, fallback, and ready states. |
| Scene deck and turn hand | Bounded current-scene cache with a compact hand selected for the next generation. |
| Utility lane | Required default lane for Arbiter planning, structured card work, and normal prompt composition. |
| Reasoner lane | Optional composer lane for crowded, conflicted, or subtle hands; Utility remains the fallback. |
| Prompt packet | Bounded, inspectable Scene Brief, Turn Brief, and Guardrails installed through Recursion-owned SillyTavern prompt entries. |
| Storage and diagnostics | Compact settings, logical scene cache, bounded run journal, sanitized activity, and artifact redaction boundaries. |
| Live smoke guardrails | Dedicated soak users are required; `default-user` is rejected before live mutation or provider calls. |

<Render Needed>: assets/documentation/renders/recursion-activity-ribbon-auto-pass.png - Activity Ribbon during an Auto pass, showing Utility planning, card generation, prompt composition, prompt install, and ready state.

<Render Needed>: assets/documentation/renders/recursion-full-viewer-overview.png - Full Viewer overview with Now, Deck, Activity, Prompt Packet, Settings, and Providers sections visible.

<Render Needed>: assets/documentation/renders/recursion-bar-mobile.png - Recursion Bar in a phone-width SillyTavern viewport, showing wrapped or compact controls without overlap.

## Documentation

- [Documentation Index](docs/DOCUMENTATION_INDEX.md) - Canonical map for current docs and expansion tracking.
- [Release Notes](docs/release/0.1.0-pre-alpha.1.md) - Current pre-alpha release scope, verification, and known doc/render gaps.
- [First Run Workflow](docs/user/FIRST_RUN_WORKFLOW.md) - First-session path from install and provider setup through Observe, Auto, inspection, and cleanup.
- [Operator Manual](docs/user/RECURSION_OPERATOR_MANUAL.md) - Complete practical guide for UI surfaces, modes, operation, fail-soft behavior, diagnostics, storage, mobile behavior, and smoke checks.
- [Provider Setup](docs/user/PROVIDER_SETUP.md) - Utility and Reasoner setup, session-only keys, provider tests, fallback behavior, and safe verification.
- [Prompt Privacy And Safety](docs/user/PROMPT_PRIVACY_AND_SAFETY.md) - Prompt packet contents, injection boundary, storage limits, redaction, coexistence, and operator safety checks.
- [Technical Manuals](docs/technical/README.md) - Runtime, card, prompt, provider, storage, diagnostics, and host integration manuals.
- [Recursion Technical Manual](docs/technical/RECURSION_TECHNICAL_MANUAL.md) - Technical overview of the V1 runtime pipeline and component boundaries.
- [Documentation Expansion Plan](docs/planning/DOCUMENTATION_EXPANSION_PLAN.md) - Staged tracking for remaining technical docs and render promotion.
- [Testing Strategy](docs/testing/TESTING_STRATEGY.md) - Deterministic checks, Playwright readiness, live smoke, and pass/fail semantics.
- [Documentation Render Tracking](docs/testing/DOCUMENTATION_RENDER_TRACKING.md) - Current render marker inventory, source types, promotion workflow, and render asset policy.
- [Extension Spec](docs/RECURSION_EXTENSION_SPEC.md) - Current top-level V1 design and implementation contract.

## Project Layout

| Path | Purpose |
| --- | --- |
| `src/` | Host-neutral runtime modules plus the SillyTavern extension entrypoint. |
| `styles/` | Recursion UI styling for SillyTavern. |
| `schemas/` | Schema notes and standalone schema area; current contracts live in source modules and docs. |
| `docs/` | Public route maps, release notes, user docs, design specs, architecture specs, testing docs, and planning docs. |
| `tests/` | Deterministic module and integration checks. |
| `tools/` | Local verification, Playwright readiness, soak-user checks, and guarded live smoke scripts. |

See [src/README.md](src/README.md), [tests/README.md](tests/README.md), and [tools/README.md](tools/README.md) for module-level maps.

## Security And Privacy

Recursion treats provider secrets and raw model I/O as sensitive. OpenAI-compatible API keys are session-only and must not persist to settings, scene cache, prompt packets, run journals, diagnostics, browser local storage, SillyTavern file storage, or test artifacts. Normal diagnostics use hashes, compact statuses, bounded metadata, and sanitized activity instead of raw prompts, raw provider responses, hidden reasoning, or full transcript text.

## Verification

Local gate:

```powershell
npm.cmd test
node tools\scripts\run-alpha-gate.mjs
```

Optional readiness and live smoke checks:

```powershell
node tools\scripts\check-playwright-readiness.mjs --write-artifacts
node tools\scripts\check-sillytavern-soak-users.mjs --live --write-artifacts
node tools\scripts\smoke-sillytavern-live.mjs --live --write-artifacts --strict
```

Render gap tracking:

```powershell
rg -n "^<Render Needed>:" README.md docs --glob "*.md" --glob "!docs/planning/DOCUMENTATION_EXPANSION_PLAN.md"
```
