# Recursion Documentation Update Implementation Plan

> **For agentic workers:** This documentation pass is executed inline in the current checkout; no compatibility shim is required because Recursion is pre-alpha.

**Goal:** Bring the README and canonical documentation surfaces into agreement with every user-facing contract introduced between `main` and `card-system`, while marking missing live UI captures with `<Render Needed>`.

**Architecture:** Use the branch diff as the source inventory, then update the canonical public, user, architecture, technical, design, release, testing, and render-tracking documents. Existing detailed specs and implementation plans remain historical/implementation references; canonical docs receive concise current behavior and links to those deeper contracts.

**Tech Stack:** Markdown, Mermaid, PowerShell verification, Git diff inspection.

## Global Constraints

- Preserve the pre-alpha V1 contract; do not add legacy compatibility language.
- Keep screenshots only when the referenced asset exists and is current; otherwise use a visible `<Render Needed>:` marker.
- Do not create rendered assets in this pass; the doc-renderer will supply them later.
- Keep documentation claims grounded in the `main..card-system` code, tests, and existing detailed specs.

## Tasks

- [ ] Update `README.md` with the consolidated card/deck, pipeline, Enhancement, recovery, privacy, and verification overview; mark missing feature renders.
- [ ] Update `docs/DOCUMENTATION_INDEX.md`, release notes, and folder inventories so the new canonical contracts are discoverable.
- [ ] Update user docs (`FIRST_RUN_WORKFLOW.md`, `PROVIDER_SETUP.md`, `RECURSION_OPERATOR_MANUAL.md`) with current controls, Enhancement modes, status meanings, and safe recovery behavior.
- [ ] Update architecture/technical/design/testing docs with the current runtime, routing, cache/reuse, UI maturity, card, failure, and live-proof contracts.
- [ ] Update `assets/documentation/README.md` and `docs/testing/DOCUMENTATION_RENDER_TRACKING.md` with pending live-host captures.
- [ ] Verify links, render markers, Markdown references, and the final documentation-only diff.
