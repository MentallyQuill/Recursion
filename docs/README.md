# Recursion Documentation

This folder holds the Recursion documentation set: the canonical index, release notes, user guides, technical references, design specs, architecture specs, testing contracts, and planning documents.

Use [Documentation Index](DOCUMENTATION_INDEX.md) as the main map. Use [Release Notes](release/README.md) for release-facing status.

Render status is tracked in [Documentation Render Tracking](testing/DOCUMENTATION_RENDER_TRACKING.md). Explanatory diagrams should stay text-native as Mermaid graphs or markdown tables; live SillyTavern screenshots stay marked as `<Render Needed>` until the real extension surface is stable enough to capture.

## Folder Guide

| Path | Purpose |
| --- | --- |
| `release/` | Release notes and pre-alpha signoff records. |
| `user/` | Operator-facing setup, normal-use, provider, privacy, and safety manuals. |
| `technical/` | Release-facing technical manuals for runtime, cards, prompt packets, providers, storage, diagnostics, and host integration. |
| `design/` | Product, card-system, source-backed behavior settings policy, UI, and historical seed design documents. |
| `architecture/` | Implementation-facing runtime, provider, prompt, storage, and diagnostics specs. |
| `testing/` | Local gates, Playwright readiness, live smoke plans, artifact contracts, and implementation verification notes. |
| `planning/` | Staged documentation and product-work plans. |
| `superpowers/` | Internal Superpowers execution notes for this pre-alpha documentation and implementation pass. |

Promoted documentation images live outside this tree in [Documentation Assets](../assets/documentation/README.md).

## Current Entry Points

- [Documentation Index](DOCUMENTATION_INDEX.md)
- [Release Notes](release/README.md)
- [Recursion Extension Spec](RECURSION_EXTENSION_SPEC.md)
- [Behavior Settings Policy Spec](design/BEHAVIOR_SETTINGS_POLICY_SPEC.md)
- [User Guides](user/README.md)
- [First Run Workflow](user/FIRST_RUN_WORKFLOW.md)
- [Recursion Operator Manual](user/RECURSION_OPERATOR_MANUAL.md)
- [Provider Setup](user/PROVIDER_SETUP.md)
- [Prompt Privacy And Safety](user/PROMPT_PRIVACY_AND_SAFETY.md)
- [Technical Manuals](technical/README.md)
- [Recursion Technical Manual](technical/RECURSION_TECHNICAL_MANUAL.md)
- [Testing Strategy](testing/TESTING_STRATEGY.md)
- [Documentation Render Tracking](testing/DOCUMENTATION_RENDER_TRACKING.md)
- [Documentation Expansion Plan](planning/DOCUMENTATION_EXPANSION_PLAN.md)
- [Internal Superpowers Execution Plan](superpowers/plans/2026-06-30-recursion-v1.md)
