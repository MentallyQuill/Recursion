# Post-process Cards Playwright Test Framework

**Status:** Required integration and visual proof

**Date:** 2026-07-18

**Feature design:** [Post-process Cards Design](../superpowers/specs/2026-07-18-recursion-post-process-cards-design.md)

**Implementation plan:** [Post-process Cards Implementation Plan](../superpowers/plans/2026-07-18-recursion-post-process-cards.md)

## Purpose

This framework proves three different things without confusing their evidence:

1. **UI interaction:** users can configure independent Post-process Decks through the actual Recursion UI.
2. **Visual integrity:** the panel, editors, controls, and compact layout match reviewed baselines.
3. **Runtime integration:** real guidance calls and SillyTavern native quiet rewrites follow the approved routing, sequencing, fail-soft, and final-persistence contracts.

No single green status is sufficient. The UI proof cannot certify writer ownership, and a provider call cannot certify visible UI or final chat mutation.

## Test Layers

| Layer | Script | Generation | Binary artifacts | Primary proof |
| --- | --- | --- | --- | --- |
| Offline readiness | `check-playwright-readiness.mjs` | No | Allowed | Chromium and basic interaction work. |
| Deterministic browser contract | `test-post-process-playwright-contract.mjs` | No | No | Matrix, selector, safety, and report contracts. |
| Live UI interaction/visual | `prove-post-process-cards-ui.mjs` | No | Screenshots and traces allowed | Actual SillyTavern UI behavior and visual baselines. |
| Deterministic runtime fault matrix | `test-post-process-runtime.mjs` plus live oracle tests | Stubbed | No | Retry, fail-soft, chaining, and mutation rules. |
| Live generation integration | `prove-live-post-process-cards.mjs` | Yes | Screenshots/traces forbidden | Configured providers, native host writer, outbound packet, and final persistence. |

## Safety Gates

Every live Playwright script must run these gates before browser navigation, storage mutation, prompt installation, or provider calls:

1. Require `RECURSION_SILLYTAVERN_USER`.
2. Normalize and validate it with `validateSoakUserHandle`.
3. Require the `recursion-soak-*` pattern.
4. Reject `default-user`, `default`, `user`, empty values, and duplicates.
5. Authenticate through `createSillyTavernHttpSession`.
6. Run the installed-copy SHA-256 verifier.
7. Require repository, installed extension, and served extension bytes to match.
8. Stop immediately on stale or unavailable served bytes.

No direct runtime bridge fallback may bypass a failed visible-browser preflight.

## Commands

### Offline

```powershell
npm.cmd run check:playwright
node tools/scripts/test-post-process-playwright-contract.mjs
```

### Live no-generation UI/visual

```powershell
$env:SILLYTAVERN_BASE_URL = 'http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER = 'recursion-soak-a'
$env:POST_PROCESS_UI_VISUAL_BASELINES = '1'
npm.cmd run prove:post-process-ui
```

### Update candidate visual baselines

```powershell
$env:SILLYTAVERN_BASE_URL = 'http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER = 'recursion-soak-a'
$env:POST_PROCESS_UI_VISUAL_BASELINES = '1'
$env:UPDATE_VISUAL_BASELINES = '1'
npm.cmd run prove:post-process-ui
```

Baseline updates are candidate creation, not automatic approval. A human must inspect every changed image at native resolution.

### Live generation integration

```powershell
$env:SILLYTAVERN_BASE_URL = 'http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER = 'recursion-soak-a'
npm.cmd run prove:post-process-live
```

## Stable Selector Contract

Use selectors in this order:

1. role and accessible name;
2. label/title;
3. stable `data-recursion-*`;
4. stable SillyTavern host id;
5. CSS class only for visual scoping or diagnostics.

Required Post-process selectors:

```text
data-recursion-pre-process-cards-button
data-recursion-post-process-cards-button
data-recursion-post-process-panel
data-recursion-post-process-enabled
data-recursion-post-process-deck-select
data-recursion-post-process-deck-duplicate
data-recursion-post-process-deck-new
data-recursion-post-process-deck-edit
data-recursion-post-process-deck-delete
data-recursion-post-process-apply-as-swipe
data-recursion-post-process-apply-replace
data-recursion-post-process-flow-unified
data-recursion-post-process-flow-progressive
data-recursion-post-process-category
data-recursion-post-process-category-toggle
data-recursion-post-process-category-drag-handle
data-recursion-post-process-card
data-recursion-post-process-card-toggle
data-recursion-post-process-card-drag-handle
data-recursion-post-process-card-editor
data-recursion-post-process-card-prompt
data-recursion-post-process-progress
```

Do not retain or alias `data-recursion-enhancements-*`.

## Browser Viewports

Use deterministic CSS-pixel viewports and `deviceScaleFactor: 1`:

```js
const VIEWPORTS = [
  { name: "desktop", width: 1360, height: 820 },
  { name: "compact", width: 390, height: 844 }
];
```

For every viewport:

- disable animations for screenshots;
- hide the caret;
- honor the browser's default reduced-motion behavior in a separate accessibility case;
- mask only elements marked `data-recursion-visual-volatile`;
- keep the Recursion root and the complete Post-process panel inside the image.

## No-generation UI Interaction Suite

`tools/scripts/prove-post-process-cards-ui.mjs` runs against the actual served extension without sending a chat message or invoking a provider.

### Required setup

1. Open SillyTavern.
2. Wait for `#recursion-root`.
3. Assert no page errors or error-level console messages.
4. Open Pre-process Cards and record its active deck id.
5. Close Pre-process Cards.
6. Open Post-process Cards.
7. Assert Post-process is Off by default.
8. Assert the starter deck is active, bundled, and read-only.
9. Assert exactly two categories and six cards in the approved order.

### Independent deck proof

Through visible controls:

1. Duplicate the starter Post-process Deck.
2. Rename it `Playwright Post-process Deck`.
3. Switch to a different Pre-process Deck.
4. Reopen Post-process Cards.
5. Assert `Playwright Post-process Deck` remains selected.
6. Switch Post-process deck back to Starter.
7. Reopen Pre-process Cards.
8. Assert its selection did not change.
9. Reload the page.
10. Assert both selections persist independently.

The report stores deck ids/names only; it does not store prompt text.

### CRUD and ordering proof

Through visible controls:

1. Select the duplicated editable Post-process Deck.
2. Create category `Playwright Category`.
3. Create card `Playwright Card`.
4. Enter a harmless synthetic prompt: `Preserve the source and make one concrete supported change.`
5. Save and assert the card is runnable.
6. Toggle the card Off and On.
7. Toggle its category Off.
8. Assert the card's saved On state remains and its effective state is disabled.
9. Toggle the category On and assert the card becomes effectively runnable again.
10. Drag the category above `Natural Prose`.
11. Drag the card into `Natural Prose`.
12. Reload and assert order/category persistence.
13. Duplicate the card and assert a unique copy name.
14. Delete the duplicate through the destructive confirmation flow.

Drag must begin from the grip handle. Attempting the same pointer movement from the row body must not reorder.

### Settings proof

Through visible segmented controls:

1. Set Post-process On.
2. Select As Swipe.
3. Select Unified.
4. Assert `aria-pressed` state and persisted settings.
5. Select Replace.
6. Select Progressive.
7. Reload.
8. Assert Replace and Progressive remain selected.
9. Set Post-process Off before teardown.

### Keyboard and accessibility proof

Assert:

- toolbar buttons are reachable by Tab;
- Enter/Space opens the panel;
- focus moves to the deck selector;
- category expanders expose `aria-expanded`;
- On/Off and segmented controls expose `aria-pressed`;
- Escape closes the panel and returns focus to the Post-process button;
- icon-only actions have nonempty accessible names;
- focus outlines are visible;
- no duplicate ids exist;
- a reduced-motion context has no running CSS animation on Recursion controls.

### Layout and overflow proof

For the open panel:

```js
const panelBox = await panel.boundingBox();
const viewport = page.viewportSize();

check(panelBox.x >= 0, "panel overflows left");
check(panelBox.y >= 0, "panel overflows top");
check(panelBox.x + panelBox.width <= viewport.width, "panel overflows right");
check(panelBox.y + panelBox.height <= viewport.height, "panel overflows bottom");
```

Also assert:

- header and segmented controls remain visible;
- the deck list is the primary vertical scroll surface;
- card prompt inputs do not exceed panel width;
- no horizontal scrollbar appears at either viewport;
- the final card/category row can be scrolled into view;
- the compact panel does not cover an unreachable footer/control.

## Visual Regression Matrix

Each state is captured for desktop and compact viewports.

| State id | Required visible state |
| --- | --- |
| `starter-off` | Starter deck, feature Off, Unified, As Swipe, categories collapsed. |
| `starter-unified` | Feature On, Unified selected, Natural Prose expanded. |
| `starter-progressive` | Feature On, Progressive and Replace selected, both categories expanded. |
| `custom-deck` | Editable duplicated deck with deck/category/card actions visible. |
| `card-editor` | Card editor open with name, description, prompt field, accept/cancel controls. |
| `category-disabled` | Category Off with child saved-On/effectively-disabled treatment visible. |
| `delete-confirm` | Typed-confirmation deck delete state with complete controls in bounds. |

Baseline layout:

```text
tests/visual-baselines/post-process-cards/
├─ desktop/
│  ├─ starter-off.png
│  ├─ starter-unified.png
│  ├─ starter-progressive.png
│  ├─ custom-deck.png
│  ├─ card-editor.png
│  ├─ category-disabled.png
│  └─ delete-confirm.png
└─ compact/
   └─ same seven files
```

### Visual comparison behavior

The current helper must become an assertion, not an informational hash collector:

```js
export async function assertVisualBaseline(
  locator,
  snapshotPath,
  { mask = [], requireBaseline = true } = {}
) {
  const actual = await locator.screenshot({
    animations: "disabled",
    caret: "hide",
    scale: "css",
    mask: mask.map((selector) => locator.locator(selector))
  });

  if (!existsSync(snapshotPath)) {
    if (requireBaseline) throw new Error(`Visual baseline missing: ${snapshotPath}`);
    return { ok: true, baseline: "missing", sha256: digest(actual) };
  }

  const expected = readFileSync(snapshotPath);
  assertSamePngDimensions(actual, expected, snapshotPath);

  const actualHash = digest(actual);
  const expectedHash = digest(expected);
  if (actualHash !== expectedHash) {
    throw new Error(
      `Visual baseline changed: ${snapshotPath} ` +
      `(expected ${expectedHash}, received ${actualHash})`
    );
  }

  return { ok: true, baseline: "match", sha256: actualHash };
}
```

Exact comparison is intentional because:

- Chromium version is pinned by the installed Playwright package;
- viewports and device scale are fixed;
- animations/caret are disabled;
- volatile regions are explicitly masked;
- the proof runs against one local SillyTavern host.

If future cross-platform CI requires tolerance, add a reviewed pixel-diff dependency and a documented threshold. Do not silently accept `captured-different`.

### Screenshot scope

Capture the smallest complete stable surface:

```js
await assertVisualBaseline(
  page.locator("#recursion-root"),
  baselinePath,
  { mask: ["[data-recursion-visual-volatile]"] }
);
```

Do not mask the Post-process panel, selected controls, category/card states, editors, focus state, warnings, or scroll geometry.

## Visual Proof Script Skeleton

```js
import { chromium } from "playwright";
import { resolve } from "node:path";
import { assertVisualBaseline } from "./lib/visual-regression.mjs";
import {
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from "./lib/sillytavern-live-harness.mjs";

const CASES = [
  "starter-off",
  "starter-unified",
  "starter-progressive",
  "custom-deck",
  "card-editor",
  "category-disabled",
  "delete-confirm"
];

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  await openVerifiedSillyTavern(page);

  for (const state of CASES) {
    await drivePostProcessUiToState(page, state);
    await assertPostProcessLayout(page, viewport);
    await assertNoBrowserErrors(page);

    if (process.env.POST_PROCESS_UI_VISUAL_BASELINES === "1") {
      const baselinePath = resolve(
        "tests",
        "visual-baselines",
        "post-process-cards",
        viewport.name,
        `${state}.png`
      );
      await captureOrCompare(page, baselinePath);
    }
  }
}
```

No state setup may call a provider or send a SillyTavern message.

## Live Generation Integration Suite

`tools/scripts/prove-live-post-process-cards.mjs` uses Playwright to drive the actual served UI and configured host/provider paths.

### Privacy mode

Before navigation:

```js
const generationEnabled = true;
const captureScreenshots = false;
const captureTrace = false;
```

The script must fail if any code path attempts to write a PNG, JPEG, WebP, video, HAR, or Playwright trace during generation-enabled execution.

### Safe host instrumentation

Instrumentation may observe call structure but must discard raw text immediately:

```js
await page.evaluate(() => {
  const originalGetContext = SillyTavern.getContext.bind(SillyTavern);
  const evidence = [];

  SillyTavern.getContext = () => {
    const context = originalGetContext();
    const originalGenerate = context.generate.bind(context);
    const originalSetPrompt = context.setExtensionPrompt.bind(context);
    return {
      ...context,
      generate: async (type, options = {}) => {
        evidence.push({
          event: "host-generate",
          type: String(type),
          quietToLoud: options.quietToLoud === true,
          hasSignal: Boolean(options.signal),
          quietPromptLength: String(options.quiet_prompt || "").length
        });
        return originalGenerate(type, options);
      },
      setExtensionPrompt: (key, text, ...rest) => {
        if (key === "recursion.postProcessGuidance") {
          evidence.push({
            event: "post-process-prompt",
            key,
            present: String(text || "").length > 0,
            length: String(text || "").length
          });
        }
        return originalSetPrompt(key, text, ...rest);
      }
    };
  };

  window.__restoreRecursionPostProcessInstrumentation = () => {
    SillyTavern.getContext = originalGetContext;
  };
  window.__recursionPostProcessSafeEvidence = evidence;
});
```

The production runtime diagnostics must additionally expose a hash of the installed packet. The browser report may store the hash and length, never the packet.

### Outbound request evidence

Observe host generation network requests in memory:

1. Identify SillyTavern generation endpoints.
2. Inspect the request body only long enough to derive:
   - endpoint class;
   - body length;
   - SHA-256;
   - boolean presence of the Post-process packet's non-sensitive schema marker;
   - request count.
3. Discard the body before report construction.
4. Never log Playwright `request.postData()`.

The proof fails if:

- no host writer request contains the marker;
- the writer is recorded as `generateRaw` or `generateQuietPrompt`;
- the host generation type is not `quiet`;
- `quietToLoud` is not true.

### Live matrix

| Case | Visible setup | Guidance expectation | Host expectation | Final expectation |
| --- | --- | --- | --- | --- |
| `unified-low-swipe` | Low, Unified, As Swipe, On | Utility, one successful packet | one quiet rewrite unless one host retry | exactly one appended selected swipe |
| `unified-high-swipe` | High, Unified, As Swipe, On | Reasoner, no Utility fallback | one quiet rewrite unless one host retry | exactly one appended selected swipe |
| `progressive-medium-swipe` | Medium, Progressive, As Swipe, On | Utility per runnable category | one quiet rewrite per successful category | one final swipe only |
| `progressive-ultra-swipe` | Ultra, Progressive, As Swipe, On | Reasoner per runnable category | one quiet rewrite per successful category | one final swipe only |
| `unified-medium-replace` | Medium, Unified, Replace, On | Utility | one quiet rewrite unless retry | same swipe count, changed selected hash |

The full proof uses a deterministic live test deck with two harmless categories so call counts are unambiguous. The approved Starter Deck is separately proven by UI/contract tests.

### Live assertions

For each case:

1. Capture safe pre-state: chat key hash, message id, selected swipe id, swipe count, selected text hash.
2. Configure through visible Recursion controls.
3. Trigger a visible SillyTavern generation.
4. Wait on Recursion progress/operation state, not an arbitrary sleep.
5. Capture guidance role/lane and attempt counts.
6. Capture safe host writer evidence.
7. Capture safe final state and marker.
8. Assert:
   - source identity stayed bound;
   - expected lane only;
   - guidance attempts are one or two;
   - host attempts are one or two;
   - Progressive host inputs chain by draft hash;
   - every category has the same frozen-context hash;
   - no intermediate swipe was added;
   - final swipe/replace mutation is exact;
   - marker source/candidate hashes match;
   - prompt key cleared after operation;
   - report contains no raw text.

## Deterministic Failure Injection

Do not sabotage a configured live provider to test failures. Use an in-page deterministic adapter around the production runtime seams, with synthetic text kept out of durable chat.

Required cases:

| Fault | Expected behavior |
| --- | --- |
| Guidance attempt 1 fails, attempt 2 succeeds | Same role/lane twice; category continues; amber retry status. |
| Guidance attempts 1 and 2 fail | No host call for category; Progressive continues; Unified leaves original. |
| Host attempt 1 fails, attempt 2 succeeds | One guidance packet; identical packet hash on both host calls; amber retry status. |
| Host attempts 1 and 2 fail | Progressive continues from last valid draft; Unified leaves original. |
| Progressive category 1 fails, category 2 succeeds | Category 2 source hash equals original/last valid hash; partial final swipe. |
| Progressive category 1 succeeds, category 2 fails | Final candidate hash equals category 1 output hash; partial final swipe. |
| Requested Replace with partial result | Swipe count increases by one; requested/committed modes differ in marker. |
| Stop during guidance | Abort observed; no host call; no final mutation. |
| Stop during host rewrite | Host signal aborted; prompt cleared; no final mutation. |
| Source swipe/edit/chat changes | Stale result rejected; no final mutation. |

## Report Contracts

### UI/visual report

```js
{
  schema: "recursion.postProcessUiProof.v1",
  status: "pass",
  installedCopy: {
    status: "match",
    commitSha: "…"
  },
  viewports: ["desktop", "compact"],
  cases: [
    {
      key: "desktop-card-editor",
      interaction: "pass",
      accessibility: "pass",
      layout: "pass",
      visual: "match",
      baselinePath: "tests/visual-baselines/post-process-cards/desktop/card-editor.png",
      sha256: "…"
    }
  ],
  failures: []
}
```

### Live generation report

```js
{
  schema: "recursion.postProcessLiveProof.v1",
  status: "pass",
  privacy: {
    screenshots: false,
    traces: false,
    rawTextFields: 0
  },
  cases: [
    {
      key: "progressive-medium-swipe",
      lane: "utility",
      flow: "progressive",
      categoryCount: 2,
      guidanceCalls: 2,
      hostCalls: 2,
      hostGenerationType: "quiet",
      quietToLoud: true,
      promptMarkerPresent: true,
      intermediateMutationCount: 0,
      finalMutation: "as-swipe",
      markerBound: true,
      partial: false
    }
  ],
  failures: []
}
```

No report field may contain source/candidate prose, card prompt text, guidance text, full outbound request text, transcript excerpts, hidden reasoning, secrets, cookies, or absolute user-data paths.

## Artifact Layout

No-generation UI proof:

```text
artifacts/post-process-ui/<run-id>/
├─ report.json
├─ summary.md
├─ desktop/
│  └─ reviewed screenshots
└─ compact/
   └─ reviewed screenshots
```

Generation-enabled proof:

```text
artifacts/post-process-live/<run-id>/
├─ report.json
└─ summary.md
```

The live directory must contain no binary browser artifacts.

## Failure Classification

| Status | Meaning |
| --- | --- |
| `environment-fail` | Browser, host, authentication, provider, or filesystem setup failed. |
| `unsafe-user` | Dedicated-user safety gate failed. |
| `stale-extension` | Repository, installed, and served bytes do not match. |
| `ui-fail` | Visible interaction, accessibility, layout, or visual contract failed. |
| `runtime-fail` | Routing, retry, sequencing, host ownership, or mutation contract failed. |
| `privacy-fail` | Raw text/secret or forbidden binary artifact was captured. |
| `manual-required` | A required host/user setup step cannot be automated safely. |

Do not convert a runtime or privacy failure into a warning.

## Completion Gate

Post-process Cards are not integration-complete until:

- all deterministic tests pass;
- all 14 reviewed visual baselines match;
- independent deck state survives reload;
- keyboard/mobile interaction passes;
- Low/Medium Utility routing passes;
- High/Ultra Reasoner routing passes;
- no cross-lane fallback is observed;
- same-lane retry/fail-soft cases pass;
- `context.generate:quiet` writer ownership is proven;
- the outbound host request contains the Post-process packet marker;
- Progressive latest-draft chaining is proven by hashes;
- no intermediate chat mutation is observed;
- final swipe/replace marker binding is proven;
- installed and served bytes match the tested commit;
- the generation-enabled artifact directory contains no screenshots, traces, or raw text.
