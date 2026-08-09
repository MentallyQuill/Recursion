# Provider Policy Tooltips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the three Connection Profile policy selects complete hover guidance while proving that Behavioral Preset stays explicit and both Auto policies resolve from runtime evidence.

**Architecture:** Keep the existing native `title` tooltip path and generation-policy resolver. Extend rendered UI behavior tests around the real select elements, extend resolver tests with the missing Auto branches, and then replace only the three tooltip constants.

**Tech Stack:** JavaScript ES modules, the repository's fake-DOM UI harness, Node.js assertion helpers, npm test runner.

## Global Constraints

- Target the existing `refactor` worktree and branch.
- Behavioral Preset must keep only `isolated` and `full-profile`; it must not gain Auto.
- Instruct Auto must derive from the Connection Manager completion mode on every request.
- Structured Output Auto must use Prompt JSON without native certification and Native Schema only with current native-schema certification.
- Do not add custom tooltip chrome, CSS, persistence fields, compatibility shims, or option-level hover behavior.
- Use the exact approved copy from `docs/superpowers/specs/2026-08-09-provider-policy-tooltips-design.md`.

---

### Task 1: Lock the provider-policy UI and Auto contracts

**Files:**
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `tools/scripts/test-profile-transport-v1.mjs`
- Modify: `src/ui.mjs`

**Interfaces:**
- Consumes: `renderProviderSettings(...)`, `setTooltip(...)`, and `resolveGenerationPolicy({ provider, completionMode, request })`.
- Produces: rendered provider selects whose `title` attributes contain the approved explanations; regression coverage for explicit preset options and evidence-backed Auto resolution.

- [ ] **Step 1: Add failing rendered-UI assertions**

After the existing assertions that the Reasoner provider exposes the three controls, bind the real select elements and assert literal option values and approved title text:

```js
const reasonerPresetMode = root.querySelector('[data-recursion-provider-preset-mode-reasoner]');
const reasonerInstructMode = root.querySelector('[data-recursion-provider-instruct-mode-reasoner]');
const reasonerStructuredOutputMode = root.querySelector('[data-recursion-provider-structured-output-mode-reasoner]');

assertDeepEqual(
  [...reasonerPresetMode.children].map((option) => option.value),
  ['isolated', 'full-profile'],
  'Behavioral Preset remains an explicit choice without Auto'
);
assertEqual(reasonerPresetMode.getAttribute('title'), "Controls whether Recursion includes the Connection Profile's complete generation preset in model calls. Isolated (recommended) excludes its behavioral prompts, style instructions, and wrappers, reducing interference with structured responses. Full Profile includes the entire preset; use it only when the preset is known to be compatible with Recursion's JSON-oriented requests.", 'Behavioral Preset tooltip explains the control and every option');
assertEqual(reasonerInstructMode.getAttribute('title'), "Controls whether SillyTavern applies the profile's instruct template. Auto (recommended) enables it for text-completion profiles and disables it for chat-completion profiles using the detected completion mode. On always applies the template. Off never applies it; use Off when the backend or preset already formats prompts and another template would duplicate the framing.", 'Instruct Formatting tooltip explains Auto, On, and Off');
assertEqual(reasonerStructuredOutputMode.getAttribute('title'), "Controls how Recursion requests machine-readable JSON. Auto (recommended) uses Prompt JSON before certification, then uses Native Schema only after the current profile passes native-schema certification. Native Schema always sends the schema and does not silently downgrade. Prompt JSON omits native-schema metadata and relies on explicit prompt instructions plus Recursion's parser and validation.", 'Structured Output tooltip explains certification-backed Auto and both forced modes');
```

- [ ] **Step 2: Add failing resolver assertions for the missing Auto branches**

Add literal expectations beside the existing `resolveGenerationPolicy(...)` coverage:

```js
assertEqual(resolveGenerationPolicy({
  provider: { generationPolicy: { instructMode: 'auto' } },
  completionMode: 'chat'
}).includeInstruct, false, 'Instruct Auto skips formatting for chat completion');

assertEqual(resolveGenerationPolicy({
  provider: {
    generationPolicy: { structuredOutputMode: 'auto' },
    certification: { structuredOutput: 'unknown' }
  }
}).structuredOutputMethod, 'prompt-json', 'Structured Output Auto is conservative before certification');

assertEqual(resolveGenerationPolicy({
  provider: {
    generationPolicy: { structuredOutputMode: 'auto' },
    certification: { structuredOutput: 'native-schema' }
  }
}).structuredOutputMethod, 'native-schema', 'Structured Output Auto uses certified native schema support');
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
node tools/scripts/test-ui.mjs
node tools/scripts/test-profile-transport-v1.mjs
```

Expected: `test-ui.mjs` fails because the current tooltip text is shorter than the approved copy. The resolver test may already pass because it characterizes existing runtime behavior; it must remain in the suite as explicit proof rather than prompting unnecessary production changes.

- [ ] **Step 4: Replace the three provider tooltip constants**

In `SETTINGS_TOOLTIPS` within `src/ui.mjs`, use exactly:

```js
providerPresetMode: "Controls whether Recursion includes the Connection Profile's complete generation preset in model calls. Isolated (recommended) excludes its behavioral prompts, style instructions, and wrappers, reducing interference with structured responses. Full Profile includes the entire preset; use it only when the preset is known to be compatible with Recursion's JSON-oriented requests.",
providerInstructMode: "Controls whether SillyTavern applies the profile's instruct template. Auto (recommended) enables it for text-completion profiles and disables it for chat-completion profiles using the detected completion mode. On always applies the template. Off never applies it; use Off when the backend or preset already formats prompts and another template would duplicate the framing.",
providerStructuredOutputMode: "Controls how Recursion requests machine-readable JSON. Auto (recommended) uses Prompt JSON before certification, then uses Native Schema only after the current profile passes native-schema certification. Native Schema always sends the schema and does not silently downgrade. Prompt JSON omits native-schema metadata and relies on explicit prompt instructions plus Recursion's parser and validation.",
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node tools/scripts/test-ui.mjs
node tools/scripts/test-profile-transport-v1.mjs
```

Expected: both scripts exit `0` with their pass messages.

- [ ] **Step 6: Run release verification**

Run:

```powershell
npm.cmd test
npm.cmd run test:alpha
git diff --check
```

Expected: all offline scripts pass, the alpha gate passes, and `git diff --check` emits no errors.

- [ ] **Step 7: Commit and push `refactor`**

```powershell
git add docs/superpowers/plans/2026-08-09-provider-policy-tooltips.md tools/scripts/test-ui.mjs tools/scripts/test-profile-transport-v1.mjs src/ui.mjs
git commit -m "feat(ui): explain provider policy options"
git push origin refactor
```
