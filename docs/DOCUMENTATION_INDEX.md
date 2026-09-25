# Recursion Documentation Index

This is the canonical map for Recursion documentation. Undated manuals and specs linked as current authority describe the active V1 contract. Dated files under `release/`, `planning/`, `testing/`, and `superpowers/` are historical decision or evidence snapshots unless a current entry explicitly says otherwise; they may retain the product vocabulary and behavior that existed when written.

## Release Notes

- [Release Notes Directory](release/README.md)
- [0.3.0-beta.1](release/0.3.0-beta.1.md) - Current beta release.
- [0.3.0-beta.1 announcement](release/0.3.0-beta.1-announcement.md) - Shareable feature highlights.
- [0.2.0-alpha.3](release/0.2.0-alpha.3.md)
- [0.2.0-alpha.2](release/0.2.0-alpha.2.md)
- [0.2.0-alpha.1](release/0.2.0-alpha.1.md)
- [0.1.0-pre-alpha.6](release/0.1.0-pre-alpha.6.md)
- [Post-alpha.1 Feature Highlights](release/post-alpha.1-feature-highlights.md)
- [0.1.0-pre-alpha.5](release/0.1.0-pre-alpha.5.md)
- [0.1.0-pre-alpha.4](release/0.1.0-pre-alpha.4.md)
- [0.1.0-pre-alpha.3](release/0.1.0-pre-alpha.3.md)
- [0.1.0-pre-alpha.2](release/0.1.0-pre-alpha.2.md)
- [0.1.0-pre-alpha.1](release/0.1.0-pre-alpha.1.md)

## Start And Operator Docs

- [Root README](../README.md) - Public route map and fast start.
- [Docs Folder Guide](README.md) - Folder-level guide for this documentation tree.
- [User Guides](user/README.md) - Operator-facing table of contents.
- [First Run Workflow](user/FIRST_RUN_WORKFLOW.md) - First-session path from install through Segmented Auto, Tense & PoV Auto, Manual, Fused trial, inspection, and power-toggle cleanup.
- [Recursion Operator Manual](user/RECURSION_OPERATOR_MANUAL.md) - Complete practical manual for Pre-process and Post-process Cards, UI surfaces, Segmented/Fused pipelines, resumable stage actions, modes, Tense & PoV, settings, operation, diagnostics, storage, mobile behavior, and smoke checks.

## Provider, Privacy, And Safety Docs

- [Provider and Generation Spec](architecture/PROVIDER_AND_GENERATION_SPEC.md) - Current provider lanes, source routing, machine-JSON schema metadata, structured calls, validation, and secret handling contract.
- [Structured Output Recovery Design](superpowers/specs/2026-07-13-recursion-structured-output-recovery-design.md) - **Historical recovery design; its fixed correction-budget and deadline claims are superseded by the current per-stage attempt contract.**
- [Storage and Diagnostics](architecture/STORAGE_AND_DIAGNOSTICS.md) - Current storage, journal, diagnostics, redaction, and retention contract.
- [Provider Setup](user/PROVIDER_SETUP.md) - Utility and Reasoner setup, source options, autosaving provider fields, model discovery, session-only keys, provider tests, fallback behavior, and safe verification.
- [Prompt Privacy And Safety](user/PROMPT_PRIVACY_AND_SAFETY.md) - Prompt packet contents, injection boundary, storage limits, redaction, external extension coexistence, and safety checks.

## Technical Manuals

- [Technical Manuals](technical/README.md) - Table of contents for the technical manual family.
- [Recursion Technical Manual](technical/RECURSION_TECHNICAL_MANUAL.md) - Product boundary, runtime spine, component ownership, Segmented/Fused graphs, checkpoints, attempts, modes, provider lanes, card/hand system, prompt packet, storage, diagnostics, host adapter, UI observability, fail-soft invariants, testing evidence, and non-goals.
- [Runtime Turn Sequence](technical/RUNTIME_TURN_SEQUENCE.md) - Power toggle, Auto/Manual lifecycle, Segmented/Fused execution, pause/resume/retry/reprocess, cancellation, stale results, and failure branches.
- [Card Deck And Hand](technical/CARD_DECK_AND_HAND.md) - Fixed V1 card families, card contract, lifecycle, Arbiter decisions, deck/hand separation, invalidation, Character Motivation safety, and inspector visibility.
- [Prompt Packet And Injection](technical/PROMPT_PACKET_AND_INJECTION.md) - Packet sections, composer inputs, Utility and Reasoner composition, budgets, omissions, critical guardrail exception policy, SillyTavern injection lanes, cleanup, and privacy guardrails.
- [Model Calls And Provider Routing](technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md) - Utility and Reasoner lanes, provider sources, generation roles, structured output validation, retries, fallbacks, model-call journal, session secret boundary, abort handling, and provider states.
- [Recursion Cost Research](technical/RECURSION_COST_RESEARCH.md) - Provider call counts, token-budget ranges, final prompt-packet size, example per-turn estimates, cost levers, and external multiplier caveats.
- [Storage And Diagnostics Manual](technical/STORAGE_AND_DIAGNOSTICS.md) - Release-facing V2 manifests, isolated artifacts, turn-scoped reuse, queued intents, run journal, redaction, cleanup, and tests.
- [Host Integration Manual](technical/HOST_INTEGRATION_MANUAL.md) - SillyTavern adapter, entrypoint lifecycle, generation interceptor, prompt/storage/settings/generation adapters, UI mount, fake/contract tests, live smoke guardrails, and deferred host boundary.

## Design And Source Specs

- [Model-Facing Design System](../DESIGN.md) - DESIGN.md-format visual identity contract for agents and UI work.
- [Recursion Extension Spec](RECURSION_EXTENSION_SPEC.md) - Top-level V1 design and implementation contract.
- [Product Scope](design/RECURSION_PRODUCT_SCOPE.md) - Product promise, V1 scope, non-goals, and success criteria.
- [Card System Spec](design/CARD_SYSTEM_SPEC.md) - Fixed V1 catalog, card lifecycle, Utility Arbiter responsibilities, and turn hand.
- [Behavior Settings Policy Spec](design/BEHAVIOR_SETTINGS_POLICY_SPEC.md) - Source-backed V1 contract for Strength, Min/Max Cards, Focus, and Prompt Footprint backend effects.
- [UI Spec](design/UI_SPEC.md) - Recursion Bar, Hero Pixel Array progress menu, options/settings menu, Last Brief dropdown, viewer, settings, and provider controls.
- [Turn Context Compiler Seed Note](design/RECURSION_TURN_CONTEXT_COMPILER.md) - Historical seed note superseded by the V1 spec family.
- [Post-process Cards Design](superpowers/specs/2026-07-18-recursion-post-process-cards-design.md) - **Historical product design; current resumable execution, attempts, controls, and persistence are authoritative where they differ.**
- [Post-process Cards Implementation Plan](superpowers/plans/2026-07-18-recursion-post-process-cards.md) - **Historical implementation record retained for decision context.**
- [Post-process Cards Playwright Test Framework](testing/2026-07-18-post-process-cards-playwright-framework.md) - Required browser, visual, runtime-integration, and privacy proof framework.
- [Generation Review and Enhancement Design](superpowers/specs/2026-07-12-recursion-generation-review-and-enhancement-design.md) - **Superseded by Post-process Cards; retained as historical context only.**
- [Editorial Transformation Design](superpowers/specs/2026-07-13-recursion-editorial-transformation-design.md) - **Superseded by Post-process Cards; retained as historical context only.**
- [Layered Failure Recovery Design](superpowers/specs/2026-07-17-recursion-layered-failure-recovery-design.md) - **Historical failure-recovery design; current stage attempts and resumable controls supersede fixed recovery budgets.**
- [Redirect Improvement Design](superpowers/specs/2026-07-15-recursion-redirect-improvement-design.md) - **Superseded by Post-process Cards; retained as historical context only.**
- [Editorial Transformation Implementation Plan](superpowers/plans/2026-07-13-recursion-editorial-transformation.md) - **Superseded by Post-process Cards; retained as historical context only.**
- [Design Folder Guide](design/README.md)

## Architecture Specs

- [Runtime Architecture](architecture/RUNTIME_ARCHITECTURE.md)
- [Post-process Cards Runtime Boundary](architecture/POST_PROCESS_CARDS_RUNTIME.md) - Frozen evidence, native/profile prose writers, scope/style precedence, source-bound review, retry, comparison retention, and privacy contract.
- [Generation Review and Enhancement Contract](architecture/ENHANCEMENT_REVIEW_AND_PATCH_CONTRACT.md) - **Superseded by Post-process Cards; retained as historical context only.**
- [Cache Use And Reuse Spec](architecture/CACHE_USE_AND_REUSE_SPEC.md) - Exact-source reuse, durable stage checkpoints, swipe variants, dependency invalidation, queued reprocessing, and one-shot full-fresh bypasses.
- [Provider and Generation Spec](architecture/PROVIDER_AND_GENERATION_SPEC.md)
- [Prompt Composition Spec](architecture/PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics](architecture/STORAGE_AND_DIAGNOSTICS.md)
- [Architecture Folder Guide](architecture/README.md)

## Testing Docs

- [Testing Strategy](testing/TESTING_STRATEGY.md)
- [SillyTavern Playwright Harness](testing/SILLYTAVERN_PLAYWRIGHT_HARNESS.md)
- [Live Smoke Test Plan](testing/LIVE_SMOKE_TEST_PLAN.md)
- [Artifact Contract](testing/ARTIFACT_CONTRACT.md)
- [Documentation Render Tracking](testing/DOCUMENTATION_RENDER_TRACKING.md)
- [Implementation Plan](testing/IMPLEMENTATION_PLAN.md)
- Text diagrams live inline as Mermaid graphs or markdown tables; live UI screenshot gaps stay marked inline with `<Render Needed>` until real SillyTavern surfaces are stable.
- [Testing Folder Guide](testing/README.md)

## Historical Planning Docs

- [Documentation Expansion Plan](planning/DOCUMENTATION_EXPANSION_PLAN.md)
- [0.1.0-pre-alpha.6 Documentation Update Brief](planning/2026-07-11-documentation-update-pre-alpha-6.md)
- [Reasoner Capability and Redirect Readiness Fix-Improvement](planning/2026-07-17-reasoner-capability-and-redirect-readiness-fix-improvement.md) - Permanent replacement for hidden Reasoner enablement, provider-test state races, Redirect readiness drift, and stale installed-copy behavior.
- [Provider JSON Robustness Pass](planning/PROVIDER_JSON_ROBUSTNESS_PASS.md)
- [Structured Output Recovery Implementation Plan](superpowers/plans/2026-07-13-recursion-structured-output-recovery.md)
- [Planning Folder Guide](planning/README.md)
- [Internal Superpowers Execution Plan](superpowers/plans/2026-06-30-recursion-v1.md)

## Source And Module READMEs

- [Source Layout](../src/README.md) - Current module map for runtime helpers, pipeline runners, UI presenters, safe-value helpers, and SillyTavern host adapters.
- [Host Adapter Layout](../src/hosts/README.md)
- [Tests](../tests/README.md)
- [Tools](../tools/README.md)
- [Schemas](../schemas/README.md)

## Verification Commands

```powershell
npm.cmd test
node tools\scripts\audit-refactor-hotspots.mjs
node tools\scripts\run-alpha-gate.mjs
rg -n "^<Render Needed>:" README.md docs --glob "*.md" --glob "!docs/planning/DOCUMENTATION_EXPANSION_PLAN.md"
```
