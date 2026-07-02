# Recursion UI Spec

## UI Goals

Recursion should feel mostly invisible during normal play. The interface exists to answer three questions quickly:

- Is Recursion active?
- What did it use for the last response?
- What high-level behavior can I adjust without managing cards by hand?

The UI should look native to SillyTavern first. Recursion can have a modern graphite-dark technical personality, but it should feel like an extension panel that belongs inside the active SillyTavern theme, not a separate web app embedded in the page.

Recursion should inherit SillyTavern typography, spacing expectations, menu behavior, border treatment, input styling, and theme variables wherever practical. Custom styling should be restrained and limited to the Recursion Bar, Hero Pixel Array, disclosed menus, metachips, card-state accents, and viewer organization.

Recursion should avoid low-level card micromanagement in V1. Users can inspect what happened and adjust broad behavior, but the Arbiter owns card selection, refresh, stow, discard, and regeneration.

Related docs:

- [Product Scope](RECURSION_PRODUCT_SCOPE.md)
- [Card System Spec](CARD_SYSTEM_SPEC.md)
- [Behavior Settings Policy Spec](BEHAVIOR_SETTINGS_POLICY_SPEC.md)
- [Runtime Architecture](../architecture/RUNTIME_ARCHITECTURE.md)
- [Prompt Composition Spec](../architecture/PROMPT_COMPOSITION_SPEC.md)
- [Provider and Generation Spec](../architecture/PROVIDER_AND_GENERATION_SPEC.md)
- [Storage and Diagnostics](../architecture/STORAGE_AND_DIAGNOSTICS.md)

## Recursion Bar

Recursion should use its own chat-attached top bar instead of adopting the Directive/Saga shelf pattern. It may learn from the placement of Chat Top Bar, but it should not depend on TopInfoBar as a component.

Default desktop shape:

```text
[power] [mode icon] [cards] | [Hero Pixel Array] Selecting turn hand...     [reasoning] v | ...
```

Narrow/mobile shape:

```text
[power] [mode] [cards] | [Hero Pixel Array] Selecting...      v | ...
```

The desktop bar uses one compact row with distinct zones for power, mode, progress, reasoning level, last-brief preview, and options. It should feel like a thin SillyTavern-native top bar, not a detached plugin dashboard.

The exact copyable HTML/CSS snapshot for this V1 bar lives in `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md`. Treat that file as the implementation reference for reproducing the current mock in SillyTavern: it captures the final class names, inline SVG icons, Hero Pixel Array, progress menu, mode menu, Last Brief dropdown, Prompt Packet panel, metachips, and 12px active progress spinner treatment.

Recursion chrome should use explicit compact font sizing instead of inheriting SillyTavern chat/body text size. Use 12.5px as the default bar, menu, settings, and control font scale, 11.5px for compact current-step and mode-choice names, and 10px for subdued helper/meta text. This keeps the live SillyTavern extension visually aligned with the mockup even when the host theme uses larger global typography.

Canonical desktop layout:

```text
[power] [mode arrows] [cards] | [blocks] Selecting turn hand...  [reasoning] v | ...
[power] [mode arrows] [cards] | [blocks] Installing prompt...    [reasoning] v | ...
[power] [mode arrows] [cards] | [blocks] Manual scope active...  [reasoning] Cards v | ...
[power-off] [mode arrows] [cards] |                              [reasoning] v | ...
```

The first control is a dedicated icon-only power toggle. It uses the same power icon shape as the mode menu previously used and is the only control that enables or disables Recursion. It must expose matching accessible label and hover tooltip copy (`Turn Recursion off` / `Turn Recursion on`). When disabled, Recursion clears or avoids installed prompt entries and does not inspect chat for prompt compilation.

The mode control is a single icon-only button beside the power toggle with no separator between Power and Mode. It uses a matching three-arrow icon pair so Auto and Manual feel equally capable but differently directed:

- Divergent three-arrow fan: `Auto`. One origin splits into three directions, meaning Recursion may choose the best route from the current scene.
- Parallel three-arrow stack: `Manual`. The same three arrows move in one direction, meaning Recursion keeps full force but follows selected constraints.

Do not duplicate the mode controls on the right side of the bar. The mode icon should expose tooltip and accessible label text for the current mode and can open a compact mode selector.

Clicking the mode icon opens a compact mode selector menu. The selected mode changes the icon in the compact bar immediately after selection.

Mode selector rows:

- Divergent arrows icon, `Auto`: Recursion selects cards, composes the prompt packet, and injects it automatically when ready.
- Parallel arrows icon, `Manual`: Recursion uses the selected card scope as a strict whitelist when planning, selecting, composing, and injecting context.

Each mode row should show the icon, short name, and a hover/focus tip with the longer explanation. The menu should use native SillyTavern popup density and close on selection, outside click, or `Esc`.

Reference mode selector shape:

```html
<button class="recursion-power-toggle is-on"
        aria-label="Turn Recursion off"
        aria-pressed="true">
  <!-- power icon -->
</button>

<button class="recursion-mode-button" aria-label="Mode: Auto" aria-expanded="false">
  <!-- current mode icon -->
</button>

<div class="recursion-mode-menu" aria-label="Recursion mode selector">
  <button class="recursion-mode-choice is-selected"
          data-mode="auto"
          title="Selects cards and injects composed prompt context automatically.">
    <span class="recursion-mode-choice-icon"><!-- divergent three-arrow fan --></span>
    <span>
      <span class="recursion-mode-choice-name">Auto</span>
      <span class="recursion-mode-choice-tip">Selects cards and injects composed prompt context automatically.</span>
    </span>
  </button>
  <button class="recursion-mode-choice"
          data-mode="manual"
          title="Uses only selected card scope.">...</button>
</div>
```

Card scope is not a mode. The compact left-side stacked-cards icon opens a full-bar-width dropdown with the fixed V1 card families and their sub-item focus toggles. The compact bar control stays icon-only; the dropdown header summarizes whether all focus items are enabled or a partial count is active. Auto treats this scope as preference/focus, while Manual treats it as a strict whitelist. Category and sub-item clicks must visibly update the open dropdown in place without closing it or waiting for a host rerender. The UI must prevent disabling the final selected sub-item and show `Keep at least one card focus enabled.` when that guard is hit.

Cards Selection button owns the stacked-cards icon. The mode button and mode menu must not reuse the cards icon, because cards now means scope selection rather than automation mode.

Reference mode selector CSS:

```css
.recursion-mode-cluster {
  position: relative;
}

.recursion-mode-menu {
  position: absolute;
  top: 28px;
  left: 6px;
  width: 222px;
  z-index: 85;
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 0 0 8px 8px;
  background: var(--SmartThemeBlurTintColor);
  box-shadow: 0 18px 38px rgba(0, 0, 0, .40);
}

.recursion-mode-choice {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 8px;
  width: 100%;
  min-height: 36px;
  padding: 7px 9px;
  border: 0;
  border-top: 1px solid rgba(255, 255, 255, .055);
  background: transparent;
  color: inherit;
  text-align: left;
}
```

The card scope selector is an icon-only stacked-cards button in the left bar flow. It sits immediately to the right of Mode and to the left of the Hero Pixel Array separator. Its accessible label and tooltip carry the meaning; it must not render a visible `Cards` title or selected-count text in the compact bar.

The Hero Pixel Array sits to the right of the card scope selector separator and immediately before the compact current-step text. It shows runtime state at a glance and mirrors the visible top-level rows in the progress menu:

- Empty muted blocks: queued or not-yet-started progress items.
- Green filled blocks: completed progress items.
- Blue animated blocks: currently running model calls, prompt work, or cache writes.
- Purple filled blocks: cards or deck rows read from cache instead of generated this turn.
- Yellow filled blocks: finished with errors, fallback, JSON repair, or other repairable caution.
- Red filled blocks: blocked or failed progress items.

Blocks build down from the top of a three-row column, then start the next column to the right. The array sits after the Cards separator and before the compact current-step text. On the next user message, old blocks wipe away before the next run starts building.

The Hero Pixel Array must respect reduced-motion preferences. It may pulse active blocks while work is running, but it must not animate when `prefers-reduced-motion: reduce` is active.

The bar may show exactly one live generation status: the current in-progress step, rendered as short muted text to the right of the Hero Pixel Array. The full step list belongs in the Hero Pixel Array menu. The bar may expose last-brief details through tooltip/accessibility text on the preview arrow, but it should not become a row of status chips.

Pending or waiting progress rows must not appear as the compact current-step text. They remain visible in the progress menu as empty/waiting rows while the bar stays quiet until work is actually running, warning, or failed.

The right tool cluster contains:

- Reasoning level chain: four node boxes from Low through Ultra, with illuminated chain fill up to the selected level. Use muted SillyTavern foreground grey-white for the nodes and connecting line; do not use Recursion cyan for this control.
- Dropdown arrow: opens the last-brief preview.
- Ellipsis: opens the options menu.

The ellipsis must not open the card preview. The dropdown arrow must not open the options menu.

The bar should sit near the chat surface, preferably above the transcript or below the chat header. It should be thin, stable, and not draggable. It should not resize the transcript repeatedly during status changes.

When SillyTavern has multiple chat top bars, Recursion should mount as the lowest bar in that stack when the host DOM makes that placement reliable. If exact stack placement cannot be guaranteed, the adapter should fall back to the closest stable chat-surface mount point above the transcript. Recursion must not depend on Chat Top Bar or TopInfoBar internals.

The bar should visually align with nearby SillyTavern chrome. Its height, border radius, hover states, dropdown shadows, and icon/button sizing should resemble native SillyTavern controls rather than a detached toolbar or separate plugin navbar.

Color grammar:

- The power and mode controls use muted SillyTavern foreground text, not bright brand color.
- Reasoning level controls use muted SillyTavern foreground grey-white, so they read as chrome rather than runtime state.
- The Hero Pixel Array owns compact state color.
- The bar itself should remain mostly neutral; amber/red should appear only in the array or disclosed menus for attention or blocking conditions.
- `Working` uses cyan motion treatment.
- `Issue`, provider failures, and prompt-install failures use red only when blocked or failed.
- Review, fallback, stale, and warning states use amber.
- Disabled-but-normal states use muted neutral treatment on the power toggle.

## Hero Pixel Array Progress Menu

The Hero Pixel Array is both a compact block-based state indicator and the entry point for live generation progress. Clicking it opens a popover that behaves like Codex-style task progress: a compact progress list where each row moves independently from waiting to running to a final outcome.

The progress menu header keeps the title and subtitle in the same left-flow group with the reference 8px gap. The subtitle must not be pinned to the right edge; right alignment is reserved for row metadata and footer chips.

The Hero Pixel Array and progress menu must render from the same normalized `progressRun.steps[]` view model. Do not maintain separate array state and menu state. Each visible top-level generation/progress row gets exactly one Hero Pixel Array block. If a UI control interaction creates only successful prompt cleanup/install rows, discard those rows from the progress menu and render no Hero Pixel Array blocks; clicking power, mode, reasoning level, settings tabs, Last Brief, or options must not populate generation progress. Keep control-side prompt warning or failed rows visible so the user can see a cleanup issue, but still do not create compact pixels for them. If provider subcalls are nested under a grouped row, they do not get separate Hero Pixel Array blocks unless they are also visible as top-level rows.

The progress menu footer summarizes the visible provider lanes represented by the progress rows. If any visible top-level row or child row uses Reasoner and any row uses Utility, footer copy is `Auto - Utility and Reasoner lanes`; it must not collapse to the last prompt composer lane.

When runtime activity is `idle`, or when an explicit progress title is `Ready`/`Idle`, a `progressRun` that contains only pending/waiting rows is stale planned work and must be discarded before rendering. Keep completed, cached, warning, or failed rows visible, but never show a `Ready` progress menu with a leftover pending-only task such as `Clearing Recursion prompt`.

When a turn reaches a terminal prompt outcome (`Recursion prompt ready`, prompt install done/failed, or prompt clear done/failed), the progress menu must stop adding pending plan rows for future steps that never ran. Material rows such as generated cards, cached cards, warnings, failures, and completed setup steps stay visible; unrun rows like `Composing prompt packet waiting` or `Clearing Recursion prompt waiting` must not remain as empty Hero Pixel blocks after the final outcome.

`progressRun.steps[]` shape:

```js
{
  runId: "run-preview-42",
  title: "Generating",
  subtitle: "2 model calls running",
  steps: [
    { id: "read-turn", label: "Reading current turn", providerLane: "utility", state: "done" },
    {
      id: "utility-card-batch",
      label: "Utility card batch",
      providerLane: "utility",
      state: "warning",
      children: [
        { id: "scene-frame-card", label: "Scene Frame", providerLane: "utility", state: "running", meta: "running", sourceRoleId: "sceneFrameCard" },
        { id: "continuity-risk-card", label: "Continuity Risk", providerLane: "utility", state: "cached", meta: "cached", source: "cache", sourceRoleId: "continuityRiskCard" },
        { id: "knowledge-secrets-card", label: "Knowledge/Secrets", providerLane: "utility", state: "done", meta: "generated", source: "generated", sourceRoleId: "knowledgeSecretsCard" },
        { id: "clocks-consequences-card", label: "Clocks/Consequences", providerLane: "utility", state: "running", meta: "running", sourceRoleId: "clocksConsequencesCard" },
        { id: "character-motivation-card", label: "Character Motivation", providerLane: "utility", state: "done", meta: "generated", source: "generated", sourceRoleId: "characterMotivationCard" },
        { id: "environment-affordances-card", label: "Environment/Affordances", providerLane: "utility", state: "done", meta: "generated", source: "generated", sourceRoleId: "environmentAffordancesCard" },
        { id: "possessions-items-card", label: "Possessions/Items", providerLane: "utility", state: "pending", meta: "waiting", sourceRoleId: "possessionsItemsCard" },
        { id: "open-threads-card", label: "Open Threads", providerLane: "utility", state: "warning", meta: "fallback", source: "fallback", sourceRoleId: "openThreadsCard" }
      ]
    },
    { id: "reasoner-brief", label: "Reasoner brief", providerLane: "reasoner", state: "running" },
    { id: "composing-prompt-packet", label: "Composing prompt packet", providerLane: "utility", state: "pending" }
  ],
  settings: {
    ui: {
      progressChildVisibleLimit: 5,
      progressListVisibleLimit: 15
    }
  }
}
```

Nested child rows are the intended shape for grouped work. `Utility card batch` should show one child row for each generated card, cache-reused card, or local fallback card involved in the batch. `Reasoner brief` may show child rows for `Reasoner synthesis`, validation, and `Utility fallback` when those sub-steps matter. Keep `Composing prompt packet`, prompt install, and storage rows flat unless they later contain real sub-model calls.

Nested child rows are persistent once they appear during a run. They should not auto-collapse while the progress menu is open. The user setting `ui.progressChildVisibleLimit` controls how many child rows are visible inside a single parent group before that child group becomes scrollable; default `progressChildVisibleLimit: 5`, allowed range 1-20. Child group scrollbars stay hidden. When more child rows exist below the visible area, show a subtle bottom fade over the child group; when the user scrolls to the final child row, remove the bottom fade.

The user setting `ui.progressListVisibleLimit` controls how many combined progress items are visible before the whole progress list becomes scrollable; default `progressListVisibleLimit: 15`, allowed range 5-80. Count top-level rows and visible child rows together, using each capped child group as part of the same progress surface. This keeps the menu compact when a turn has many top-level rows and many card subcalls.

Parent row aggregation:

- Any failed child makes the parent failed/red.
- Otherwise any warning child makes the parent warning/amber.
- Otherwise any running child makes the parent running/blue.
- Otherwise any pending child keeps the parent pending.
- Otherwise all cached children make the parent cached/purple.
- Otherwise mixed generated and cached successes make the parent done/green.

The Hero Pixel Array continues to allocate blocks only for top-level rows. A grouped parent's block uses the aggregated parent state; child rows never create additional Hero Pixel Array blocks unless they are intentionally promoted into top-level rows.

Runtime card child rows come from sanitized `cardProgress` activity events. Event detail may include only `parentStepId`, `roleId`, `family`, `source`, `state`, and a safe card id. It must not include card prompt text, raw provider output, transcript text, stack traces, hidden reasoning, or secrets.

On each new `runId`, the Hero Pixel Array clears the previous turn's blocks, creates empty blocks for the known visible rows, and fills each block as its paired row settles. If Utility Arbiter reveals additional planned work, append new empty blocks with the same short entry animation used for initial blocks.

When the user sends the next message, the renderer should briefly enter a reset state before the next run starts:

- Reverse-stagger the old `.hero-block` elements out.
- Remove old blocks after the wipe completes.
- Start the next run from an empty Hero Pixel Array while the power and mode controls remain fixed.

The array layout is deterministic:

- `createHeroPixelBlocks(progressRun)` returns one block per normalized progress row.
- Blocks build top-to-bottom through three rows, then begin the next column to the right.
- Each block carries `row`, `column`, `columnCount`, `delayMs`, `state`, and a stable state class.
- The compact Hero Pixel Array caps at 12 columns, for 36 represented blocks at three rows.
- If a run has more than 36 top-level progress rows, the progress menu still shows every row, but the Hero Pixel Array uses its final block as an overflow aggregate. The aggregate state is selected from represented overflow rows in this priority order: running, failed, warning, pending, cached, done, skipped.
- The renderer sets `--columns` from `columnCount`, `grid-row` from `row + 1`, `grid-column` from `column + 1`, and `--block-index` from the block index.
- Entry delay is slight, roughly 24ms per block, so a 12-step run visibly builds without feeling slow.
- The Hero Pixel Array sits to the right of the Cards separator and to the left of the current-step status text.
- The current-step status text shifts smoothly with the array width, keeping a small gap from the growing columns.
- The compact current-step text uses action wording only, such as `Installing Recursion prompt...`; it must not append row meta like `waiting`, `done`, `generated`, or `cached`.
- The renderer sets `--columns` and `--block-count` on the activity trigger so the pixel grid and status spacing derive from the same run state.

The list is not always sequential. Several model calls may launch at once or start a few moments apart, so multiple rows can be active at the same time.

The reference preview includes a deterministic full-turn animation script so the interaction can be visually reviewed before wiring live runtime events. It must animate from the same state model the product uses: reset the previous turn, add newly visible rows with `.step-row.is-entering`, update settled rows with `.step-row.is-updating`, and fill the paired Hero Pixel Array blocks from the same `step.state`. During a run, the renderer must key rows and blocks by stable step id and update them in place; it must not replace the entire progress list or pixel array on each state tick, because that restarts entry animations and reads as flicker. The script is a visual mock only; the production renderer should replace the deterministic timeline with live `progressRun.steps[]` updates.

Default behavior:

- Clicking the Hero Pixel Array opens the status menu.
- Clicking the Hero Pixel Array again closes the status menu.
- Clicking outside the status menu closes it.
- Hovering or focusing the array may show a subtle affordance, but must not open the menu.
- The Hero Pixel Array remains full size and visually unboxed. It may be implemented as a button for accessibility, but it must not draw a square button background, border, or box on hover.
- The status menu aligns to the left edge of the Recursion Bar, not to the left edge of the array or mode cluster.
- The status menu must render above the Last Brief dropdown. The Recursion Bar creates the higher stacking context, the status popover sits above it, and the Last Brief dropdown remains lower.
- Active Hero Pixel Array blocks animate only while an active model call, prompt composition, prompt installation, or cache write is running.
- The menu updates rows in place as steps succeed.
- The menu closes when work settles unless pinned, or when the user dismisses it.
- Warnings and errors remain visible until resolved, superseded, or opened in the viewer.
- The menu must use `aria-expanded`, keyboard focus, and polite status updates.

Default progress menu:

```text
Generating                         2 model calls running

[done] Reading current turn         done
[done] Checking scene shift         done
[warn] Utility card batch           caution
       [run]  Scene Frame           running
       [cache] Continuity Risk      cached
       [done]  Motivation           generated
       [warn]  Open Threads         fallback
[run]  Reasoner brief               running
[wait] Composing prompt packet      waiting
[wait] Installing Recursion prompt  waiting
[wait] Saving scene cache           queued

Auto - Utility and Reasoner lanes        Live
```

Recommended V1 step labels:

- `Reading current turn`
- `Checking scene shift`
- `Planning card pass`
- `Reusing scene deck`
- `Generating scene cards`
- `Utility card batch`
- `Reasoner brief`
- `Validating cards`
- `Repairing card JSON`
- `Updating scene deck`
- `Selecting turn hand`
- `Composing prompt packet`
- `Installing Recursion prompt`
- `Saving scene cache`
- `Recursion prompt ready`

Step states:

- Queued/pending: empty circle.
- Running/active: animated ring using the same state-ring visual language, scaled slightly larger than the small progress dots so the hollow spinner has comparable visual weight.
- Done: green filled circle.
- Cached: purple filled circle for cards or deck rows read from cache instead of generated this turn.
- Finished with errors/repairable caution: amber filled circle.
- Failed/blocked: red filled circle.
- Provider lane marker: `U` for Utility or `R` for Reasoner appears first, then a subtle separator bar, then the status indicator.

Do not turn a row green until that specific row has completed successfully. Do not turn a row yellow or red until there is an actual issue. Active model-call rows stay cyan animated rings while they are still running.

Hero Pixel Array block states:

- Pending: empty muted block.
- Running: animated blue block.
- Done: filled green block.
- Cached: filled purple block.
- Finished with errors: filled yellow block.
- Failed: filled red block.

The Hero Pixel Array should use real block elements rather than a single canvas, SVG, or conic-gradient spinner so each progress row can be represented independently. Use CSS grid with three fixed rows, 4px blocks, 2px gaps, and generated block metadata from `createHeroPixelBlocks(progressRun)`.

Every active progress-row ring must continue to use the same small spinner visual contract: same conic-gradient stops, same dark cutout treatment, same pseudo-element box sizing, same animation name, and same duration. Inside the progress menu, static done/cached/pending/warning/failed dots use a 10px footprint, while active hollow spinner rings use a 12px footprint centered in the same indicator column. Implement this with shared CSS variables instead of separately hand-tuning spinner styles.

The inner cutout must not be transparent. It should use the same dark cutout fill and subtle inner border for every active row ring; otherwise active progress rows read as colored dots instead of rings.

The active work also appears inline in the bar as the current status, immediately after the Hero Pixel Array. Use concise phrases such as `Reading current turn...`, `2 model calls running...`, `Composing prompt packet...`, `Installing prompt...`, and `Saving cache...`. When idle, the text can collapse to empty space or a quiet `Ready`.

The status menu should use friendly stage text, not internal event names. It must not show raw prompts, raw provider responses, stack traces, hidden reasoning, private story plans, or unbounded provider error text.

Reference DOM shape:

```html
<button class="recursion-power-toggle is-on"
        aria-label="Turn Recursion off"
        aria-pressed="true">
  <!-- power icon -->
</button>

<button class="recursion-mode-button" aria-label="Mode: Auto">...</button>

<button class="status-array-button"
        aria-label="Open Recursion generation status"
        aria-expanded="false"
        data-state="running"
        style="--columns: 3; --block-count: 7">
    <span class="hero-pixel-array"
          aria-hidden="true"
          data-state="running"
          data-run-id="run-preview-42">
      <span class="hero-block done" style="grid-row: 1; grid-column: 1; --block-index: 0"></span>
      <span class="hero-block done" style="grid-row: 2; grid-column: 1; --block-index: 1"></span>
      <span class="hero-block running" style="grid-row: 3; grid-column: 1; --block-index: 2"></span>
      <span class="hero-block running" style="grid-row: 1; grid-column: 2; --block-index: 3"></span>
      <span class="hero-block pending" style="grid-row: 2; grid-column: 2; --block-index: 4"></span>
      <span class="hero-block pending" style="grid-row: 3; grid-column: 2; --block-index: 5"></span>
      <span class="hero-block pending" style="grid-row: 1; grid-column: 3; --block-index: 6"></span>
    </span>
    <span class="recursion-current-step" role="status">2 model calls running...</span>
</button>

<section class="recursion-status-popover" aria-label="Generation status steps">
    <header class="recursion-status-head">
      <span class="recursion-status-title">Generating</span>
      <span class="recursion-status-subtitle">2 model calls running</span>
    </header>

    <div class="recursion-status-list">
      <div class="recursion-step is-done" data-provider="utility">
        <span class="recursion-provider-mark" aria-label="Utility provider">U</span>
        <span class="recursion-step-separator" aria-hidden="true"></span>
        <span class="recursion-step-icon"></span>
        <span class="recursion-step-label">Reading current turn</span>
        <span class="recursion-step-meta">done</span>
      </div>
      <div class="recursion-step is-active" data-provider="utility">
        <span class="recursion-provider-mark" aria-label="Utility provider">U</span>
        <span class="recursion-step-separator" aria-hidden="true"></span>
        <span class="recursion-step-icon"></span>
        <span class="recursion-step-label">Utility card batch</span>
        <span class="recursion-step-meta">running</span>
      </div>
      <div class="recursion-step is-active" data-provider="reasoner">
        <span class="recursion-provider-mark" aria-label="Reasoner provider">R</span>
        <span class="recursion-step-separator" aria-hidden="true"></span>
        <span class="recursion-step-icon"></span>
        <span class="recursion-step-label">Reasoner brief</span>
        <span class="recursion-step-meta">running</span>
      </div>
      <div class="recursion-step is-pending" data-provider="utility">
        <span class="recursion-provider-mark" aria-label="Utility provider">U</span>
        <span class="recursion-step-separator" aria-hidden="true"></span>
        <span class="recursion-step-icon"></span>
        <span class="recursion-step-label">Composing prompt packet</span>
        <span class="recursion-step-meta">waiting</span>
      </div>
      <div class="recursion-step is-warning" data-provider="utility">
        <span class="recursion-provider-mark" aria-label="Utility provider">U</span>
        <span class="recursion-step-separator" aria-hidden="true"></span>
        <span class="recursion-step-icon"></span>
        <span class="recursion-step-label">Repairing card JSON</span>
        <span class="recursion-step-meta">caution</span>
      </div>
      <div class="recursion-step is-failed" data-provider="reasoner">
        <span class="recursion-provider-mark" aria-label="Reasoner provider">R</span>
        <span class="recursion-step-separator" aria-hidden="true"></span>
        <span class="recursion-step-icon"></span>
        <span class="recursion-step-label">Provider retry exhausted</span>
        <span class="recursion-step-meta">failed</span>
      </div>
    </div>

    <footer class="recursion-status-foot">
      <span>Auto - Utility and Reasoner lanes</span>
      <span class="recursion-mini-chip">Live</span>
    </footer>
</section>
```

Reference CSS contract:

```css
.recursion-bar {
  position: relative;
  z-index: 70;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 2px;
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 10px 10px 0 0;
  background: var(--SmartThemeBlurTintColor);
  backdrop-filter: blur(var(--SmartThemeBlurStrength));
}

.recursion-power-toggle {
  width: 24px;
  min-width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: color-mix(in srgb, var(--SmartThemeBodyColor) 86%, transparent);
  display: inline-grid;
  place-items: center;
}

.status-array-button {
  width: auto;
  min-width: var(--hero-block-size, 4px);
  height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  display: inline-grid;
  place-items: center;
}

.status-array-button:hover,
.status-array-button:focus-visible {
  background: transparent;
  box-shadow: none;
}

.hero-pixel-array {
  position: static;
  z-index: 3;
  width: calc((var(--columns, 1) * var(--hero-block-size, 4px)) + ((var(--columns, 1) - 1) * var(--hero-block-gap, 2px)));
  height: calc((3 * var(--hero-block-size, 4px)) + (2 * var(--hero-block-gap, 2px)));
  display: grid;
  grid-template-rows: repeat(3, var(--hero-block-size, 4px));
  grid-auto-columns: var(--hero-block-size, 4px);
  gap: var(--hero-block-gap, 2px);
  align-content: start;
  justify-content: start;
  filter: drop-shadow(0 0 5px rgba(101, 216, 232, .12));
  transition: width .16s ease;
}

.hero-block {
  width: var(--hero-block-size, 4px);
  height: var(--hero-block-size, 4px);
  border: 1px solid rgba(224, 224, 224, .28);
  border-radius: 1px;
  background: transparent;
  opacity: 0;
  transform: scale(.62);
  animation: hero-block-enter .18s ease-out forwards;
  animation-delay: calc(var(--block-index, 0) * 24ms);
  transition: background .14s ease, border-color .14s ease, box-shadow .14s ease;
}

.hero-block.pending {
  border-color: rgba(224, 224, 224, .28);
  background: transparent;
}

.hero-block.done {
  border-color: #7bd88f;
  background: #7bd88f;
  box-shadow: 0 0 4px rgba(123, 216, 143, .22);
}

.hero-block.cached {
  border-color: #a78bfa;
  background: #a78bfa;
  box-shadow: 0 0 5px rgba(167, 139, 250, .24);
}

.hero-block.running {
  border-color: #65d6e8;
  background: #65d6e8;
  animation:
    hero-block-enter .18s ease-out forwards,
    hero-block-active 1.05s ease-in-out infinite;
  animation-delay: calc(var(--block-index, 0) * 24ms), 0ms;
  box-shadow: 0 0 6px rgba(101, 216, 232, .35);
}

.hero-block.warning {
  border-color: #e4bc63;
  background: #e4bc63;
  box-shadow: 0 0 5px rgba(228, 188, 99, .25);
}

.hero-block.failed {
  border-color: #e06767;
  background: #e06767;
  box-shadow: 0 0 5px rgba(224, 103, 103, .28);
}

.brand-block.is-resetting .hero-block {
  animation: hero-block-wipe .20s ease-in forwards;
  animation-delay: calc((var(--block-count, 0) - var(--block-index, 0)) * 16ms);
}

.recursion-step.is-active .recursion-step-icon {
  width: 12px;
  height: 12px;
  border: 0;
  border-radius: 999px;
  background: conic-gradient(
    from 20deg,
    var(--recursion-state-color) 0 82deg,
    color-mix(in srgb, var(--recursion-state-color) 18%, transparent) 82deg 210deg,
    rgba(224, 224, 224, .20) 210deg 360deg
  );
  position: relative;
  box-shadow: 0 0 8px color-mix(in srgb, var(--recursion-state-color) 16%, transparent);
}

.recursion-step.is-active .recursion-step-icon::after {
  content: "";
  position: absolute;
  inset: 2.5px;
  border-radius: inherit;
  background: var(--recursion-ring-cutout, #202124);
  border: 1px solid rgba(255, 255, 255, .04);
  box-sizing: content-box;
}

.recursion-step.is-active .recursion-step-icon {
  animation: spin 1.1s linear infinite;
}

.recursion-current-step {
  min-width: 0;
  flex: 1 1 auto;
  color: var(--SmartThemeBodyColor);
  opacity: .62;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recursion-status-popover {
  position: absolute;
  top: 34px;
  left: -3px;
  width: 352px;
  z-index: 80;
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 0 0 8px 8px;
  background: var(--SmartThemeBlurTintColor);
  box-shadow: 0 18px 38px rgba(0, 0, 0, .40);
  backdrop-filter: blur(var(--SmartThemeBlurStrength));
}

/* When nested under the brand cluster, offset by the bar border plus left
   padding so the visible panel starts at the bar's left edge. */

.recursion-step {
  display: grid;
  grid-template-columns: 14px 1px 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 5px 9px;
  border-top: 1px solid rgba(255, 255, 255, .045);
}

.recursion-step-separator {
  width: 1px;
  height: 16px;
  background: linear-gradient(180deg, transparent, rgba(224, 224, 224, .20), transparent);
}

.recursion-provider-mark {
  color: rgba(224, 224, 224, .42);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  text-align: center;
}

.recursion-step[data-provider="reasoner"] .recursion-provider-mark {
  color: rgba(201, 237, 243, .58);
}

.recursion-step[data-provider="utility"] .recursion-provider-mark {
  color: rgba(224, 224, 224, .50);
}

.recursion-step-icon {
  width: 10px;
  height: 10px;
  border: 1.4px solid rgba(224, 224, 224, .42);
  border-radius: 999px;
}

.recursion-step.is-done .recursion-step-icon {
  background: #7bd88f;
  border-color: #7bd88f;
}

.recursion-step.is-pending .recursion-step-icon {
  background: transparent;
  border-color: rgba(224, 224, 224, .38);
}

.recursion-step.is-warning .recursion-step-icon {
  background: #e4bc63;
  border-color: #e4bc63;
}

.recursion-step.is-failed .recursion-step-icon {
  background: #e06767;
  border-color: #e06767;
}

@keyframes hero-block-enter {
  from {
    opacity: 0;
    transform: scale(.62);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes hero-block-active {
  0%, 100% { opacity: .62; }
  50% { opacity: 1; }
}

@keyframes hero-block-wipe {
  to {
    opacity: 0;
    transform: translateX(-4px) scale(.45);
  }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .hero-block,
  .hero-block.running,
  .brand-block.is-resetting .hero-block,
  .recursion-step.is-active .recursion-step-icon {
    animation: none;
    opacity: 1;
    transform: none;
  }

  .hero-pixel-array {
    transition: none;
  }
}
```

## Activity Surface

The Hero Pixel Array Progress Menu is the V1 activity surface. Do not also ship a separate always-dropping Activity Ribbon for normal generation progress; it would duplicate the array menu and make the bar feel busy.

A larger activity view can exist inside the Full Viewer for diagnostics and history, but normal play should use the array menu:

- Hero Pixel Array: glanceable state and live step popover.
- Last Brief dropdown: compact cards used by the last prompt packet.
- Full Viewer Activity tab: bounded sanitized run history, fallback details, and provider issues.

The activity surface must not show raw prompts, raw provider responses, stack traces, unbounded provider error text, hidden reasoning, private story plans, or per-card debug spam.

## Options Menu

The ellipsis button opens the integrated settings/options menu, not the Last Brief dropdown. This keeps the right side of the compact bar simple: dropdown arrow means cards, ellipsis means configuration/options.

Provider setup lives in the Providers tab. Detailed activity and prompt inspection lives in the Last Brief Prompt Packet panel and Full Viewer surfaces. Low-frequency diagnostic commands may appear in Advanced, but commands without V1 runtime handlers must be disabled with clear tooltip copy rather than silently doing nothing.

## Last Brief Dropdown

The Last Brief dropdown is the lightweight trust surface. It opens from the dedicated dropdown-arrow button on the right side of the Recursion Bar. It does not open from the ellipsis options button.

The dropdown uses the full width of the Recursion Bar so card text has room to breathe. It should remain visually attached to the bar and use SillyTavern-native popup styling: dark surface, hairline border, subtle elevation, compact rows, and restrained hover/focus states.

Example:

```text
Last brief - 8 cards - click row to expand - priority color only

[warning]  Continuity Risk      doorway blocked, lamp broken...      critical | fresh | injected | scene
[target]   Motivation           Mara wants to keep control...         strong | Mara | turn brief
[people]   Relationship         accusation unresolved...              normal | tension | dialogue
[cube]     Environment          rain masks movement...                normal | items | local
[lines]    Prose Pacing         keep motion concrete...               light | style | compiler
```

Rows are read-only. Clicking or pressing `Enter` / `Space` expands a row in place to show the full card text. Clicking again collapses it. The dropdown should not become an editor.

If the last brief has more than roughly five compact rows, the list region becomes scrollable while the header and footer remain stable. The scroll area must use a restrained SillyTavern-like scrollbar and avoid covering the chat input.

The `Prompt Packet` control in the dropdown header is a button. It opens the actual final prompt packet that Recursion injected after Utility or Reasoner composed the selected cards into injection-safe prompt text. This view is for inspection and copy/debug trust, not editing.

Prompt Packet behavior:

- Disabled when no composed packet exists.
- Opens in the dropdown as a full-width inspection panel or opens the Full Viewer directly to the Prompt Packet section.
- Shows the final injected packet text, composer lane, source card count, omitted-card summary, and injection timestamp/message id when available.
- Does not show the packet JSON wrapper as the primary panel content; users should see the exact injected prompt text without expanding or reading implementation fields.
- Does not show raw provider responses, hidden reasoning, API keys, stack traces, or unrelated diagnostics.
- Includes a Copy action when a packet exists; Copy writes the injected prompt text, not the packet JSON wrapper.

Each row should show:

- Category icon and category label.
- Target, when applicable.
- One-line compact card text, clamped in collapsed state.
- Metachips.

Category icons replace generic card-stack icons in the list:

- Continuity risk: warning triangle.
- Motivation: target or focus reticle.
- Relationship: paired people or link icon.
- Environment / items: cube, box, or scene icon.
- Prose / pacing: text lines or rhythm icon.
- Scene objective: flag.
- Memory echo: history/clock arrow.
- Safety guard: shield.

Metachip rules:

- Category is never a chip; category is the icon plus row label.
- Priority is the only strong color. Use red for `critical`, amber for `strong`, and muted neutral for `normal`, `light`, and support levels.
- State/source chips such as `fresh`, `injected`, `memory`, `compiler`, `scene`, and `turn brief` stay subtle.
- Compact rows show at most three or four chips. If more metadata exists, collapse extras behind `+N`.
- Expanded rows may show more detail text, but metadata should still stay restrained; prefer a `+N` chip with hover/focus explanation over spilling every tag into the row.
- Avoid assigning every tag its own color. Random chip color sprawl is explicitly out of scope.

Hover/focus help should be useful but never required. Icon-only controls, progress rows, provider marks, status indicators, card family icons, compact card rows, metachips, provider source controls, Injection controls, and Diagnostics actions should expose short tooltip/accessibility copy that explains what the thing is, what clicking it does, or why it is in its current state. Card row hover copy may include family, safe summary, selected/omitted reason, source/cache state, and bounded evidence metadata. It must not show raw provider output, hidden reasoning, API keys, stack traces, or raw transcript text. Full card text remains click-to-expand, not hover-only.

Reference DOM shape:

```html
<section class="recursion-brief-menu" aria-label="Last brief cards">
  <header class="recursion-brief-head">
    <span class="recursion-brief-title">Last brief</span>
    <span class="recursion-brief-summary">8 cards · click row to expand · priority color only</span>
    <button class="recursion-prompt-packet-button" type="button">
      Prompt Packet
    </button>
  </header>

  <section class="recursion-prompt-packet-panel" hidden>
    <header class="recursion-prompt-packet-head">
      <span>Injected prompt packet</span>
      <button type="button">Copy</button>
    </header>
    <pre class="recursion-prompt-packet-text">...</pre>
  </section>

  <div class="recursion-brief-scroll">
    <button class="recursion-brief-card"
            data-priority="critical"
            aria-expanded="false">
      <span class="recursion-card-kind">
        <span class="recursion-cat-icon-wrap">
          <svg class="recursion-cat-icon" aria-hidden="true"></svg>
        </span>
        <span class="recursion-kind-label">Continuity risk</span>
        <span class="recursion-expand-glyph" aria-hidden="true"></span>
      </span>

      <span class="recursion-card-body">
        <span class="recursion-card-text">
          Doorway remains blocked, the lamp is broken, and movement through the corridor should stay constrained.
        </span>
        <span class="recursion-meta-row">
          <span class="recursion-chip recursion-chip-priority recursion-chip-critical">critical</span>
          <span class="recursion-chip recursion-chip-state">fresh</span>
          <span class="recursion-chip recursion-chip-state">injected</span>
          <span class="recursion-chip">scene</span>
        </span>
      </span>
    </button>
  </div>

  <footer class="recursion-brief-foot">
    <span>Generated after message 42 · no recovery warnings</span>
    <span class="recursion-mini-chip">Esc</span>
  </footer>
</section>
```

Reference CSS contract:

```css
.recursion-brief-menu {
  position: absolute;
  top: 36px;
  left: 0;
  right: 0;
  width: 100%;
  z-index: 30;
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 0 0 8px 8px;
  background: var(--SmartThemeBlurTintColor);
  box-shadow: 0 18px 38px rgba(0, 0, 0, .40);
  backdrop-filter: blur(var(--SmartThemeBlurStrength));
}

.recursion-brief-head,
.recursion-brief-foot {
  min-height: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-bottom: 1px solid rgba(255, 255, 255, .10);
}

.recursion-prompt-packet-button {
  margin-left: auto;
  border: 1px solid rgba(255, 255, 255, .095);
  border-radius: 5px;
  padding: 3px 7px 4px;
  color: rgba(224, 224, 224, .68);
  background: rgba(255, 255, 255, .035);
  font: inherit;
  font-size: 10.5px;
  line-height: 1;
}

.recursion-prompt-packet-panel {
  border-bottom: 1px solid rgba(255, 255, 255, .10);
  background: rgba(255, 255, 255, .025);
}

.recursion-prompt-packet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  color: rgba(224, 224, 224, .72);
  font-size: 11px;
}

.recursion-prompt-packet-text {
  max-height: 220px;
  overflow: auto;
  margin: 0;
  padding: 0 9px 9px;
  color: rgba(238, 238, 238, .76);
  white-space: pre-wrap;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
}

.recursion-brief-scroll {
  max-height: 286px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.recursion-brief-card {
  display: grid;
  grid-template-columns: 138px minmax(0, 1fr);
  gap: 10px;
  width: 100%;
  padding: 8px 10px 8px 9px;
  border: 0;
  border-top: 1px solid rgba(255, 255, 255, .055);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}

.recursion-brief-card:hover,
.recursion-brief-card:focus-visible {
  background: rgba(255, 255, 255, .035);
  outline: none;
}

.recursion-brief-card[aria-expanded="true"] {
  background: rgba(101, 216, 232, .055);
  box-shadow: inset 2px 0 0 rgba(101, 216, 232, .44);
}

.recursion-card-kind {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  min-width: 0;
}

.recursion-cat-icon {
  width: 15px;
  height: 15px;
  flex: 0 0 15px;
  color: rgba(224, 224, 224, .58);
}

.recursion-brief-card[data-priority="critical"] .recursion-cat-icon {
  color: rgba(224, 103, 103, .78);
}

.recursion-card-text {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: rgba(238, 238, 238, .78);
  font-size: 11.5px;
  line-height: 1.35;
}

.recursion-brief-card[aria-expanded="true"] .recursion-card-text {
  display: block;
  overflow: visible;
  -webkit-line-clamp: unset;
}

.recursion-meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 5px;
}

.recursion-chip {
  border: 1px solid rgba(255, 255, 255, .105);
  border-radius: 5px;
  padding: 2px 5px 3px;
  color: rgba(224, 224, 224, .58);
  background: rgba(255, 255, 255, .035);
  font-size: 10px;
  line-height: 1;
}

.recursion-chip-critical {
  color: #f0c0c0;
  border-color: rgba(224, 103, 103, .38);
  background: rgba(224, 103, 103, .08);
  font-weight: 600;
}

.recursion-chip-state {
  color: rgba(201, 237, 243, .68);
  border-color: rgba(101, 216, 232, .18);
  background: rgba(101, 216, 232, .045);
}
```

## Full Viewer

The full viewer is an observatory, not a primary play surface. It should open as a full-window panel or modal that can be dismissed quickly.

Recommended sections:

- Now: current Auto Control Plan, last run, active brief, prompt packet summary.
- Deck: scene deck, card states, emphasis, detail profile, provider, updated time.
- Activity: bounded run journal, Hero Pixel Array timeline, errors, refreshes, reasoner trigger reasons, fallback paths.
- Prompt Packet: final injected packet, omitted reasons, source card ids.
- Settings: high-level behavior settings.
- Providers: Utility and Reasoner provider controls.

Card detail view should include:

- Card type and target.
- State: active, stowed, discarded, regeneration requested, refreshed.
- Emphasis and detail profile.
- Why selected or why omitted.
- Source evidence refs or hashes.
- Injection-safe text.
- Inspector-only notes, clearly labeled and never injected.
- Lifecycle history.

## Settings

Settings should be few, powerful, and understandable.

The compact settings menu opens from the ellipsis/options path. It should align to the left edge of the Recursion Bar and span the full bar width, with its right edge aligned to the bar's right edge. Opening settings closes the Hero Pixel Array progress menu, Last Brief dropdown, and mode menu so the full-width settings surface never overlaps competing popovers. Opening progress closes settings for the same reason.

The menu uses three tabs:

- Play.
- Providers.
- Advanced.

Switching between settings tabs is internal panel navigation. A tab click must keep the settings menu open, even though the tab switch re-renders the floating panel content; outside-click closers must ignore that handled tab-switch event.

Play is the default tab. It contains one open `Behavior` disclosure for controls users are expected to tune during normal play:

- Strength: Light, Balanced, Strong.
- Focus: Balanced, Character, Continuity, Prose, Plot.
- Prompt Footprint: Compact, Normal, Rich.

The backend meaning of these three controls is defined by [Behavior Settings Policy Spec](BEHAVIOR_SETTINGS_POLICY_SPEC.md). In short: Strength controls intervention pressure, Focus controls soft family priority, and Prompt Footprint controls final packet size/detail. They should be visible as high-level controls, not exposed as per-card weights or prompt-fragment editors.

Mode and Reasoning Level belong to the compact bar controls and must not be duplicated in Settings. Reasoning Level is the user-facing provider-bias control. The compact bar uses the four-node chain visual:

- Low: Utility-only bias with reduced card pressure.
- Medium: Utility Arbiter and Utility cards, then Reasoner final brief composition.
- High: Reasoner Arbiter, Reasoner for high-priority card families, Utility for other card families, and Reasoner final brief composition.
- Ultra: Reasoner-heavy Arbiter, card generation, and final composition with larger card-set pressure.

`reasoningLevel` is persisted as `low | medium | high | ultra`, default `high`. It is the authoritative user-facing provider-bias setting. Runtime may still carry an internal `reasonerUse` route value, but that value is always derived from `reasoningLevel`: Low maps to `off`, Medium/High/Ultra map to `always`. If the Reasoner provider is unavailable while Medium, High, or Ultra is selected, the UI should keep the selected level and show fallback status rather than blocking the user.

Providers contains the complete provider setup surface in collapsible lane sections:

- Utility Provider, always enabled and open by default.
- Reasoner Provider, optional and collapsed by default unless it is configured.
- Source, profile, endpoint, model, session key, max tokens.
- Save Provider, Test Provider, Clear Session Key.
- Status, resolved provider, and resolved model.
- Temperature and top-p stay internal/defaulted in the compact V1 menu so the provider pane matches the mockup and does not become a dense admin form.

Provider Source changes the field context inside each lane immediately, matching the lean Directive/Saga pattern instead of showing every possible provider field at once:

- Current Host Model shows no connection-specific option boxes; it uses the active SillyTavern model context.
- Host Connection Profile shows Profile and hides OpenAI-compatible endpoint, model, and session key fields.
- OpenAI-Compatible Endpoint shows Base URL, Model, and Session Key and hides Profile.
- Max Tokens and provider actions remain visible for every Source.
- Switching Source is a UI-only context switch until Save Provider is clicked. Hidden field values are preserved so a user can compare sources without losing typed-but-unsaved settings.

Advanced contains low-frequency controls grouped into collapsible sections:

- Injection: placement, role, and depth controls for the composed prompt packet.
- UI: Tooltips, Sub-tier Rows, and Progress Rows. Turning Tooltips off removes Recursion tooltip and hover-help titles across the compact bar, popovers, card rows, settings, and diagnostics; normal buttons and click-open panels continue to work.
- Diagnostics: journal size, safe excerpts, Reset Scene Cache, Export Diagnostics, and Clear Run Journal.

Injection controls apply to the final conditioned prompt packet after Utility or Reasoner composition. They do not expose card-level placement, card editing, or per-turn prompt engineering. They exist for preset/model compatibility when a SillyTavern setup needs the composed Recursion brief to land in a different host lane or depth.

Advanced commands without V1 runtime handlers must render disabled with tooltip copy. They should not appear active until they perform the named action. V1 wires `Reset Scene Cache`, `Export Diagnostics`, and `Clear Run Journal`.

Checkboxes inside Recursion settings must use the compact dark Recursion control skin instead of SillyTavern's global checkbox background. The unchecked state is a dark 20px square with a subtle hairline border; the checked state fills with the Recursion cyan and shows a small checkmark.

Most internal Auto settings should not be exposed as controls. The UI can display Auto decisions for inspection, but users should not have to manage per-turn action, scene status, Reasoner decision rules, or individual card families.

## Provider Controls

Provider controls should follow the smaller Directive-style lane model:

- Utility Provider.
- Reasoner Provider.

Each provider card should support:

- Source: Current Host Model, Host Connection Profile, OpenAI-Compatible Endpoint.
- Connection profile selector when using host profiles.
- Base URL and model for OpenAI-compatible endpoints.
- Session API key field.
- Max tokens.
- Save Provider.
- Test Provider.
- Clear Session Key.
- Status and resolved model.

The compact Providers tab shows Utility details by default and keeps Reasoner as a collapsed optional lane until the user opens or configures it. Temperature and top-p remain normalized provider settings with safe defaults, but they are not visible controls in the compact top-bar menu.

Provider cards must not sprawl by rendering profile and OpenAI endpoint fields together. The selected Source owns the visible option context, while hidden alternate-source values remain available to Save Provider if the user switches back before saving.

API keys are session-only. They must not be written to extension settings, scene caches, prompt packets, run journals, diagnostics, reports, or artifacts.

## Visual System

The visual direction is SillyTavern-native graphite:

- Use SillyTavern theme variables for base background, text, borders, inputs, buttons, popups, and hover states wherever available.
- Let the active SillyTavern theme remain dominant; Recursion should adapt to the host theme instead of forcing a separate palette.
- Use dark neutral greys as a restrained Recursion accent layer when the current theme supports dark mode.
- Use hairline borders and subtle elevation that match SillyTavern popups and extension panels.
- Use compact rows and segmented controls that match SillyTavern control density.
- Teal/cyan for active system signals.
- Amber for attention.
- Green for ready/success.
- Red for provider failures or blocked states.

Recommended bar treatment:

- Bar height: 34-38 px.
- Button and chip height: 24-28 px.
- Border radius: 5-6 px.
- Font size: match SillyTavern toolbar text, usually 13-14 px.
- Background: same dark theme surface family as SillyTavern toolbar chrome, slightly separated from the transcript.
- Borders: 1 px low-opacity hairlines.
- Elevation: almost none; avoid floating-card shadows.
- Text: inherited theme foreground.
- Muted chips: 65-75 percent opacity.
- Accent: teal/cyan only on `Recursion`, a small active dot, or an active system state.

Avoid:

- A standalone SaaS/dashboard look.
- Neon-heavy cyberpunk styling.
- Purple/blue gradient dominance.
- Orange brand or status treatment that competes with SillyTavern dialogue text.
- Ornate fantasy treatment.
- Directive-sized operational density.
- Large decorative cards.
- Cards inside cards.
- Marketing/landing-page composition.

## Empty, Error, And Provider States

Empty states should be short and action-oriented.

Examples:

- No brief yet: `No brief has been composed for this chat.`
- Power off: `Recursion disabled. Prompt cleared.`
- Provider missing: `Utility provider is not ready.`
- Reasoner off: `Reasoner off. Utility will compose compact packets.`

Provider failures should fail soft. The UI should show the issue, preserve any usable cached scene state, and allow the main generation to continue without Recursion when needed.

Provider fallback states should appear in the Hero Pixel Array Progress Menu and the Full Viewer Activity tab. Hero Pixel Array block color may indicate attention, but the bar should not become a fallback-message strip. Examples:

- `Reasoner failed. Utility composed.`
- `Utility unavailable. Recursion skipped.`
- `Using cached hand.`
- `Provider test failed. Check session key.`

## Mobile Behavior

On narrow viewports:

- Keep the power toggle, mode icon, Hero Pixel Array, last-brief arrow, and ellipsis visible when possible.
- Collapse provider details, viewer entry points, and advanced commands into the ellipsis options menu.
- Use `[power] | [mode] | [array] v ...` as the default collapsed shape.
- Put mode selection, provider details, settings, last brief, and viewer links inside menus when there is not enough width.
- Prefer one-column viewer layouts.
- Keep buttons icon-first where meaning is familiar, with tooltips or accessible labels.
- Avoid wide tables in the full viewer.

The bar should not cover message input controls, generation controls, or SillyTavern native navigation.

## Accessibility

V1 should support:

- Keyboard-reachable menus and viewer close controls.
- ARIA labels for icon buttons.
- Visible focus states.
- Sufficient contrast for graphite-dark styling.
- Text that does not rely on color alone for state.
- Stable row heights where possible.

## V1 Cuts

Do not ship these in V1:

- Per-card editing.
- User accept/reject workflows for each card.
- Custom user-defined card types.
- Full visible card catalog management.
- Drag-and-drop card ordering.
- A timeline workbench.
- A large always-open dashboard.
- Deep role routing UI for every internal job.
- Popup-based progress spam for normal invisible work.

The first UI should build trust by showing what Recursion did, not by making users operate it manually.
