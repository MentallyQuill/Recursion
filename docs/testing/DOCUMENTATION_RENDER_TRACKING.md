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
- `fixture/static`: captured from a deterministic local fixture, mocked UI state, or static composition that does not require a live host.
- `diagram/static`: produced as a diagram or static explanatory visual from docs, schemas, tests, and source.

Every inventory row must use one of those concrete labels. If the source cannot be determined, clarify the target documentation before adding or keeping the marker.

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

The 2026-07-02 render pass promoted 22 source-backed static infographics and 20 live-served Recursion UI screenshots. Live UI renders were captured through the local `.recursion-doc-renderer/` harness against the dedicated `recursion-soak-ui` SillyTavern profile, using the live-served Recursion UI module plus sanitized documentation fixture state so provider secrets, raw provider payloads, and private transcripts do not enter binary assets.

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

## Promoted Static Infographics

These assets are promoted and may be embedded directly from `assets/documentation/renders/`. They are explanatory infographics, not proof of a finished live UI state.

| Asset | Source Type | Current Primary Doc | Visual Scope |
| --- | --- | --- | --- |
| `recursion-technical-runtime-pipeline.png` | diagram/static | `docs/technical/RECURSION_TECHNICAL_MANUAL.md` | End-to-end runtime spine from SillyTavern snapshot through prompt install and diagnostics. |
| `recursion-runtime-turn-sequence.png` | diagram/static | `docs/technical/RUNTIME_TURN_SEQUENCE.md` | Power, Auto/Manual lifecycle, cancellation, stale-result discard, and fail-soft branches. |
| `recursion-stale-result-discard.png` | diagram/static | `docs/technical/RUNTIME_TURN_SEQUENCE.md` | Run-id guard that blocks stale provider, storage, or prompt work from mutating active state. |
| `recursion-card-family-matrix.png` | diagram/static | `docs/technical/CARD_DECK_AND_HAND.md` | Fixed V1 card families, including Knowledge, Consequences, Environment, and Items. |
| `recursion-card-lifecycle.png` | diagram/static | `docs/technical/CARD_DECK_AND_HAND.md` | Create, refresh, stow, discard, select, omit, and invalidate flow. |
| `recursion-prompt-packet-stack.png` | diagram/static | `docs/technical/PROMPT_PACKET_AND_INJECTION.md` | Scene Brief, Turn Brief, Guardrails, critical guardrail exception, omissions, and metadata. |
| `recursion-prompt-injection-lanes.png` | diagram/static | `docs/technical/PROMPT_PACKET_AND_INJECTION.md` | Recursion-owned prompt lanes, placement metadata, stale clear, and host boundary. |
| `recursion-provider-routing.png` | diagram/static | `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md` | Utility and Reasoner lanes, source selection, retries, fallback, and journal metadata. |
| `recursion-storage-key-map.png` | diagram/static | `docs/technical/STORAGE_AND_DIAGNOSTICS.md` | Settings, system index, scene cache, run journal, prompt metadata, and artifact boundary. |
| `recursion-storage-redaction-boundary.png` | diagram/static | `docs/technical/STORAGE_AND_DIAGNOSTICS.md` | Storage redaction boundary and blocked secret/raw-provider data. |
| `recursion-redaction-boundary.png` | diagram/static | `docs/user/PROMPT_PRIVACY_AND_SAFETY.md` | User-facing allowed/blocked data boundary. |
| `recursion-external-coexistence.png` | diagram/static | `docs/user/PROMPT_PRIVACY_AND_SAFETY.md` | Recursion coexistence with SillyTavern context systems and other extensions. |
| `recursion-host-adapter-boundary.png` | diagram/static | `docs/technical/HOST_INTEGRATION_MANUAL.md` | SillyTavern adapter APIs and host-neutral runtime interfaces. |
| `recursion-diagnostics-boundary.png` | diagram/static | `docs/technical/RECURSION_TECHNICAL_MANUAL.md` | Diagnostics, redaction, artifact, and journal boundary. |
| `recursion-testing-gates.png` | diagram/static | `docs/testing/TESTING_STRATEGY.md` | Deterministic tests, Playwright readiness, soak-user preflight, guarded live smoke, artifacts, and render promotion. |
| `recursion-provider-test-flow.png` | diagram/static | `docs/user/PROVIDER_SETUP.md` | Provider test states from idle through pass/fail/fallback. |
| `recursion-provider-fallback-states.png` | diagram/static | `docs/user/PROVIDER_SETUP.md` | Utility/Reasoner fallback and degraded operation states. |
| `recursion-behavior-policy.png` | diagram/static | `docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md`, `docs/user/RECURSION_OPERATOR_MANUAL.md` | Strength, Focus, and Prompt Footprint ownership, policy flow, and backend effect boundaries. |
| `recursion-operator-bar-states.png` | fixture/static | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Operator-level bar states for ready, working, warning, disabled, provider issue, and prompt-ready. |
| `recursion-operator-progress-menu-states.png` | fixture/static | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Hero Pixel Array progress menu states. |
| `recursion-operator-last-brief-states.png` | fixture/static | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Last Brief dropdown states. |
| `recursion-operator-fail-soft-states.png` | fixture/static | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Operator-visible fail-soft state families. |

## Promoted Live UI Renders

These assets are promoted live-served UI renders and may be embedded directly from `assets/documentation/renders/`.

| Asset | Source Type | Current Primary Doc | Visual Scope |
| --- | --- | --- | --- |
| `recursion-bar-desktop.png` | live host | `README.md` | Desktop Recursion Bar mounted in SillyTavern with power, Auto mode, Cards scope, Hero Pixel Array, reasoning, Last Brief, and options controls. |
| `recursion-progress-menu-auto-pass.png` | live host | `README.md` | Hero Pixel Array progress menu during an Auto pass. |
| `recursion-full-viewer-overview.png` | live host | `README.md` | Full Viewer overview with Now, Deck, Activity, Prompt Packet, Settings, Providers, and diagnostics. |
| `recursion-bar-mobile.png` | live host | `README.md` | Phone-width Recursion Bar layout. |
| `recursion-prompt-packet-viewer.png` | live host | `docs/user/PROMPT_PRIVACY_AND_SAFETY.md` | Prompt Packet viewer with card refs, omissions, injection metadata, and sanitized diagnostics. |
| `recursion-provider-controls-utility-reasoner.png` | live host | `docs/user/PROVIDER_SETUP.md` | Utility and Reasoner provider controls with source, model, session key, Test Provider, and Clear Session Key state. |
| `recursion-operator-install-enable.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Operator install and enable flow with Recursion mounted in SillyTavern. |
| `recursion-operator-mode-controls.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Auto and Manual mode controls. |
| `recursion-operator-options-menu.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Options/settings menu with Play, Providers, Advanced, diagnostics, and Full Viewer entry point. |
| `recursion-operator-full-viewer-sections.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Full Viewer sections. |
| `recursion-operator-settings.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Settings view with Play Behavior, Strength, Focus, Prompt Footprint, and injection controls. |
| `recursion-operator-provider-controls.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Provider controls with Utility fallback and Reasoner disabled state. |
| `recursion-operator-prompt-packet-inspection.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Prompt Packet inspection with redaction-safe diagnostics. |
| `recursion-operator-mobile-behavior.png` | live host | `docs/user/RECURSION_OPERATOR_MANUAL.md` | Mobile settings/menu access and touch-safe controls. |
| `recursion-first-run-install-enable.png` | live host | `docs/user/FIRST_RUN_WORKFLOW.md` | First-run SillyTavern surface with Recursion enabled and mounted. |
| `recursion-first-run-bar-mounted.png` | live host | `docs/user/FIRST_RUN_WORKFLOW.md` | First-run mounted Recursion Bar. |
| `recursion-first-run-manual-pass.png` | live host | `docs/user/FIRST_RUN_WORKFLOW.md` | Manual pass Hero Pixel Array progress menu with narrowed scope. |
| `recursion-first-run-auto-pass.png` | live host | `docs/user/FIRST_RUN_WORKFLOW.md` | Auto pass Hero Pixel Array progress menu. |
| `recursion-first-run-inspection.png` | live host | `docs/user/FIRST_RUN_WORKFLOW.md` | Last Brief inspection after first Auto pass. |
| `recursion-release-smoke-overview.png` | live host | `docs/release/0.1.0-pre-alpha.1.md` | Sanitized release smoke overview with ready state and progress completion. |

## Open Render Inventory

There are no open render markers outside the fenced syntax examples in `docs/planning/DOCUMENTATION_EXPANSION_PLAN.md`.

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

Promoted image check:

```powershell
node .recursion-doc-renderer/check-doc-images.mjs
```

Promoted inventory check:

```powershell
node -e "const fs=require('fs');const tracking=fs.readFileSync('docs/testing/DOCUMENTATION_RENDER_TRACKING.md','utf8');const rows=tracking.split(/\r?\n/).filter(line=>line.startsWith('| `')&&(line.includes('| diagram/static |')||line.includes('| fixture/static |')||line.includes('| live host |'))).length;const files=fs.readdirSync('assets/documentation/renders').filter(f=>f.endsWith('.png')).length;if(rows!==files){console.error(JSON.stringify({promotedRows:rows,promotedPngs:files},null,2));process.exit(1);}console.log('promoted inventory ok ('+files+' PNGs)');"
```
