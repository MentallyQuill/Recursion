# Post-process Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` for each behavior change and `superpowers:verification-before-completion` before any completion claim.

**Goal:** Replace Recursion's broken fixed Enhancements system with independent, user-authored Post-process Decks that synthesize guidance through the configured Recursion lane and use SillyTavern's native quiet generation as the actual rewrite author.

**Architecture:** Keep Pre-process and Post-process deck models separate. Freeze one operation snapshot after the original assistant response lands. Route guidance synthesis to Utility for Low/Medium and Reasoner for High/Ultra with one same-lane retry and no fallback. Run one native SillyTavern `quiet` rewrite for Unified or one per runnable category for Progressive. Commit only one final swipe/replacement and persist only structural marker metadata.

**Tech Stack:** Browser ESM, SillyTavern extension APIs, Node.js ESM contract tests, Playwright 1.61, repository live-harness helpers, CSS visual baselines.

**Authoritative design:** [Post-process Cards Design](../specs/2026-07-18-recursion-post-process-cards-design.md)

**Browser proof framework:** [Post-process Cards Playwright Test Framework](../../testing/2026-07-18-post-process-cards-playwright-framework.md)

## Global Constraints

- Recursion is pre-alpha. Replace old contracts in place; do not add compatibility shims.
- Preserve unrelated worktree changes.
- Before implementation, create or switch to an isolated worktree if the current enhancement work is still dirty.
- Use `apply_patch` for edits and explicit `git mv`/`git rm` only for files owned by this feature.
- Read `DESIGN.md`, `docs/design/UI_SPEC.md`, and `docs/design/CARD_SYSTEM_SPEC.md` again before visible UI edits.
- Never use `generateRaw`, `generateQuietPrompt`, a Recursion provider lane, or a connection profile as the prose writer.
- The writer must call SillyTavern `context.generate("quiet", ...)` with `quietToLoud: true`.
- Recursion's bounded guidance context must never replace or cap the host writer's normal context.
- Guidance synthesis never crosses lanes.
- Post-process intermediate drafts remain in operation memory only.
- Generation-enabled live proofs must not capture screenshots or traces.
- Every implementation task starts with a failing test and ends with its focused passing command.

---

## Task 1: Freeze the supersession boundary and dependency map

**Files:**

- Create: `docs/architecture/POST_PROCESS_CARDS_RUNTIME.md`
- Modify: `docs/DOCUMENTATION_INDEX.md`
- Inspect: `src/runtime.mjs`
- Inspect: `src/providers.mjs`
- Inspect: `src/settings.mjs`
- Inspect: `src/ui.mjs`
- Inspect: `src/extension/index.js`
- Inspect: `src/hosts/sillytavern/host.mjs`
- Inspect: `src/editorial-transform.mjs`
- Inspect: `src/generation-review.mjs`
- Inspect: `src/dialogue-enhancement.mjs`
- Inspect: `src/prose-enhancement.mjs`
- Inspect: `src/enhancement-context.mjs`
- Inspect: `src/enhancement-metrics.mjs`

### Step 1: Record the clean baseline

Run:

```powershell
git status --short
npm.cmd test
npm.cmd run test:alpha
npm.cmd run check:playwright
```

Expected:

- Worktree state is understood before edits.
- `npm.cmd test` and `npm.cmd run test:alpha` pass, or every pre-existing failure is recorded before feature work.
- Playwright readiness reports pass.

### Step 2: Map all old enhancement dependencies

Run:

```powershell
rg -n -i "enhancement|generation review|editorial|repair|recompose|redirect|prose enhancement|dialogue enhancement" src tools package.json manifest.json docs
```

Classify every match as:

- delete with the old feature;
- rename to Post-process;
- retain because it is a generic helper;
- historical document that must be marked superseded.

Do not delete a helper until `rg` proves no non-enhancement consumer remains.

### Step 3: Write the runtime boundary document

`docs/architecture/POST_PROCESS_CARDS_RUNTIME.md` must state:

- frozen evidence vs live host writer context;
- Utility/Reasoner guidance role vs SillyTavern writer role;
- Unified and Progressive call sequences;
- same-lane retry and fail-soft rules;
- quiet-generation final-output-only persistence;
- stale-source and cancellation ownership;
- final marker and privacy contract.

### Step 4: Add the new documents to the documentation index

Add direct links to:

- the approved design;
- the implementation plan;
- the runtime architecture;
- the Playwright framework.

Mark current Enhancements documents superseded until Task 11 removes or rewrites them.

### Step 5: Commit the documentation boundary

```powershell
git add docs/architecture/POST_PROCESS_CARDS_RUNTIME.md docs/DOCUMENTATION_INDEX.md
git commit -m "docs: define post-process runtime boundary"
```

---

## Task 2: Add the independent Post-process Deck model and starter deck

**Files:**

- Create: `src/post-process-decks.mjs`
- Create: `tools/scripts/test-post-process-decks.mjs`
- Reference: `src/card-decks.mjs`

### Step 1: Write failing deck tests

Cover:

- exact starter deck id, four categories, nine cards, and order;
- exact approved `Natural Diction` prompt and robot/android exception;
- repair-oriented prompt contracts for `Strip False Weight`, `Earn the Attraction`, and `Ground the Deflection`;
- starter deck is bundled/read-only;
- Natural Prose and Follow Through default On;
- the three cards under Concrete Meaning and Character-Specific Relationships default Off;
- the original six starter cards retain `enabled: true`;
- custom deck CRUD;
- category CRUD and reorder;
- card CRUD, duplicate, move, reorder, and toggle;
- category activity derives from child card states, with no category toggle or persisted category-enabled field;
- runnable selection respects deck order, category state, card state, nonempty name, and nonempty prompt;
- custom and starter data are deeply cloned;
- invalid input normalizes to the V1 shape without importing old enhancement settings.

Test skeleton:

```js
import {
  STARTER_POST_PROCESS_DECK_ID,
  createStarterPostProcessDeck,
  normalizePostProcessDeckSettings,
  orderedRunnablePostProcessCategories
} from "../../src/post-process-decks.mjs";
import { assert, equal, deepEqual } from "../../tests/helpers/assert.mjs";

const starter = createStarterPostProcessDeck({
  now: "2026-07-18T00:00:00.000Z"
});

equal(starter.id, STARTER_POST_PROCESS_DECK_ID);
deepEqual(starter.categoryOrder, [
  "natural-prose",
  "follow-through",
  "concrete-meaning",
  "character-specific-relationships"
]);
deepEqual(
  starter.cardOrderByCategory["natural-prose"],
  ["cut-echoes", "natural-diction", "land-the-ending"]
);
assert(
  starter.cards["natural-diction"].promptText.includes("literal robot or android"),
  "Natural Diction must preserve the approved canonical exception."
);
```

Run:

```powershell
node tools/scripts/test-post-process-decks.mjs
```

Expected: fail because the module does not exist.

### Step 2: Implement the V1 model

Use a dedicated model rather than overloading Pre-process tri-state semantics:

```js
export const POST_PROCESS_DECK_SETTINGS_VERSION = 3;
export const STARTER_POST_PROCESS_DECK_ID = "starter-post-process";

export function isRunnablePostProcessCard(card) {
  return card?.enabled !== false
    && normalizeName(card?.name) !== ""
    && String(card?.promptText || "").trim() !== "";
}

export function orderedRunnablePostProcessCategories(deck) {
  return orderedCategories(deck)
    .map((category) => ({
      ...category,
      cards: orderedCards(deck, category.id)
        .filter((card) => isRunnablePostProcessCard(card))
    }))
    .filter((category) => category.cards.length > 0);
}
```

Reuse naming, timestamp, ordering, and clone patterns from `src/card-decks.mjs`, but do not import its Priority behavior.

### Step 3: Pass focused tests

```powershell
node tools/scripts/test-post-process-decks.mjs
```

Expected: pass.

### Step 4: Commit

```powershell
git add src/post-process-decks.mjs tools/scripts/test-post-process-decks.mjs
git commit -m "feat: add post-process deck model"
```

---

## Task 3: Establish clean settings and Pre-process naming

**Files:**

- Modify: `src/settings.mjs`
- Rename: `src/card-decks.mjs` -> `src/pre-process-decks.mjs`
- Rename: `tools/scripts/test-card-decks.mjs` -> `tools/scripts/test-pre-process-decks.mjs`
- Modify: imports in `src/runtime.mjs`, `src/ui.mjs`, and affected tests
- Modify: `tools/scripts/test-settings.mjs`
- Modify: `tools/scripts/test-settings-policy.mjs`

### Step 1: Write failing settings tests

Assert the exact default:

```js
deepEqual(DEFAULT_RECURSION_SETTINGS.postProcess, {
  enabled: false,
  applyMode: "as-swipe",
  rewriteFlow: "unified",
  contextMessages: 13
});

deepEqual(DEFAULT_RECURSION_SETTINGS.postProcessDecks, {
  version: 3,
  activeDeckId: "starter-post-process",
  customDecks: {},
  starterCardStates: {},
  categoryExpansion: {}
});

assert(!("enhancements" in normalizeSettings({})));
assert(!("cardDecks" in normalizeSettings({})));
```

Also test:

- `preProcessDecks` replaces `cardDecks`;
- old `enhancements`, `cardDecks`, and legacy targets are ignored, not migrated;
- invalid apply/flow values normalize to defaults;
- context messages clamp to 0–35;
- settings-menu reset preserves both custom deck stores and both active deck ids;
- feature Off remains Off by default.

Run:

```powershell
npm.cmd run test:settings
node tools/scripts/test-settings-policy.mjs
```

Expected: fail on the old contracts.

### Step 2: Rename the existing deck module and setting

Use one clean pre-alpha vocabulary:

```js
preProcessDecks: {
  version: PRE_PROCESS_DECK_SETTINGS_VERSION,
  activeDeckId: DEFAULT_PRE_PROCESS_DECK_ID,
  customDecks: {}
},
postProcess: {
  enabled: false,
  applyMode: "as-swipe",
  rewriteFlow: "unified",
  contextMessages: 13
},
postProcessDecks: {
  version: POST_PROCESS_DECK_SETTINGS_VERSION,
  activeDeckId: STARTER_POST_PROCESS_DECK_ID,
  customDecks: {},
  starterCardStates: {},
  categoryExpansion: {}
}
```

Delete `normalizeEnhancementsSettings` and all Enhancement enums.

### Step 3: Update imports and focused tests

Run:

```powershell
rg -n "cardDecks|card-decks|enhancements|normalizeEnhancementsSettings" src tools
npm.cmd run test:settings
node tools/scripts/test-settings-policy.mjs
node tools/scripts/test-pre-process-decks.mjs
```

Expected:

- No current source uses `cardDecks`, `card-decks.mjs`, or `enhancements`.
- All focused tests pass.

### Step 4: Commit

```powershell
git add src/settings.mjs src/pre-process-decks.mjs src/runtime.mjs src/ui.mjs tools/scripts
git commit -m "refactor: separate pre and post process settings"
```

---

## Task 4: Add strict guidance roles and the minimal response contract

**Files:**

- Modify: `src/providers.mjs`
- Modify: `src/reasoning-policy.mjs`
- Modify: `src/provider-capability.mjs`
- Create: `src/post-process-guidance.mjs`
- Create: `tools/scripts/test-post-process-guidance.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `tools/scripts/test-provider-capability.mjs`

### Step 1: Write failing provider tests

Assert:

- `postProcessGuidanceUtility` is a Utility role;
- `postProcessGuidanceReasoner` is a Reasoner role;
- both require `recursion.postProcessGuidance.v1`;
- Low/Medium select Utility;
- High/Ultra select Reasoner;
- one request never changes role or lane during retry;
- malformed, stale-hash, empty-guidance, and wrong-schema outputs fail;
- valid guidance is trimmed and bounded;
- response text is not treated as a story rewrite.

Example:

```js
equal(postProcessGuidanceRoute("low").roleId, "postProcessGuidanceUtility");
equal(postProcessGuidanceRoute("medium").lane, "utility");
equal(postProcessGuidanceRoute("high").roleId, "postProcessGuidanceReasoner");
equal(postProcessGuidanceRoute("ultra").lane, "reasoner");
```

Run:

```powershell
node tools/scripts/test-post-process-guidance.mjs
npm.cmd run test:providers
```

Expected: fail because the roles and contract do not exist.

### Step 2: Register the roles

```js
export const UTILITY_ROLE_IDS = Object.freeze([
  // existing roles...
  "postProcessGuidanceUtility"
]);

export const REASONER_ROLE_IDS = Object.freeze([
  "reasonerComposer",
  "postProcessGuidanceReasoner"
]);

const ROLE_RESPONSE_SCHEMAS = Object.freeze({
  // existing schemas...
  postProcessGuidanceUtility: "recursion.postProcessGuidance.v1",
  postProcessGuidanceReasoner: "recursion.postProcessGuidance.v1"
});
```

Bump `PROVIDER_CONTRACT_VERSION` and its derived hash.

### Step 3: Add routing and request construction

```js
export function postProcessGuidanceRoute(reasoningLevel) {
  const level = normalizeReasoningLevel(reasoningLevel);
  if (level === "high" || level === "ultra") {
    return { lane: "reasoner", roleId: "postProcessGuidanceReasoner" };
  }
  return { lane: "utility", roleId: "postProcessGuidanceUtility" };
}
```

Add `post-process` to reasoning categories with:

- Low -> minimal;
- Medium -> medium;
- High -> medium;
- Ultra -> high.

Build a minimal JSON request that explicitly forbids story authorship:

```js
export function buildPostProcessGuidanceRequest(input) {
  return {
    snapshotHash: input.snapshotHash,
    sourceHash: input.sourceHash,
    prompt: [
      "Return only recursion.postProcessGuidance.v1 JSON.",
      "Analyze where the selected revision cards apply.",
      "Do not rewrite the story response.",
      "Preserve unsupported material and user agency.",
      renderFrozenEvidence(input),
      renderOrderedCards(input.categories),
      renderWritableDraft(input.draft)
    ].join("\n\n"),
    jsonSchema: POST_PROCESS_GUIDANCE_JSON_SCHEMA,
    ...reasoningRequestMetadata(input.reasoningLevel, "post-process")
  };
}
```

### Step 4: Use the router's two-attempt same-role budget

The runtime will make one router call:

```js
const result = await generationRouter.generate(route.roleId, request, {
  maxAttempts: 2,
  allowStructuredRecovery: true,
  signal
});
```

Do not catch and invoke a different role.

### Step 5: Pass focused tests

```powershell
node tools/scripts/test-post-process-guidance.mjs
npm.cmd run test:providers
node tools/scripts/test-provider-capability.mjs
```

Expected: pass.

### Step 6: Commit

```powershell
git add src/providers.mjs src/reasoning-policy.mjs src/provider-capability.mjs src/post-process-guidance.mjs tools/scripts
git commit -m "feat: add strict post-process guidance roles"
```

---

## Task 5: Add the native non-persisting SillyTavern writer

**Files:**

- Modify: `src/hosts/sillytavern/host.mjs`
- Modify: `tools/scripts/test-host.mjs`
- Create: `tools/scripts/test-post-process-host-writer.mjs`

### Step 1: Write failing host-adapter tests

The fake SillyTavern context must prove:

- `context.generate` is called with type `quiet`;
- `quietToLoud: true`;
- the active host generator is used instead of `generateRaw` or `generateQuietPrompt`;
- a dedicated `recursion.postProcessGuidance` system prompt is installed;
- the prompt is cleared in `finally`;
- returned text is normalized;
- abort signal is passed;
- empty output fails;
- thrown generation fails safely;
- original `context.chat` and swipe count are unchanged;
- pre-existing Recursion prompt keys are not destroyed by targeted cleanup.

Example:

```js
const calls = [];
const context = {
  chat: [{ is_user: false, mes: "original", swipes: ["original"], swipe_id: 0 }],
  setExtensionPrompt: (...args) => calls.push(["prompt", ...args]),
  generate: async (type, options) => {
    calls.push(["generate", type, options]);
    return "rewritten response";
  },
  generateRaw: () => { throw new Error("raw writer forbidden"); },
  generateQuietPrompt: () => { throw new Error("quiet helper writer forbidden"); }
};

const result = await host.generation.rewriteWithPostProcess({
  guidancePacket: "packet",
  writerDirective: "directive",
  signal
});

equal(result.text, "rewritten response");
equal(calls.find((entry) => entry[0] === "generate")[1], "quiet");
equal(calls.find((entry) => entry[0] === "generate")[2].quietToLoud, true);
deepEqual(context.chat[0].swipes, ["original"]);
```

Run:

```powershell
node tools/scripts/test-post-process-host-writer.mjs
```

Expected: fail because the adapter method does not exist.

### Step 2: Add the dedicated prompt key

```js
const POST_PROCESS_PROMPT_KEY = "recursion.postProcessGuidance";
```

Do not add this transient packet to the normal pre-process `packetToPromptBlocks` schema. Give it a targeted install/clear lifecycle so normal pre-process prompt blocks remain independently owned.

### Step 3: Implement the writer

```js
async function rewriteWithPostProcess({
  guidancePacket,
  writerDirective,
  signal
} = {}) {
  const context = currentContext(contextFactory);
  if (typeof context.generate !== "function") {
    return rewriteUnavailableResult();
  }

  installTransientSystemPrompt(
    context,
    POST_PROCESS_PROMPT_KEY,
    String(guidancePacket || "")
  );

  try {
    const text = await context.generate("quiet", {
      automatic_trigger: true,
      quiet_prompt: String(writerDirective || ""),
      quietToLoud: true,
      skipWIAN: false,
      signal
    });
    return normalizePostProcessRewrite(text);
  } catch (error) {
    return rewriteFailedResult(error);
  } finally {
    clearPromptKey(context, POST_PROCESS_PROMPT_KEY);
  }
}
```

`writerDirective` must say:

- rewrite the supplied source draft;
- follow the Post-process packet;
- use frozen evidence only to preserve continuity;
- do not continue beyond the response;
- do not mention the editing process;
- return only the revised assistant response.

### Step 4: Pass focused tests

```powershell
node tools/scripts/test-post-process-host-writer.mjs
npm.cmd run test:host
```

Expected: pass.

### Step 5: Commit

```powershell
git add src/hosts/sillytavern/host.mjs tools/scripts/test-host.mjs tools/scripts/test-post-process-host-writer.mjs
git commit -m "feat: add native post-process host writer"
```

---

## Task 6: Implement the deterministic Post-process orchestrator

**Files:**

- Create: `src/post-process-runtime.mjs`
- Create: `tools/scripts/test-post-process-runtime.mjs`
- Modify: `src/runtime.mjs`

### Step 1: Write the state-machine tests

Use injected fake guidance and host-writer functions. Cover this matrix:

1. Off -> no calls, original unchanged.
2. No runnable cards -> no calls.
3. Unified -> one guidance call, one host call, one final candidate.
4. Unified guidance first failure then success -> two same-role attempts, one host call.
5. Unified guidance total failure -> no host call, no commit.
6. Unified host first failure then success -> one guidance result, two identical host packets.
7. Unified host total failure -> no commit.
8. Progressive two categories -> two guidance calls and two host calls in order.
9. Progressive category two receives category one's rewrite, not original.
10. Progressive categories receive the same frozen evidence object/hash.
11. Progressive guidance category failure -> next category receives last valid draft.
12. Progressive host category failure -> next category receives last valid draft.
13. Partial result -> `partial: true`, committed mode forced to `as-swipe`.
14. All categories fail -> no commit.
15. Replace complete success -> in-place final commit.
16. Stop -> abort and no commit.
17. Source stale before final commit -> no commit.
18. Empty/no-op host output consumes retry and fails soft.
19. Settings/deck mutation during run does not alter the frozen plan.
20. Raw prose/guidance never enters returned diagnostics.

Key assertion:

```js
equal(guidanceInputs[0].draft, "original");
equal(guidanceInputs[1].draft, "rewrite after natural prose");
equal(guidanceInputs[0].supportingContext, guidanceInputs[1].supportingContext);
```

Run:

```powershell
node tools/scripts/test-post-process-runtime.mjs
```

Expected: fail because the orchestrator does not exist.

### Step 2: Implement pure planning

```js
export function buildPostProcessPlan({ settings, deck, snapshot }) {
  const categories = orderedRunnablePostProcessCategories(deck);
  const route = postProcessGuidanceRoute(settings.reasoningLevel);
  return deepFreeze({
    operationId: makeId("post-process"),
    snapshot,
    route,
    applyMode: settings.postProcess.applyMode,
    rewriteFlow: settings.postProcess.rewriteFlow,
    categories
  });
}
```

### Step 3: Implement separated call budgets

```js
async function synthesizeCategoryGuidance(stage, operation) {
  return generationRouter.generate(
    operation.route.roleId,
    buildPostProcessGuidanceRequest(stage),
    { maxAttempts: 2, signal: operation.signal }
  );
}

async function rewriteWithRetry(stage, guidance, operation) {
  const packet = buildPostProcessWriterPacket(stage, guidance);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await host.generation.rewriteWithPostProcess({
      guidancePacket: packet,
      writerDirective: buildWriterDirective(stage),
      signal: operation.signal
    });
    if (usableRewrite(result, stage.draft)) return { ...result, attempts: attempt };
  }
  return { ok: false, attempts: 2 };
}
```

The host retry receives the same `packet` object/string. It must not call guidance synthesis again.

### Step 4: Implement Unified and Progressive

```js
async function runProgressive(operation) {
  let latestDraft = operation.snapshot.originalDraft;
  const outcomes = [];

  for (const category of operation.categories) {
    const stage = stageInput(operation, category, latestDraft);
    const guidance = await synthesizeCategoryGuidance(stage, operation);
    if (!guidance.ok) {
      outcomes.push(failedOutcome(category, "guidance", guidance));
      continue;
    }

    const rewrite = await rewriteWithRetry(stage, guidance, operation);
    if (!rewrite.ok) {
      outcomes.push(failedOutcome(category, "host-rewrite", rewrite));
      continue;
    }

    latestDraft = rewrite.text;
    outcomes.push(successOutcome(category, guidance, rewrite));
  }

  return finalizeProgressive(operation, latestDraft, outcomes);
}
```

Unified uses the same stage functions with all categories combined.

### Step 5: Integrate with the main runtime

`src/runtime.mjs` should delegate, not absorb another multi-thousand-line subsystem:

```js
const postProcessRuntime = createPostProcessRuntime({
  host,
  generationRouter,
  settingsStore,
  activity,
  snapshotProvider: () => host.snapshot(),
  sourceGuard: postProcessSourceStillCurrent
});
```

Expose:

```js
postProcessPending
postProcessRunning
runPostProcessForLatestAssistant
cancelPostProcess
postProcessDiagnostics
```

### Step 6: Pass focused tests

```powershell
node tools/scripts/test-post-process-runtime.mjs
npm.cmd run test:runtime
```

Expected: pass.

### Step 7: Commit

```powershell
git add src/post-process-runtime.mjs src/runtime.mjs tools/scripts/test-post-process-runtime.mjs tools/scripts/test-runtime.mjs
git commit -m "feat: orchestrate unified and progressive rewrites"
```

---

## Task 7: Integrate host events, final commit, markers, and Stop

**Files:**

- Modify: `src/extension/index.js`
- Modify: `src/hosts/sillytavern/host.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/progress.mjs`
- Modify: `src/activity.mjs`
- Modify: `tools/scripts/test-extension-smoke.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `tools/scripts/test-activity.mjs`
- Modify: `tools/scripts/test-host.mjs`

### Step 1: Write failing lifecycle tests

Prove:

- post-processing arms during `prepareForGeneration`;
- it begins only for the final landed assistant response;
- internal quiet-generation events do not recursively start it;
- streaming events do not hide the original response;
- Stop aborts both guidance and native quiet generation;
- chat/source/edit/delete/swipe changes cancel stale work;
- the transient prompt key clears on success, failure, and cancellation;
- final As Swipe appends/selects exactly one swipe;
- full-success Replace does not change swipe count;
- partial requested Replace commits As Swipe;
- marker hashes bind to actual source/candidate text;
- source/candidate prose is absent from activity and diagnostics.

### Step 2: Replace enhancement ownership with post-process ownership

Use explicit state names:

```js
let postProcessControlsLocked = false;

if (
  finalGenerationEvent
  && nextRuntime.postProcessRunning?.()
) {
  return { ok: true, skipped: true, reason: "post-process-owned-generation-ended" };
}
```

Delete Enhancement hold/reveal behavior. The original response stays visible because native quiet generation does not mutate chat.

### Step 3: Commit the final result through generic message APIs

Rename Enhancement-specific message APIs and marker storage:

```js
messages.appendAssistantMessageSwipe(messageId, text, {
  markerNamespace: "postProcess",
  marker,
  select: true
});

messages.replaceAssistantMessageText(messageId, text, {
  markerNamespace: "postProcess",
  marker
});
```

Persist under:

```js
extra.recursion.postProcess
__recursionPostProcess
__recursionPostProcessSwipes
```

Delete Generation Review marker names and sanitation methods.

### Step 4: Add progress shapes

Use category parents and guidance/host children. A retried success is amber. A failed category is red. A committed partial parent is amber.

### Step 5: Pass focused tests

```powershell
node tools/scripts/test-extension-smoke.mjs
npm.cmd run test:runtime
npm.cmd run test:host
node tools/scripts/test-progress.mjs
node tools/scripts/test-activity.mjs
```

Expected: pass.

### Step 6: Commit

```powershell
git add src/extension/index.js src/hosts/sillytavern/host.mjs src/runtime.mjs src/progress.mjs src/activity.mjs tools/scripts
git commit -m "feat: integrate post-process lifecycle"
```

---

## Task 8: Build the Post-process Card UI

**Files:**

- Modify: `src/ui.mjs`
- Modify: `src/ui/view-model.mjs`
- Modify: `src/ui/cards-panel.mjs`
- Modify: `src/ui/bar.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-ui.mjs`

### Step 1: Write failing UI presenter and DOM tests

Cover:

- Pre-process Cards accessible naming;
- Post-process button replaces Enhancements in the same toolbar slot;
- Off/On feature state;
- independent deck selectors;
- starter deck read-only controls;
- duplicate starter and blank deck actions;
- Apply segmented control;
- Unified/Progressive segmented control;
- card On/Off with no category-level visibility control;
- category active/inactive state derived from whether any child card is On;
- CRUD editors;
- drag handles only;
- keyboard Escape/focus return;
- mobile panel clamp;
- no Enhancement selectors remain;
- exact stable `data-recursion-*` selectors from the design.

Run:

```powershell
npm.cmd run test:ui
```

Expected: fail on the old Enhancement DOM.

### Step 2: Extract reusable deck-panel primitives

Do not copy another large deck renderer into `src/ui.mjs`. Move presentation-only shared pieces into `src/ui/cards-panel.mjs`:

```js
export function renderDeckBar(options) { /* shared geometry */ }
export function renderDeckCategory(options) { /* shared shell */ }
export function renderDeckCard(options) { /* shared shell */ }
```

Keep semantics injected:

- Pre-process cards supply Off/Active/Priority controls.
- Post-process cards supply Off/On controls.
- Both panels bind the same pointer-drag engine in `src/ui.mjs`.

### Step 3: Replace the toolbar control and panel

Required structure:

```js
el("button", {
  className: "recursion-icon-button",
  attrs: {
    type: "button",
    "aria-label": `Post-process Cards: ${enabled ? "On" : "Off"}`,
    "aria-expanded": panelOpen ? "true" : "false"
  },
  dataset: { recursionPostProcessCardsButton: "" }
});
```

Panel sections:

```text
Post-process Cards + On/Off
Deck selector + actions
Apply: As Swipe / Replace
Rewrite Flow: Unified / Progressive
Ordered category list
Card/category editor or delete confirmation
```

### Step 4: Preserve visual grammar

- Use existing host theme variables.
- Use 12.5px chrome, 11.5px rows, 10px helper copy.
- Use existing 24px icon buttons and 5px controls.
- No nested marketing cards, large headings, gradients, or visible labels added to the bar.
- On compact viewports the panel fills available width and the deck list is the primary scroll surface.

### Step 5: Pass focused tests

```powershell
npm.cmd run test:ui
node tools/scripts/test-post-process-decks.mjs
```

Expected: pass.

### Step 6: Commit

```powershell
git add src/ui.mjs src/ui/view-model.mjs src/ui/cards-panel.mjs src/ui/bar.mjs styles/recursion.css tools/scripts/test-ui.mjs
git commit -m "feat: add post-process card panel"
```

---

## Task 9: Add no-generation Playwright interaction and visual regression proof

**Files:**

- Create: `tools/scripts/prove-post-process-cards-ui.mjs`
- Create: `tools/scripts/test-post-process-playwright-contract.mjs`
- Modify: `tools/scripts/lib/visual-regression.mjs`
- Create: `tests/visual-baselines/post-process-cards/desktop/`
- Create: `tests/visual-baselines/post-process-cards/compact/`
- Modify: `package.json`

Follow the exact matrix, selectors, artifact policy, and baseline promotion flow in [Post-process Cards Playwright Test Framework](../../testing/2026-07-18-post-process-cards-playwright-framework.md).

### Step 1: Write failing dry-run contract tests

The dry-run report must enumerate every required viewport/state case and never require a live host.

```powershell
node tools/scripts/test-post-process-playwright-contract.mjs
```

Expected: fail because the proof script does not exist.

### Step 2: Implement the UI proof

Add:

```json
{
  "prove:post-process-ui": "node tools/scripts/prove-post-process-cards-ui.mjs"
}
```

The script must:

- reject unsafe users before navigation;
- run the installed-copy identity gate;
- authenticate with the shared harness;
- use roles/access names first and `data-recursion-*` second;
- exercise independent deck selection and persisted UI state;
- exercise keyboard and drag behavior;
- capture screenshots only because this path sends no generation;
- use the existing volatile mask convention;
- fail on page errors, console errors, missing controls, overflow, or baseline dimension drift.

### Step 3: Generate and review candidate baselines

```powershell
$env:POST_PROCESS_UI_VISUAL_BASELINES = '1'
$env:UPDATE_VISUAL_BASELINES = '1'
npm.cmd run prove:post-process-ui
```

Manually inspect every desktop and compact image before accepting it.

### Step 4: Run comparison mode

```powershell
$env:POST_PROCESS_UI_VISUAL_BASELINES = '1'
Remove-Item Env:UPDATE_VISUAL_BASELINES -ErrorAction SilentlyContinue
npm.cmd run prove:post-process-ui
```

Expected: all interaction and visual cases pass.

### Step 5: Commit

```powershell
git add package.json tools/scripts/prove-post-process-cards-ui.mjs tools/scripts/test-post-process-playwright-contract.mjs tools/scripts/lib/visual-regression.mjs tests/visual-baselines/post-process-cards
git commit -m "test: add post-process UI visual proof"
```

---

## Task 10: Add generation-enabled live integration proof

**Files:**

- Create: `tools/scripts/prove-live-post-process-cards.mjs`
- Create: `tools/scripts/lib/live-post-process-oracle.mjs`
- Create: `tools/scripts/test-live-post-process-oracle.mjs`
- Modify: `tools/scripts/lib/sillytavern-live-harness.mjs`
- Modify: `tools/scripts/test-live-harness.mjs`
- Modify: `package.json`

### Step 1: Write the failing deterministic oracle

The oracle receives only safe structural evidence:

```js
{
  before: { messageId, swipeId, swipeCount, selectedHash },
  operation: {
    flow,
    lane,
    guidanceCalls,
    hostCalls,
    categoryOutcomes,
    partial
  },
  outbound: {
    postProcessPromptPresent,
    promptHash,
    promptLength,
    hostGenerationType,
    quietToLoud
  },
  after: { messageId, swipeId, swipeCount, selectedHash, marker }
}
```

Test pass/fail rules for:

- Unified As Swipe;
- Unified Replace;
- Progressive complete;
- Progressive partial forced swipe;
- Utility and Reasoner routing;
- same-lane retry;
- guidance reuse during host retry;
- no intermediate swipe;
- total failure/no mutation;
- missing installed-copy proof;
- raw prose leakage;
- wrong host generation type;
- writer call through raw/sidecar API.

### Step 2: Implement the live runner

Add:

```json
{
  "prove:post-process-live": "node tools/scripts/prove-live-post-process-cards.mjs"
}
```

The complete live matrix:

| Case | Reasoning | Flow | Apply | Required proof |
| --- | --- | --- | --- | --- |
| unified-low | Low | Unified | As Swipe | Utility guidance, one quiet writer, one appended selected swipe |
| unified-high | High | Unified | As Swipe | Reasoner guidance, one quiet writer |
| progressive-medium | Medium | Progressive | As Swipe | Utility guidance per category, latest-draft chaining, one final swipe |
| progressive-ultra | Ultra | Progressive | As Swipe | Reasoner guidance per category, latest-draft chaining |
| replace-complete | Medium | Unified | Replace | no swipe-count change, final marker |

Fault injection for retry/fail-soft contracts belongs in deterministic in-page harness cases, not by intentionally breaking a user's provider:

- guidance transient failure then success;
- guidance total category failure;
- host transient failure then success with guidance reused;
- host total category failure;
- partial requested Replace forced to As Swipe.

### Step 3: Enforce the privacy split

When generation is enabled:

- do not start a Playwright trace;
- do not capture screenshots;
- do not write source, candidate, guidance, prompt, or transcript text;
- retain only hashes, lengths, ids, statuses, attempt counts, prompt-key presence, and provider/host route metadata.

### Step 4: Pass deterministic harness tests

```powershell
node tools/scripts/test-live-post-process-oracle.mjs
npm.cmd run test:live-harness
```

Expected: pass.

### Step 5: Run live proof on a dedicated user

```powershell
$env:SILLYTAVERN_BASE_URL = 'http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER = 'recursion-soak-a'
npm.cmd run prove:post-process-live
```

Expected:

- installed/served byte identity passes before navigation;
- all configured cases pass;
- outbound metadata proves `recursion.postProcessGuidance`;
- writer source is `context.generate:quiet`;
- `quietToLoud` is true;
- only final mutation is present;
- marker hashes match final persisted state;
- no raw text appears in report artifacts.

### Step 6: Commit

```powershell
git add package.json tools/scripts/prove-live-post-process-cards.mjs tools/scripts/lib/live-post-process-oracle.mjs tools/scripts/test-live-post-process-oracle.mjs tools/scripts/lib/sillytavern-live-harness.mjs tools/scripts/test-live-harness.mjs
git commit -m "test: prove live post-process integration"
```

---

## Task 11: Remove the obsolete Enhancements implementation

**Files:**

- Delete after dependency audit: `src/editorial-transform.mjs`
- Delete after dependency audit: `src/generation-review.mjs`
- Delete after dependency audit: `src/dialogue-enhancement.mjs`
- Delete after dependency audit: `src/prose-enhancement.mjs`
- Delete after dependency audit: `src/enhancement-context.mjs`
- Delete after dependency audit: `src/enhancement-metrics.mjs`
- Delete: corresponding old Enhancement test/proof/oracle scripts
- Delete: `tests/visual-baselines/editorial-transformation/`
- Modify: `package.json`
- Modify: `src/runtime.mjs`
- Modify: `src/providers.mjs`
- Modify: `src/progress.mjs`
- Modify: `src/activity.mjs`
- Modify: `src/ui.mjs`
- Modify: `src/extension/index.js`
- Modify: `src/hosts/sillytavern/host.mjs`

### Step 1: Write a supersession test

Create a source-contract assertion in `tools/scripts/test-post-process-supersession.mjs`:

- no old enhancement module is importable;
- no current source contains old mode enums or UI selectors;
- no provider role remains solely for the old feature;
- no package script exposes old Enhancement proof commands;
- no old marker namespace remains;
- no old visual baseline directory remains.

Allow historical prose only in the approved design's Supersession section and Git history.

### Step 2: Move any still-generic helper

If the Task 1 map found a shared helper, move it to a neutral module and update its non-enhancement consumers before deletion. Do not retain an old module as a compatibility shell.

### Step 3: Delete old implementation and tests

Remove:

- fixed Enhancement modes and settings;
- review/diagnosis/transform/verify orchestration;
- legacy dialogue/prose passes;
- old fallback behavior;
- old marker sanitation and swipe indexes;
- old UI inspector/menu/selectors;
- old progress phrases and activity stages;
- old provider roles that have no other consumer;
- old live proof and editorial visual matrix.

### Step 4: Pass the source-contract test

```powershell
node tools/scripts/test-post-process-supersession.mjs
rg -n -i "data-recursion-enhancements|enhancement-target|repair|recompose|redirect|generationReviewer|editorialDiagnostician|editorialTransformer|editorialVerifier" src package.json tools/scripts
```

Expected:

- supersession test passes;
- `rg` returns no current executable contract matches.

### Step 5: Commit

```powershell
git add -A src tools package.json tests/visual-baselines
git commit -m "refactor: remove obsolete enhancements"
```

---

## Task 12: Update authoritative product, architecture, technical, user, and testing docs

**Files:**

- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/design/CARD_SYSTEM_SPEC.md`
- Modify: `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/architecture/PROMPT_COMPOSITION_SPEC.md`
- Modify: `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- Modify: `docs/technical/RECURSION_TECHNICAL_MANUAL.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify: `docs/user/PROVIDER_SETUP.md`
- Modify: `docs/testing/TESTING_STRATEGY.md`
- Modify: `docs/testing/SILLYTAVERN_PLAYWRIGHT_HARNESS.md`
- Modify: `docs/DOCUMENTATION_INDEX.md`
- Delete or mark historical: old Enhancement-only current docs

### Step 1: Update the visible design contract

Remove the old prohibition on per-card editing where it conflicts with approved Pre-process/Post-process deck authoring.

Document:

- two card controls in the bar;
- Post-process panel geometry;
- On/Off vs tri-state semantics;
- Unified/Progressive and As Swipe/Replace;
- progress states and partial behavior;
- mobile layout and accessibility.

### Step 2: Update runtime/provider docs

Show the exact split:

```text
bounded frozen evidence
  -> Utility/Reasoner guidance synthesis
  -> transient Post-process packet
  -> SillyTavern context.generate("quiet")
  -> one final chat commit
```

State that the native host writer uses the active preset/context and the Recursion context cap applies only to guidance synthesis.

### Step 3: Update user-facing provider guidance

Explain:

- Low/Medium require Utility for post-process guidance;
- High/Ultra require Reasoner;
- no cross-lane fallback;
- the active SillyTavern model/preset writes the rewrite;
- provider failures fail soft and leave or partially revise the response according to flow.

### Step 4: Update testing docs

Replace old Enhancement proof commands and artifact contracts with:

```powershell
npm.cmd run prove:post-process-ui
npm.cmd run prove:post-process-live
```

### Step 5: Run link and source checks

```powershell
rg -n -i "Enhancement|Generation Review|Repair|Recompose|Redirect" DESIGN.md docs
npm.cmd test
```

Expected:

- remaining matches are explicitly historical/superseded or unrelated English usage;
- tests pass.

### Step 6: Commit

```powershell
git add DESIGN.md docs
git commit -m "docs: adopt post-process cards"
```

---

## Task 13: Run complete deterministic, browser, and live verification

### Step 1: Run the full deterministic suite

```powershell
npm.cmd test
npm.cmd run test:alpha
```

Expected: pass with no old Enhancement test scripts discovered.

### Step 2: Run focused feature tests

```powershell
node tools/scripts/test-post-process-decks.mjs
node tools/scripts/test-post-process-guidance.mjs
node tools/scripts/test-post-process-host-writer.mjs
node tools/scripts/test-post-process-runtime.mjs
node tools/scripts/test-post-process-playwright-contract.mjs
node tools/scripts/test-live-post-process-oracle.mjs
node tools/scripts/test-post-process-supersession.mjs
```

Expected: pass.

### Step 3: Verify Playwright environment

```powershell
npm.cmd run check:playwright
```

Expected: pass.

### Step 4: Run no-generation UI and visual proof

```powershell
$env:SILLYTAVERN_BASE_URL = 'http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER = 'recursion-soak-a'
$env:POST_PROCESS_UI_VISUAL_BASELINES = '1'
npm.cmd run prove:post-process-ui
```

Expected: all desktop/compact interaction and visual cases pass.

### Step 5: Run generation-enabled live proof

```powershell
$env:SILLYTAVERN_BASE_URL = 'http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER = 'recursion-soak-a'
npm.cmd run prove:post-process-live
```

Expected: the complete live matrix passes with no screenshots/traces and no raw text in artifacts.

### Step 6: Inspect artifacts and live persistence

Verify:

- visual report references every required baseline;
- live report contains only safe structural evidence;
- chat swipe/replacement state matches the marker;
- no intermediate Progressive draft exists in chat JSONL;
- installed and served extension hashes match the implemented commit.

### Step 7: Final source audit

```powershell
rg -n -i "data-recursion-enhancements|enhancement-target|prose-enhancement|dialogue-enhancement|generationReviewer|editorialDiagnostician|editorialTransformer|editorialVerifier" src tools package.json
git status --short
git diff --check
```

Expected:

- no obsolete executable contract remains;
- only intended changes remain;
- no whitespace errors.

### Step 8: Request code review

Use `superpowers:requesting-code-review` against the complete implementation diff. Resolve findings, rerun all affected focused tests, then rerun the complete deterministic and live gates.

### Step 9: Commit final verification adjustments

```powershell
git add -A
git commit -m "feat: replace enhancements with post-process cards"
```

Do not create this commit if any required deterministic, visual, installed-copy, or live-host proof is failing.
