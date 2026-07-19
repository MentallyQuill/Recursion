# Pre-process and Post-process Documentation and Render Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace current Enhancements/Cards documentation with the card-system V1 vocabulary, behavior, and live renders for independent Pre-process and Post-process workflows.

**Architecture:** Treat `docs/architecture/POST_PROCESS_CARDS_RUNTIME.md` and `docs/superpowers/specs/2026-07-18-recursion-post-process-cards-design.md` as current Post-process authority. Treat the existing card deck and prompt-packet contracts as Pre-process authority. Rewrite current user, README, technical, design, release, and testing entry points in place; preserve historical Enhancement documents only as explicitly superseded records.

**Tech Stack:** Markdown, Mermaid, the local `.recursion-doc-renderer` Playwright harness, SillyTavern live host, Node verification scripts, and native-resolution PNG assets.

## Global Constraints

- Use `Pre-process Cards` and `Post-process Cards` as the current visible and technical vocabulary.
- Do not describe old `Enhancements`, `Generation Review`, `Dialogue Enhancement`, `Prose Enhancement`, `Editorial Transformation`, or `Redirect` contracts as current behavior.
- Keep the host model as the sole prose writer for Post-process operations; Recursion synthesizes guidance only.
- Preserve historical documents as historical context unless they are current navigation or current authority.
- Every live render must use a dedicated `recursion-soak-*` user and sanitized no-generation or controlled-generation state.
- Renders must be cropped to the relevant surface and displayed at native resolution or smaller; never upscale.
- Every promoted render needs one current documentation reference and one tracking-table row.
- Preserve unrelated dirty worktree changes.

---

### Task 1: Update current documentation vocabulary and authority routing

**Files:**
- Modify: `README.md`
- Modify: `docs/DOCUMENTATION_INDEX.md`
- Modify: `docs/user/README.md`
- Modify: `docs/user/FIRST_RUN_WORKFLOW.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/user/PROVIDER_SETUP.md`
- Modify: `docs/technical/README.md`
- Modify: `docs/technical/RECURSION_TECHNICAL_MANUAL.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify: `docs/technical/CARD_DECK_AND_HAND.md`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- Modify: `docs/architecture/README.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`
- Modify: `docs/design/CARD_SYSTEM_SPEC.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/testing/README.md`
- Modify: `docs/testing/TESTING_STRATEGY.md`
- Modify: `docs/testing/LIVE_SMOKE_TEST_PLAN.md`
- Modify: `docs/testing/SILLYTAVERN_PLAYWRIGHT_HARNESS.md`
- Modify: `docs/testing/ARTIFACT_CONTRACT.md`
- Modify: `docs/release/README.md`
- Modify: `docs/release/0.1.0-pre-alpha.6.md`

**Interfaces:**
- Consumes: `src/pre-process-decks.mjs`, `src/post-process-decks.mjs`, `src/post-process-guidance.mjs`, `src/post-process-runtime.mjs`, `src/settings.mjs`, `src/ui.mjs`, and the current Post-process runtime boundary.
- Produces: one consistent current vocabulary, lifecycle explanation, provider-routing contract, settings contract, and testing matrix.

- [ ] Replace current Enhancements descriptions with Post-process Cards and distinguish Unified from Progressive.
- [ ] Rename the current Cards surface to Pre-process Cards while retaining the shorthand `Cards` only where it is an actual UI label or historical reference.
- [ ] Document the two independent deck settings and their non-interference contract.
- [ ] Document native host writing, frozen evidence, retries, stale-operation rejection, partial Progressive settlement, and final-only persistence.
- [ ] Route current indexes and manuals to `POST_PROCESS_CARDS_RUNTIME.md` and the Post-process design instead of the superseded Generation Review contract.
- [ ] Mark old Enhancement/Editorial plans and release records as historical without presenting them as current authority.

### Task 2: Replace current render markers and define the capture matrix

**Files:**
- Modify: `docs/testing/DOCUMENTATION_RENDER_TRACKING.md`
- Modify: `docs/planning/DOCUMENTATION_EXPANSION_PLAN.md`
- Add/update: `assets/documentation/renders/`

**Interfaces:**
- Consumes: live UI selectors and fixture states from `.recursion-doc-renderer`, current `src/ui.mjs` labels, and the visual-baseline matrix under `tests/visual-baselines/`.
- Produces: promoted native-resolution PNGs for process overview, Pre-process panels, Post-process panels, settings, progress, failure, privacy, and mobile behavior.

- [ ] Add explicit `<Render Needed>` entries at current-doc image locations before capture.
- [ ] Capture process overview, Pre-process deck/state/editor/hand/packet surfaces, and Post-process starter/unified/progressive/editor/result/failure surfaces.
- [ ] Capture settings, provider routing, transient prompt boundary, responsive mobile layout, and updated first-run/release smoke views.
- [ ] Give every promoted image a stable name, current primary-doc reference, visual-scope description, and source type.
- [ ] Remove or mark stale renders only after all current references and tracking rows are updated.

### Task 3: Capture and visually verify live renders

**Files:**
- Modify as needed: `.recursion-doc-renderer/render-all.ps1`, `.recursion-doc-renderer/capture-live.mjs`, and fixture definitions.
- Add: `assets/documentation/renders/*.png`

**Interfaces:**
- Consumes: the real local SillyTavern host, dedicated `recursion-soak-*` user, and current branch UI.
- Produces: cropped screenshots whose visible labels, state controls, and content match the current card-system contract.

- [ ] Run the renderer against the current branch, not a stale installed copy.
- [ ] Verify each crop contains all relevant controls and no unrelated panel or clipped edge.
- [ ] Verify each image's native pixel dimensions and ensure no documentation display enlarges it.
- [ ] Inspect each new render visually at original resolution before promotion.
- [ ] Reject captures containing provider secrets, raw prompts/responses, hidden reasoning, private transcripts, or temporary host artifacts.

### Task 4: Wire, audit, and verify

**Files:**
- Modify: all current docs touched by Tasks 1–2.
- Modify: `docs/testing/DOCUMENTATION_RENDER_TRACKING.md`

- [ ] Replace every current render marker with a verified image reference.
- [ ] Scan current docs for stale `Enhancement`, `Generation Review`, `Prose`, `Dialogue`, `Editorial`, and old Cards wording.
- [ ] Confirm every promoted render is referenced by a current doc and every referenced image exists.
- [ ] Run `node .recursion-doc-renderer/check-doc-images.mjs`.
- [ ] Run the render-inventory count check and marker-format check.
- [ ] Run Markdown link validation and `git diff --check`.
- [ ] Review the final diff for accidental edits to historical records or unrelated worktree changes.

