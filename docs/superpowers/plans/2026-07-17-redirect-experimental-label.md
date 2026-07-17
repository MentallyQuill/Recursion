# Redirect Experimental Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `Redirect Experimental` in the Enhancements selector with `Experimental` as subordinate helper text and expose `Redirect (Experimental)` accessibly.

**Architecture:** Extend the existing Enhancement option metadata with an optional qualifier and let the shared row renderer emit it only when present. Keep `redirect` as the stored mode and keep active-mode labels unchanged outside the selector.

**Tech Stack:** JavaScript DOM builders, CSS, Node-based UI tests, SillyTavern live extension.

## Global Constraints

- `Redirect` remains the primary 11.5px label.
- `Experimental` uses the 10px helper scale and muted foreground treatment.
- The Redirect choice exposes `Redirect (Experimental)` as its accessible name.
- The stored option value remains `redirect`.
- Other Enhancement choices render no qualifier.

---

### Task 1: Add Failing UI Contract Tests

**Files:**
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes: `createRecursionUi()` and the existing Enhancement selector DOM.
- Produces: regression assertions for qualifier text, isolation, and accessible naming.

- [x] **Step 1: Write the failing tests**

Add assertions that the Redirect choice contains a
`[data-recursion-enhancement-target-choice-qualifier]` element with text
`Experimental`, has `aria-label="Redirect (Experimental)"`, and that no other
choice contains a qualifier.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node tools/scripts/test-ui.mjs`

Expected: FAIL because the qualifier element and accessible label do not exist.

### Task 2: Implement the Label and Styling

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `docs/design/UI_SPEC.md`

**Interfaces:**
- Consumes: optional `qualifier` text on `ENHANCEMENT_TARGET_OPTIONS`.
- Produces: subordinate qualifier DOM and a complete accessible name.

- [x] **Step 1: Add option metadata and conditional rendering**

Set the Redirect option to:

```js
{
  value: 'redirect',
  label: 'Redirect',
  qualifier: 'Experimental'
}
```

Render the qualifier as a `small` element only when `option.qualifier` is
present, and set the button `aria-label` to `Redirect (Experimental)`.

- [x] **Step 2: Add the subordinate CSS treatment**

Style `.recursion-enhancements-choice-qualifier` at `10px`, normal weight,
muted foreground color, `0px` letter spacing, and a `4px` inline margin.

- [x] **Step 3: Document the visible contract**

Amend the Enhancements selector section of `docs/design/UI_SPEC.md` to state
that Redirect renders an inline muted `Experimental` qualifier while retaining
the `redirect` setting value.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `node tools/scripts/test-ui.mjs`

Expected: `[pass] ui`.

### Task 3: Verify and Deploy

**Files:**
- Stage for proof: `data/recursion-soak-a/extensions/Recursion`
- Deploy: `src/ui.mjs`
- Deploy: `styles/recursion.css`

**Interfaces:**
- Consumes: the tested repository files.
- Produces: a visually verified soak copy followed by matching served and
  `default-user` extension copies.

- [x] **Step 1: Run repository verification**

Run: `npm.cmd test`

Expected: all test scripts pass.

- [x] **Step 2: Stage the tested UI in the dedicated soak account**

Copy `src/ui.mjs` and `styles/recursion.css` to
`data/recursion-soak-a/extensions/Recursion`.

- [x] **Step 3: Visually inspect desktop and mobile**

Open the Enhancements selector in the live SillyTavern host and confirm the
qualifier is smaller, muted, inline, non-overlapping, and readable at desktop
and mobile widths.

- [ ] **Step 4: Commit the implementation**

Commit the source, CSS, docs, tests, and this plan with:

```text
feat(ui): mark Redirect experimental
```

- [ ] **Step 5: Deploy exact tested files**

Copy `src/ui.mjs` and `styles/recursion.css` to both the served Recursion
extension and `data/default-user/extensions/Recursion`, then compare SHA-256
hashes to the repository files.
