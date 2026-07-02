# Recursion Documentation Index

This is the canonical map for Recursion documentation. Current docs are linked directly. Broader documentation work is tracked in [Documentation Expansion Plan](planning/DOCUMENTATION_EXPANSION_PLAN.md).

## Release Notes

- [Release Notes Directory](release/README.md)
- [0.1.0-pre-alpha.1](release/0.1.0-pre-alpha.1.md)

## Start And Operator Docs

- [Root README](../README.md) - Public route map and fast start.
- [Docs Folder Guide](README.md) - Folder-level guide for this documentation tree.
- [User Guides](user/README.md) - Operator-facing table of contents.
- [First Run Workflow](user/FIRST_RUN_WORKFLOW.md) - First-session path from install through Auto, Manual, inspection, and power-toggle cleanup.
- [Recursion Operator Manual](user/RECURSION_OPERATOR_MANUAL.md) - Complete practical manual for UI surfaces, modes, settings, operation, diagnostics, storage, mobile behavior, and smoke checks.

## Provider, Privacy, And Safety Docs

- [Provider and Generation Spec](architecture/PROVIDER_AND_GENERATION_SPEC.md) - Current provider lanes, source routing, machine-JSON schema metadata, structured calls, validation, and secret handling contract.
- [Storage and Diagnostics](architecture/STORAGE_AND_DIAGNOSTICS.md) - Current storage, journal, diagnostics, redaction, and retention contract.
- [Provider Setup](user/PROVIDER_SETUP.md) - Utility and Reasoner setup, source options, autosaving provider fields, model discovery, session-only keys, provider tests, fallback behavior, and safe verification.
- [Prompt Privacy And Safety](user/PROMPT_PRIVACY_AND_SAFETY.md) - Prompt packet contents, injection boundary, storage limits, redaction, external extension coexistence, and safety checks.

## Technical Manuals

- [Technical Manuals](technical/README.md) - Table of contents for the technical manual family.
- [Recursion Technical Manual](technical/RECURSION_TECHNICAL_MANUAL.md) - Product boundary, runtime spine, component ownership, modes, provider lanes, card/hand system, prompt packet, storage, diagnostics, host adapter, UI observability, fail-soft invariants, testing evidence, and non-goals.
- [Runtime Turn Sequence](technical/RUNTIME_TURN_SEQUENCE.md) - Power toggle, Auto, and Manual lifecycle from snapshot capture through Utility planning, card jobs, hand selection, composition, injection, storage, cancellation, stale results, and failure branches.
- [Card Deck And Hand](technical/CARD_DECK_AND_HAND.md) - Fixed V1 card families, card contract, lifecycle, Arbiter decisions, deck/hand separation, invalidation, Character Motivation safety, and inspector visibility.
- [Prompt Packet And Injection](technical/PROMPT_PACKET_AND_INJECTION.md) - Packet sections, composer inputs, Utility and Reasoner composition, budgets, omissions, critical guardrail exception policy, SillyTavern injection lanes, cleanup, and privacy guardrails.
- [Model Calls And Provider Routing](technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md) - Utility and Reasoner lanes, provider sources, generation roles, structured output validation, retries, fallbacks, model-call journal, session secret boundary, abort handling, and provider states.
- [Storage And Diagnostics Manual](technical/STORAGE_AND_DIAGNOSTICS.md) - Release-facing storage, scene cache, run journal, activity, redaction, invalidation, cleanup, artifact relationship, and tests.
- [Host Integration Manual](technical/HOST_INTEGRATION_MANUAL.md) - SillyTavern adapter, entrypoint lifecycle, generation interceptor, prompt/storage/settings/generation adapters, UI mount, fake/contract tests, live smoke guardrails, and deferred host boundary.

## Design And Source Specs

- [Model-Facing Design System](../DESIGN.md) - DESIGN.md-format visual identity contract for agents and UI work.
- [Recursion Extension Spec](RECURSION_EXTENSION_SPEC.md) - Top-level V1 design and implementation contract.
- [Product Scope](design/RECURSION_PRODUCT_SCOPE.md) - Product promise, V1 scope, non-goals, and success criteria.
- [Card System Spec](design/CARD_SYSTEM_SPEC.md) - Fixed V1 catalog, card lifecycle, Utility Arbiter responsibilities, and turn hand.
- [Behavior Settings Policy Spec](design/BEHAVIOR_SETTINGS_POLICY_SPEC.md) - Source-backed V1 contract for Strength, Min/Max Cards, Focus, and Prompt Footprint backend effects.
- [UI Spec](design/UI_SPEC.md) - Recursion Bar, Hero Pixel Array progress menu, options/settings menu, Last Brief dropdown, viewer, settings, and provider controls.
- [Turn Context Compiler Seed Note](design/RECURSION_TURN_CONTEXT_COMPILER.md) - Historical seed note superseded by the V1 spec family.
- [Design Folder Guide](design/README.md)

## Architecture Specs

- [Runtime Architecture](architecture/RUNTIME_ARCHITECTURE.md)
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
- Static infographics promoted under `assets/documentation/renders/` are tracked in Documentation Render Tracking; live UI screenshot gaps stay marked inline with `<Render Needed>` until real SillyTavern surfaces are stable.
- [Testing Folder Guide](testing/README.md)

## Planning Docs

- [Documentation Expansion Plan](planning/DOCUMENTATION_EXPANSION_PLAN.md)
- [Provider JSON Robustness Pass](planning/PROVIDER_JSON_ROBUSTNESS_PASS.md)
- [Planning Folder Guide](planning/README.md)
- [Internal Superpowers Execution Plan](superpowers/plans/2026-06-30-recursion-v1.md)

## Source And Module READMEs

- [Source Layout](../src/README.md)
- [Host Adapter Layout](../src/hosts/README.md)
- [Tests](../tests/README.md)
- [Tools](../tools/README.md)
- [Schemas](../schemas/README.md)

## Verification Commands

```powershell
npm.cmd test
node tools\scripts\run-alpha-gate.mjs
rg -n "^<Render Needed>:" README.md docs --glob "*.md" --glob "!docs/planning/DOCUMENTATION_EXPANSION_PLAN.md"
```
