# Documentation Render Tracking

This register is the source-controlled inventory for open documentation renders. Missing visuals stay visible in the target document as literal marker lines until the final asset is promoted.

## Marker Rules

Open render slots use one visible line with this exact prefix. The example below is prefixed so the register does not create another open slot; omit `MARKER: ` in target documents.

```markdown
MARKER: <Render Needed>: assets/documentation/renders/example.png - Concise description of the needed visual.
```

Rules:

- The marker must be visible in the document body, not hidden in comments.
- The marker line must begin with `<Render Needed>:` so inventory commands can find it.
- The target asset path must live under `assets/documentation/renders/`.
- The description must name the actual UI state, diagram, or evidence needed.
- Do not remove a marker until the asset exists, passes redaction review, and is linked from the document.
- When a marker is promoted, update this register in the same change.
- The example marker inside the fenced code block in `docs/planning/DOCUMENTATION_EXPANSION_PLAN.md` documents syntax only and is not an open render slot.

## Source Types

Use these source labels in the inventory:

- `live host`: captured from a real SillyTavern session with Recursion installed for a dedicated `recursion-soak-*` user.

Every inventory row must use that concrete label. If the source cannot be determined, clarify the target documentation before adding or keeping the marker. Explanatory diagrams belong directly in Markdown as Mermaid graphs or tables, not in this PNG asset inventory.

## Target Assets

Promoted render assets live in:

```text
assets/documentation/renders/
```

The directory is source-controlled and described in [Documentation Assets](../../assets/documentation/README.md). Temporary renderer output, browser profiles, draft screenshots, raw traces, and intermediate captures must stay out of git. Local renderer scratch output may use:

```text
.recursion-doc-renderer/
```

That path is ignored because it is tooling output. Promotion means copying only reviewed, redacted, final assets into `assets/documentation/renders/`.

## Current Pass Status

The 2026-07-10 render refresh promotes 32 live UI screenshot assets. Explanatory pipeline, storage, provider, redaction, testing, and behavior-policy diagrams now live directly in Markdown as Mermaid graphs or tables instead of promoted PNG assets. UI renders were captured through the local `.recursion-doc-renderer/` harness against the `recursion-soak-ui` SillyTavern render profile. Screenshots use the live-served Recursion UI module plus redaction-safe documentation fixture state, so final assets show the actual mounted UI without provider secrets, raw provider payloads, or private transcripts.

State-set renders such as bar states, progress states, Last Brief states, and fail-soft states are contact sheets composed from fresh live-mounted source captures. Their raw source tiles stay in `.recursion-doc-renderer/` and are not promoted separately.

The 2026-07-10 UI refresh found two post-alpha.1 bar changes that needed dedicated renders: the icon-only Enhancements menu with apply mode plus target rows, and the redesigned Tense & PoV two-axis selector. Both are now promoted live UI renders.

Future live screenshots should be promoted only when all of these are true:

- the dedicated `recursion-soak-*` render profile is sterile, with no non-Recursion third-party extensions installed;
- served Recursion extension files match the checkout under test;
- the target UI state exists in the real SillyTavern extension, not only in fixture or design reference code;
- the screenshot can be captured without raw provider payloads, secrets, private chat transcripts, or unrelated extension UI;
- the target document's `<Render Needed>` marker exactly names the state being captured, or the promoted image is directly linked from its target document.

## Promotion Workflow

1. Capture or generate the visual from the source type listed in the inventory.
2. Store raw captures under `artifacts/` or `.recursion-doc-renderer/`.
3. Redact and review the visual before promotion.
4. Promote the final PNG into `assets/documentation/renders/`.
5. Replace the target document marker with the final render reference.
6. Remove or update the inventory row in this document.
7. Run the verification commands in this document.

## Redaction Constraints

Documentation renders must not expose:

- API keys or provider secrets;
- cookies, bearer tokens, CSRF tokens, passwords, or session identifiers;
- raw provider prompts or raw provider responses;
- hidden reasoning, private story plans, or private diagnostic notes;
- full chat transcripts unless the visible screenshot is explicitly reviewed and safe;
- raw World Info, Memory Books, Summaryception, VectFox, or unrelated extension data;
- local absolute paths or user names when a logical path is enough.

Live host screenshots must use dedicated `recursion-soak-*` users. Automated evidence must reject `default-user`. Generation-enabled live smoke suppresses screenshots and Playwright traces; use sanitized metadata or a no-generation UI state for documentation visuals when binary capture would risk chat or model text.

## Text Diagrams

Explanatory pipeline, storage, provider, redaction, testing, card, prompt, host-boundary, diagnostics, and behavior-policy diagrams are maintained directly in Markdown as Mermaid graphs or tables. They are not promoted as PNG assets and should not be counted in the render inventory.

## Promoted Live UI Renders

These assets are promoted live UI documentation renders and may be embedded directly from `assets/documentation/renders/`.

| Asset | Source Type | Current Primary Doc | Visual Scope |
| --- | --- | --- | --- |
| `recursion-bar-desktop.png` | live host | not currently embedded | Recursion Bar mounted in a real SillyTavern desktop viewport with power, Auto/Manual, Cards scope, Hero Pixel Array, Reasoning Level, Last Brief, and options visible. Superseded in the root README by smaller feature renders. |
| `recursion-progress-menu-auto-pass.png` | live host | not currently embedded | Hero Pixel Array progress menu in a real Auto pass showing Utility planning, card work, prompt composition, prompt install, and ready or fallback rows. Superseded in the root README by smaller feature renders. |
| `recursion-full-viewer-overview.png` | live host | not currently embedded | Full Viewer in real SillyTavern showing Now, Deck, Activity, Prompt Packet, Settings, Providers, and diagnostics access without redaction leaks. Superseded in the root README by smaller feature renders. |
| `recursion-bar-mobile.png` | live host | not currently embedded | Recursion Bar in a phone-width real SillyTavern viewport showing touch-safe controls and collapsed menu access. Superseded in the root README by smaller feature renders. |
| `recursion-operator-install-enable.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Install and enable flow in real SillyTavern with Recursion enabled and the Recursion Bar mounted on the active chat. |
| `recursion-operator-pipeline-controls.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Standard/Rapid/Fused pipeline dropdown in the compact Recursion Bar, including visible Standard, Rapid, and Fused options. |
| `recursion-operator-mode-controls.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Auto and Manual mode controls in the compact Recursion Bar, including visible current mode and mode switch interaction. |
| `recursion-operator-enhancements-controls.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Enhancements menu with As Swipe/Replace apply control and Off, Prose, Dialogue, and Prose + Dialogue target rows. |
| `recursion-operator-story-form-controls.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Tense & PoV two-axis selector in the compact Recursion Bar showing Auto, Past/Present tense, and first-, second-, third-person, omniscient, and mixed POV choices. |
| `recursion-operator-bar-states.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Real Recursion Bar state set for Ready, Working, Paused, Issue, Off, provider warning, and prompt-ready behavior. |
| `recursion-operator-progress-menu-states.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Hero Pixel Array progress menu state set showing top-level rows, child rows, pass, fallback, and ready states from live UI. |
| `recursion-operator-options-menu.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Options/settings menu in real SillyTavern showing Play, Providers, Advanced, diagnostics controls, and Full Viewer entry point. |
| `recursion-operator-last-brief-states.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Last Brief dropdown state set showing selected cards, category glyphs, summaries, metadata chips, expansion, and Prompt Packet access. |
| `recursion-operator-full-viewer-sections.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Full Viewer section set for Now, Deck, Activity, Prompt Packet, Settings, Providers, and diagnostics in the live extension. |
| `recursion-operator-settings.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Settings view showing Play Behavior, Strength, Focus, Prompt Footprint, and Advanced injection controls in their final layout. |
| `recursion-operator-provider-controls.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Provider controls showing Utility fallback warning, Reasoner disabled state, session-key affordances, and provider test status. |
| `recursion-operator-prompt-packet-inspection.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Prompt Packet inspection view with redaction-safe diagnostics, selected refs, omissions, route metadata, and copy control. |
| `recursion-operator-fail-soft-states.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Fail-soft state set showing Utility failure, Reasoner fallback, prompt-install failure, cache reuse, and generation continuing without unsafe data. |
| `recursion-operator-mobile-behavior.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Mobile layout in real SillyTavern showing Recursion Bar, menu access, Last Brief or progress access, and touch-safe controls. |
| `recursion-first-run-install-enable.png` | live host | `docs/user/FIRST_RUN_WORKFLOW.md` | First-run SillyTavern extension settings and active chat state showing Recursion enabled and the Recursion Bar mounted. |
| `recursion-first-run-bar-mounted.png` | live host | `docs/user/FIRST_RUN_WORKFLOW.md` | First-run Recursion Bar mounted near the SillyTavern chat surface with core controls visible and stable. |
| `recursion-first-run-auto-pass.png` | live host | `docs/user/FIRST_RUN_WORKFLOW.md` | Hero Pixel Array progress menu during the first real Auto pass, ending in prompt ready or a clear safe fallback. |
| `recursion-first-run-manual-pass.png` | live host | `docs/user/FIRST_RUN_WORKFLOW.md` | Hero Pixel Array progress menu during a Manual pass with narrowed card scope and prompt readiness respecting that scope. |
| `recursion-first-run-inspection.png` | live host | `docs/user/FIRST_RUN_WORKFLOW.md` | Last Brief dropdown after the first Auto pass with selected cards, route metadata, and Prompt Packet access visible. |
| `recursion-provider-controls-utility-reasoner.png` | live host | `docs/user/PROVIDER_SETUP.md` | Utility and Reasoner provider controls in the live extension with source selection, model fields, session-only key state, Test Provider, and Clear Session Key affordances. |
| `recursion-prompt-packet-viewer.png` | live host | `docs/user/PROMPT_PRIVACY_AND_SAFETY.md` | Prompt Packet viewer in the live extension with selected card refs, omissions, injection metadata, sanitized diagnostics, and no raw provider or private transcript leakage. |
| `recursion-release-smoke-overview.png` | live host | `docs/release/0.1.0-pre-alpha.1.md` | Sanitized release smoke overview from a real SillyTavern render profile showing Recursion Bar ready state and progress completion without private chat or provider data. |
| `recursion-operator-fresh-next-generation-armed.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Recursion Bar idle command slot with fresh-next-generation armed, pressed Regenerate icon, and Last Brief still showing the previous completed packet. |
| `recursion-operator-fused-repair-progress.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Hero Pixel Array progress menu showing accepted Fused bundle cards plus targeted Standard repair for a damaged or missing sibling. |
| `recursion-operator-retention-settings.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Advanced Retention controls showing source-window, provider-message, scene-cache, source-variant, and run-journal caps. |
| `recursion-provider-test-busy-state.png` | live host | `docs/user/PROVIDER_SETUP.md` | Reasoner Provider disclosure staying open while the clicked Test Provider button shows lane-local `Testing...` busy state. |
| `recursion-prompt-packet-instruction-card-evidence.png` | live host | `docs/user/PROMPT_PRIVACY_AND_SAFETY.md` | Prompt Packet viewer showing instruction-shaped Card Evidence, Guidance status, selected refs, and sanitized route metadata. |
| `recursion-card-deck-editor.jpg` | supplied screenshot | `README.md`, `docs/user/RECURSION_OPERATOR_MANUAL.md`, `docs/technical/CARD_DECK_AND_HAND.md` | Card-system dropdown showing a custom deck, categories, card rows, drag handles, and off/active/priority states. |
| `recursion-card-authored-card-editor.jpg` | supplied screenshot | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Authored-card edit box showing name, description, full card text, Card Assist, and save/cancel controls. |

## Open Render Inventory

The `.6` card-system pass has these open live-host slots:

- `recursion-card-deck-editor.png` — live host — `docs/user/RECURSION_OPERATOR_MANUAL.md` and `README.md` — editable custom deck with categories, authored cards, eye-state controls, and drag handles.
- `recursion-card-hand-inspection.png` — live host — `docs/user/RECURSION_OPERATOR_MANUAL.md` and `README.md` — Last Brief or Full Viewer showing selected cards, omissions, and packet metadata.
- `recursion-card-priority-states.png` — live host — `docs/technical/CARD_DECK_AND_HAND.md` — card rows showing off, active, and priority eye-state controls.

Additional `.6` captures planned by the update brief include Auto/Manual scope, deck overview, category editor, authored-card editor, Card Assist, mobile editor, and fail-soft state. Add each row here when its target document receives the corresponding visible marker.

## Verification Commands

Render marker inventory:

```powershell
rg -n "^<Render Needed>:" README.md docs --glob "*.md" --glob "!docs/planning/DOCUMENTATION_EXPANSION_PLAN.md"
```

Marker format check:

```powershell
node -e "const fs=require('fs'),path=require('path');function walk(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{const p=path.join(d,e.name);return e.isDirectory()?walk(p):(e.isFile()&&p.endsWith('.md')?[p]:[]);});}const files=['README.md',...walk('docs').filter(f=>path.normalize(f)!==path.normalize('docs/planning/DOCUMENTATION_EXPANSION_PLAN.md'))];const bad=[];for(const f of files){fs.readFileSync(f,'utf8').split(/\r?\n/).forEach((line,i)=>{if(line.startsWith('<Render Needed>:')&&!/^<Render Needed>: assets\/documentation\/renders\/[^ ]+\.png - .+/.test(line))bad.push(f+':'+(i+1)+':'+line);});}if(bad.length){console.error(bad.join('\n'));process.exit(1);}console.log('marker format ok');"
```

Link check:

```powershell
node -e "const fs=require('fs'),path=require('path');function walk(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{const p=path.join(d,e.name);return e.isDirectory()?walk(p):(e.isFile()&&p.endsWith('.md')?[p]:[]);});}const files=['README.md',...walk('docs')];const missing=[];for(const f of files){const text=fs.readFileSync(f,'utf8');for(const m of text.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g)){let target=m[1].split('#')[0];if(!target)continue;if(target.startsWith('<')&&target.endsWith('>'))target=target.slice(1,-1);const resolved=path.normalize(path.join(path.dirname(f),target));if(!fs.existsSync(resolved))missing.push(f+' -> '+m[1]);}}if(missing.length){console.error(missing.join('\n'));process.exit(1);}console.log('links ok ('+files.length+' files)');"
```

ASCII scan:

```powershell
rg -n "[^\\x00-\\x7F]" README.md docs --glob "*.md"
```

Linked image check:

```powershell
node .recursion-doc-renderer/check-doc-images.mjs
```

Render inventory check:

```powershell
node -e "const fs=require('fs');const tracking=fs.readFileSync('docs/testing/DOCUMENTATION_RENDER_TRACKING.md','utf8');const rows=tracking.split(/\r?\n/).filter(line=>line.startsWith('| `')&&(line.includes('| live host |')||line.includes('| supplied screenshot |'))).length;const files=fs.readdirSync('assets/documentation/renders').filter(f=>/\.(png|jpg)$/i.test(f)).length;if(rows!==files){console.error(JSON.stringify({trackedRows:rows,renderImages:files},null,2));process.exit(1);}console.log('render inventory ok ('+files+' promoted images)');"
```
