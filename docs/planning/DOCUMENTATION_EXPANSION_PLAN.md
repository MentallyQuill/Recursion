# Recursion Documentation Expansion Plan

## Purpose

Recursion needs a Directive-style documentation system adapted to Recursion's smaller product boundary: a high-level README that routes readers into deeper manuals, a canonical documentation index, practical operator guides, technical manuals, testing contracts, and a tracked render inventory.

Recursion is pre-alpha. Documentation should describe the best current V1 contract and update stale docs in place. Do not preserve legacy explanations, old file names, old cache shapes, or early prototype behavior when the current implementation and docs can be made coherent.

## Documentation Goals

1. Keep `README.md` as the concise public overview and route map.
2. Add `docs/DOCUMENTATION_INDEX.md` as the complete navigable map.
3. Expand the operator documentation into a practical surface-by-surface manual.
4. Add a technical manual family that explains the actual runtime loop, card system, prompt packet, provider routing, storage, diagnostics, and host adapter boundary.
5. Treat renders, screenshots, diagrams, and infographics as part of the documentation deliverable.
6. Mark missing visuals directly in the target documents with the visible literal marker `<Render Needed>` so the gaps can be found and replaced later.
7. Keep product claims grounded in current source, current tests, and current live or fixture evidence.

## Current Baseline

Existing docs to preserve as source material:

- [Recursion Extension Spec](../RECURSION_EXTENSION_SPEC.md)
- [Product Scope](../design/RECURSION_PRODUCT_SCOPE.md)
- [Card System Spec](../design/CARD_SYSTEM_SPEC.md)
- [UI Spec](../design/UI_SPEC.md)
- [Runtime Architecture](../architecture/RUNTIME_ARCHITECTURE.md)
- [Provider and Generation Spec](../architecture/PROVIDER_AND_GENERATION_SPEC.md)
- [Prompt Composition Spec](../architecture/PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics](../architecture/STORAGE_AND_DIAGNOSTICS.md)
- [Testing Strategy](../testing/TESTING_STRATEGY.md)
- [SillyTavern Playwright Harness](../testing/SILLYTAVERN_PLAYWRIGHT_HARNESS.md)
- [Live Smoke Test Plan](../testing/LIVE_SMOKE_TEST_PLAN.md)
- [Artifact Contract](../testing/ARTIFACT_CONTRACT.md)

These files are useful, but most are implementation-facing specs. The expansion should promote their current contracts into release-facing manuals instead of leaving readers to infer the product from design notes.

## Target Documentation Structure

```text
README.md
docs/README.md
docs/DOCUMENTATION_INDEX.md
docs/release/0.1.0-pre-alpha.1.md
docs/user/FIRST_RUN_WORKFLOW.md
docs/user/RECURSION_OPERATOR_MANUAL.md
docs/user/PROVIDER_SETUP.md
docs/user/PROMPT_PRIVACY_AND_SAFETY.md
docs/technical/README.md
docs/technical/RECURSION_TECHNICAL_MANUAL.md
docs/technical/RUNTIME_TURN_SEQUENCE.md
docs/technical/CARD_DECK_AND_HAND.md
docs/technical/PROMPT_PACKET_AND_INJECTION.md
docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md
docs/technical/STORAGE_AND_DIAGNOSTICS.md
docs/technical/HOST_INTEGRATION_MANUAL.md
docs/testing/DOCUMENTATION_RENDER_TRACKING.md
docs/planning/DOCUMENTATION_EXPANSION_PLAN.md
assets/documentation/renders/
```

Existing design and architecture docs should remain available as source references. Once a release-facing manual supersedes a V1 spec section, cross-link it from the source spec and make the current behavior easy to find from the documentation index.

## Render Marker Contract

Every missing render, screenshot, diagram, or infographic requested by a document must be marked in that target document with a visible line containing the literal marker `<Render Needed>`.

Use this format:

```markdown
<Render Needed>: assets/documentation/renders/recursion-progress-menu-auto-pass.png - Hero Pixel Array progress menu during an Auto pass, showing Utility planning, card generation, prompt composition, prompt install, and ready state.
```

Rules:

- The visible marker line must include the exact literal text `<Render Needed>`.
- Place the marker at the point where the final image should appear.
- Include the intended target asset path after the marker.
- Include one concise sentence describing the required visual state.
- Do not hide render needs only in HTML comments. The marker must be visible and searchable.
- When a render is captured and promoted, replace the marker with a normal Markdown image embed.
- Promoted documentation assets should live under `assets/documentation/renders/`.
- Generated reports, raw traces, browser profiles, and temporary captures should stay under `artifacts/` unless intentionally promoted.

Replacement example:

```markdown
<p align="center">
  <img src="../../assets/documentation/renders/recursion-progress-menu-auto-pass.png" alt="Recursion Hero Pixel Array progress menu during an Auto pass">
</p>
```

Verification search:

```powershell
rg -n "^<Render Needed>:" README.md docs --glob "*.md" --glob "!docs/planning/DOCUMENTATION_EXPANSION_PLAN.md"
```

The search should return every intentionally open render slot and exclude this planning document, which contains fenced syntax examples. After a documentation render pass is complete, only deferred or explicitly unresolved slots should remain.

## Stage 0: Current-State Inventory

### Objective

Build a source-backed inventory before expanding public prose.

### Work

- Audit `README.md`, `docs/README.md`, existing design docs, architecture docs, user docs, testing docs, and source READMEs.
- Inventory user-facing surfaces: Recursion Bar, Hero Pixel Array progress menu, options menu, Last Brief dropdown, Full Viewer, Settings, Provider Controls, power toggle, Auto/Semi-Auto mode controls, warnings, fallback states, and mobile behavior.
- Inventory technical seams: SillyTavern host adapter, generation interceptor, runtime coordinator, Utility Arbiter, card catalog, scene cache, turn hand selection, prompt packet composition, prompt injection, provider lanes, storage, activity reporting, diagnostics, and redaction.
- Inventory verification evidence: `npm.cmd test`, `node tools\scripts\run-alpha-gate.mjs`, Playwright readiness artifacts, dedicated soak-user checks, live smoke plans, and artifact contracts.
- Identify stale or overlapping docs that should be renamed, merged, or rewritten in place.

### Outputs

- Confirmed target document list.
- Render inventory for every major user-facing surface and technical diagram.
- List of docs that will be superseded by release-facing manuals.

### Verification

```powershell
rg --files -g "*.md"
npm.cmd test
node tools\scripts\run-alpha-gate.mjs
```

## Stage 1: Documentation Architecture

### Objective

Create stable entry points before expanding large manuals.

### Work

- Add `docs/DOCUMENTATION_INDEX.md`.
- Update `README.md` to stay high-level and route readers into the detailed manuals.
- Update `docs/README.md` to include `planning/`, `release/`, and `technical/` once those directories exist.
- Use `docs/user/RECURSION_OPERATOR_MANUAL.md` as the current operator manual path and route first-run/provider/privacy details into focused companion guides.
- Add placeholder manual files only when stable links are needed for the next stage.

### Outputs

- Updated root README.
- New documentation index.
- Updated docs README.
- Stable target paths for the manual family.

## Stage 2: Render And Evidence Capture

### Objective

Capture or plan visuals before writing screenshot-backed prose.

### Work

- Create `docs/testing/DOCUMENTATION_RENDER_TRACKING.md`.
- Add `<Render Needed>` markers to docs as visual gaps are introduced.
- Capture current SillyTavern-hosted Recursion UI where possible.
- Use fixture or static diagrams only when live host capture is not required for the claim.
- Promote durable assets into `assets/documentation/renders/`.
- Keep raw Playwright traces, temporary screenshots, and run reports in `artifacts/`.

### README Render Needs

| Render | Viewport | Purpose |
| --- | --- | --- |
| Recursion Bar in SillyTavern | Desktop | First visual proof of the active extension surface. |
| Hero Pixel Array active pass | Desktop | Shows invisible work becoming visible during Auto mode. |
| Full Viewer overview | Desktop | Shows inspectable Now, Deck, Activity, Prompt Packet, Settings, and Providers sections. |
| Recursion Bar mobile layout | Phone | Shows narrow-host usability. |

### Operator Manual Render Needs

| Surface Or Flow | Required States |
| --- | --- |
| Install and enable | SillyTavern extension listed, enabled, and bar mounted. |
| Mode controls | Power toggle, Auto, Semi-Auto, Reasoning Level, and prompt cleanup behavior. |
| Recursion Bar | Ready, working, warning, disabled, provider issue, and prompt-ready states. |
| Hero Pixel Array progress menu | Snapshot, Utility planning, card generation, prompt composition, Reasoner pass or skip, prompt install, fallback, and settled states. |
| Options menu | Copy Last Prompt Packet, Open Settings, Open Viewer, provider controls, and disabled planned commands. |
| Last Hand dropdown | Compact selected cards, omission hints, prompt packet link, empty hand, stale hand, and error state. |
| Full Viewer | Now, Deck, Activity, Prompt Packet, Settings, Providers, and diagnostics sections. |
| Settings | Mode, Strength, Prompt Footprint, Focus, Reasoner Use, Utility provider setup, and Reasoner provider setup. |
| Provider Controls | Utility setup, Reasoner setup, session-only key state, test connection, Reasoner off, fallback warning. |
| Prompt packet inspection | Scene Brief, Turn Brief, Guardrails, selected card refs, omissions, injection metadata, and redaction-safe diagnostics. |
| Fail-soft states | Utility unavailable, Reasoner timeout, invalid structured output, storage write failure, injection failure, and stale async result. |
| Mobile behavior | Bar wrap behavior, menu access, viewer layout, and touch-safe controls. |

### Technical Manual Render And Infographic Needs

| Visual | Purpose |
| --- | --- |
| Runtime pipeline infographic | Host Snapshot -> Utility Arbiter -> Scene Deck -> Turn Hand -> Composer/Reasoner -> Prompt Packet -> Injection -> Diagnostics. |
| Turn sequence diagram | Power, Auto/Semi-Auto generation lifecycle, prompt install timing, cancellation, and stale result discard. |
| Card lifecycle diagram | Create, refresh, stow, discard, select, omit, and invalidate cards. |
| Card family matrix | Scene Frame, Active Cast, Character Motivation, Dialogue/Relationship, Continuity Risk, Environment/Items, Prose/Pacing, Open Threads. |
| Prompt packet stack | Scene Brief, Turn Brief, Guardrails, raw critical guardrail exception. |
| Prompt injection diagram | Recursion-owned prompt lanes, insertion metadata, stale packet clear, and host boundary. |
| Provider routing diagram | Utility lane, optional Reasoner lane, current host model, connection profile, OpenAI-compatible endpoint, retries, and fallback. |
| Storage key map | Settings, system index, scene cache, run journal, prompt metadata, and sanitized artifact boundary. |
| Redaction boundary diagram | Data that may appear in UI/journals/artifacts versus raw provider payloads and session secrets that must not persist. |
| Host adapter boundary | SillyTavern context, generation, prompt, settings, file storage, UI lifecycle, and host-neutral runtime interfaces. |
| Testing gate flow | Unit scripts, alpha gate, Playwright readiness, soak-user preflight, guarded live smoke, and artifact review. |

## Stage 3: README Expansion

### Objective

Make `README.md` a concise public route map.

### Work

- Keep the top-level promise clear: current-scene prompt compilation for better roleplay generation.
- Add a short Fast Start.
- Add a compact feature table.
- Link to the first-run workflow, operator manual, provider setup, prompt privacy guide, technical manual, testing strategy, and release note.
- Embed only the small README render set.
- Keep non-goals explicit: no durable memory ownership, no lore database, no summary engine, no vector recall, no campaign save system, no card-editing product.

## Stage 4: Operator Manual

### Objective

Create the practical guide for using Recursion in SillyTavern.

### Work

- Rewrite the current operator guide around real operator tasks:
  - install and enable Recursion;
  - use the power toggle, Auto, or Semi-Auto;
  - configure Utility;
  - optionally configure Reasoner;
  - run the first Auto pass;
  - try the current Semi-Auto path;
  - inspect Activity, Last Brief, and Prompt Packet;
  - interpret fallback states;
  - use power-off cleanup or disable Recursion;
  - avoid persisting secrets or raw provider data.
- Add `<Render Needed>` markers for every surface that lacks a current render.
- Keep internals out unless they affect operator decisions.
- Link deep internals to technical manuals.

### Outputs

- `docs/user/FIRST_RUN_WORKFLOW.md`
- `docs/user/RECURSION_OPERATOR_MANUAL.md`
- `docs/user/PROVIDER_SETUP.md`
- `docs/user/PROMPT_PRIVACY_AND_SAFETY.md`

## Stage 5: Technical Manual

### Objective

Explain how Recursion actually works behind the UI.

### Work

- Write the main `RECURSION_TECHNICAL_MANUAL.md` as the technical overview.
- Split deep references when sections become too large:
  - runtime turn sequence;
  - card deck and hand;
  - prompt packet and injection;
  - model calls and provider routing;
  - storage and diagnostics;
  - host integration.
- Anchor claims to `src/`, `styles/`, `tests/`, and `tools/`.
- Use Mermaid diagrams for data flow where a screenshot would be less useful.
- Use sanitized UI/diagnostic captures where operator-facing evidence matters.

### Outputs

- `docs/technical/RECURSION_TECHNICAL_MANUAL.md`
- `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- `docs/technical/CARD_DECK_AND_HAND.md`
- `docs/technical/PROMPT_PACKET_AND_INJECTION.md`
- `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- `docs/technical/STORAGE_AND_DIAGNOSTICS.md`
- `docs/technical/HOST_INTEGRATION_MANUAL.md`

## Stage 6: Testing, Artifacts, And Render Tracking

### Objective

Make verification and documentation evidence repeatable.

### Work

- Update testing docs so they distinguish deterministic tests, Playwright readiness, dedicated soak-user preflight, guarded live smoke, and documentation render capture.
- Add `docs/testing/DOCUMENTATION_RENDER_TRACKING.md` with current open render slots.
- Keep `<Render Needed>` markers in target docs until the assets are promoted.
- Confirm live smoke docs keep `default-user` rejection and dedicated `recursion-soak-*` users visible.
- Document artifact retention, redaction, and promotion rules.

### Outputs

- Updated testing docs.
- New render tracking doc.
- Current render slot table.

## Stage 7: Cross-Doc Alignment

### Objective

Make the docs read as one coherent product instead of a pile of planning notes.

### Work

- Cross-link README, documentation index, operator docs, technical manuals, testing docs, source READMEs, and release notes.
- Rename stale V1 files if the new manual names supersede them.
- Remove or rewrite contradictory old sections in place.
- Keep release-facing docs conservative and current.
- Keep design docs as source references and label historical seed notes clearly.

### Verification

```powershell
rg -n "^<Render Needed>:" README.md docs --glob "*.md" --glob "!docs/planning/DOCUMENTATION_EXPANSION_PLAN.md"
npm.cmd test
node tools\scripts\run-alpha-gate.mjs
```

## Stage 8: Release-Facing Signoff

### Objective

Finish with proof that the docs match current behavior.

### Work

- Run local tests and alpha gate.
- Run live smoke only when a dedicated live user is configured and mutation is intended.
- Review every embedded render:
  - asset exists;
  - caption matches the visible state;
  - no secrets, raw provider payloads, hidden reasoning, or private story plans are visible;
  - mobile and desktop screenshots are not swapped;
  - fixture renders are labeled when they are not live host proof.
- Search for `<Render Needed>` and decide whether each remaining slot is intentionally deferred.
- Update release notes if the documentation expansion is part of a named release checkpoint.

## Suggested Work Order

1. Stage 0: inventory.
2. Stage 1: docs architecture and stable paths.
3. Stage 2: render marker and tracking rules.
4. Stage 3: README.
5. Stage 4: operator manuals.
6. Stage 5: technical manual family.
7. Stage 6: testing and render tracking.
8. Stage 7: cross-doc alignment.
9. Stage 8: release-facing signoff.

The operator manual should wait for at least a render inventory. The technical manual can begin earlier because many visuals are diagrams derived from source and tests. README screenshots should be few, polished, and current.

## Definition Of Done

- `README.md` is a concise route map into deeper docs.
- `docs/DOCUMENTATION_INDEX.md` exposes every current major manual and reference.
- Operator docs cover install, first run, modes, providers, activity, inspection, fallback, prompt safety, and mobile behavior.
- Technical docs explain the runtime loop, card/hand system, prompt packet, provider routing, storage, diagnostics, and host integration.
- Testing docs explain local gates, live guardrails, artifacts, and render capture expectations.
- Missing visual assets are marked where they belong with visible `<Render Needed>` lines.
- Promoted renders live under `assets/documentation/renders/`.
- Stale docs are updated in place or clearly labeled as historical source material.
- Verification commands and remaining render gaps are recorded before release-facing completion is claimed.
