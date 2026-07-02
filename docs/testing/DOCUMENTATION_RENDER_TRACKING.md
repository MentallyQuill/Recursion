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

The directory is source-controlled with `.gitkeep` so future promoted renders have a stable home. Temporary renderer output, browser profiles, draft screenshots, raw traces, and intermediate captures must stay out of git. Local renderer scratch output may use:

```text
.recursion-doc-renderer/
```

That path is ignored because it is tooling output. Promotion means copying only reviewed, redacted, final assets into `assets/documentation/renders/`.

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

## Open Render Inventory

All rows below correspond to current visible marker lines that begin `<Render Needed>:` in `README.md` or `docs/**/*.md`, excluding `docs/planning/DOCUMENTATION_EXPANSION_PLAN.md`, which contains fenced syntax examples.

| Render ID | Source Doc | Target Asset | Source Type | Needed Visual |
| --- | --- | --- | --- | --- |
| RDR-001 | `README.md` | `assets/documentation/renders/recursion-bar-desktop.png` | live host | Recursion Bar mounted in SillyTavern on desktop, showing Ready, mode, Hand dropdown, Utility state, Reasoner state, Actions, and Viewer controls. |
| RDR-002 | `README.md` | `assets/documentation/renders/recursion-progress-menu-auto-pass.png` | live host | Hero Pixel Array progress menu during an Auto pass, showing Utility planning, card generation, prompt composition, prompt install, and ready state. |
| RDR-003 | `README.md` | `assets/documentation/renders/recursion-full-viewer-overview.png` | live host | Full Viewer overview with Now, Deck, Activity, Prompt Packet, Settings, and Providers sections visible. |
| RDR-004 | `README.md` | `assets/documentation/renders/recursion-bar-mobile.png` | live host | Recursion Bar in a phone-width SillyTavern viewport, showing wrapped or compact controls without overlap. |
| RDR-005 | `docs/user/PROMPT_PRIVACY_AND_SAFETY.md` | `assets/documentation/renders/recursion-prompt-packet-viewer.png` | live host | Prompt Packet viewer showing Scene Brief, Turn Brief, Guardrails, selected card refs, omissions, injection metadata, and sanitized diagnostics. |
| RDR-006 | `docs/user/PROMPT_PRIVACY_AND_SAFETY.md` | `assets/documentation/renders/recursion-redaction-boundary.png` | diagram/static | Redaction boundary diagram showing allowed hashes and metadata versus forbidden secrets, raw provider payloads, hidden reasoning, and transcript text. |
| RDR-007 | `docs/user/PROMPT_PRIVACY_AND_SAFETY.md` | `assets/documentation/renders/recursion-external-coexistence.png` | diagram/static | Coexistence diagram showing Recursion-owned prompt lanes beside SillyTavern character prompts, World Info, Memory Books, Summaryception, VectFox, and author notes. |
| RDR-008 | `docs/user/PROVIDER_SETUP.md` | `assets/documentation/renders/recursion-provider-controls-utility-reasoner.png` | live host | Provider controls showing Utility and Reasoner cards with source selector, model fields, session key state, Test Provider, and Clear Session Key. |
| RDR-009 | `docs/user/PROVIDER_SETUP.md` | `assets/documentation/renders/recursion-provider-test-flow.png` | fixture/static | Provider test flow showing Utility pass, Reasoner off, Reasoner pass, and sanitized failure status without exposed secrets. |
| RDR-010 | `docs/user/PROVIDER_SETUP.md` | `assets/documentation/renders/recursion-provider-fallback-states.png` | fixture/static | Provider fallback states showing Utility unavailable, Reasoner timeout, invalid structured output, Utility fallback composition, and prompt skipped state. |
| RDR-011 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-install-enable.png` | live host | Install and enable flow with SillyTavern extension list, Recursion enabled state, and mounted Recursion Bar. |
| RDR-012 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-mode-controls.png` | live host | Power toggle, Auto/Semi-Auto mode controls, Reasoning Level, and prompt cleanup behavior. |
| RDR-013 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-bar-states.png` | fixture/static | Recursion Bar ready, working, warning, disabled, provider issue, prompt-ready states, Hero Pixel Array, and current-step text. |
| RDR-014 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-progress-menu-states.png` | fixture/static | Hero Pixel Array progress menu showing Utility planning, card generation child rows, cached rows, prompt composition, Reasoner pass or skip, prompt install, fallback, and settled states. |
| RDR-015 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-options-menu.png` | live host | Options/settings menu with Play, Providers, Advanced, Reasoning Level, provider controls, diagnostics limits, disabled planned commands, and Full Viewer entry point. |
| RDR-016 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-last-brief-states.png` | fixture/static | Last Brief dropdown with compact selected cards, category glyphs, meta chips, expandable text, Prompt Packet button, empty brief, stale brief, and error state. |
| RDR-017 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-full-viewer-sections.png` | live host | Full Viewer showing Now, Deck, Activity, Prompt Packet, Settings, Providers, and diagnostics sections. |
| RDR-018 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-settings.png` | live host | Settings view showing Play, Providers, Advanced, Mode, Reasoning Level, Strength, Prompt Footprint, Focus, Utility provider setup, and Reasoner provider setup. |
| RDR-019 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-provider-controls.png` | live host | Provider controls for Utility setup, Reasoner setup, session-only key state, test connection, Reasoner off, and fallback warning. |
| RDR-020 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-prompt-packet-inspection.png` | live host | Prompt Packet inspection showing Scene Brief, Turn Brief, Guardrails, selected card refs, omissions, injection metadata, and redaction-safe diagnostics. |
| RDR-021 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-fail-soft-states.png` | fixture/static | Fail-soft states for Utility unavailable, Reasoner timeout, invalid structured output, storage write failure, injection failure, and stale async result. |
| RDR-022 | `docs/user/RECURSION_OPERATOR_MANUAL.md` | `assets/documentation/renders/recursion-operator-mobile-behavior.png` | live host | Mobile layout showing Recursion Bar wrap behavior, menu access, viewer layout, and touch-safe controls. |
| RDR-023 | `docs/user/FIRST_RUN_WORKFLOW.md` | `assets/documentation/renders/recursion-first-run-install-enable.png` | live host | SillyTavern extension settings with Recursion enabled and the Recursion Bar mounted in the active chat. |
| RDR-024 | `docs/user/FIRST_RUN_WORKFLOW.md` | `assets/documentation/renders/recursion-first-run-bar-mounted.png` | live host | Recursion Bar mounted below the SillyTavern chat header with Ready, mode, Hand dropdown, Utility state, Reasoner state, Actions, and Viewer controls visible. |
| RDR-025 | `docs/user/FIRST_RUN_WORKFLOW.md` | `assets/documentation/renders/recursion-first-run-semi-auto-pass.png` | live host | Hero Pixel Array progress menu during a Semi-Auto pass showing the current Auto-equivalent prompt-install path. |
| RDR-026 | `docs/user/FIRST_RUN_WORKFLOW.md` | `assets/documentation/renders/recursion-first-run-auto-pass.png` | live host | Hero Pixel Array progress menu during an Auto pass showing Utility planning, card generation, prompt composition, prompt install, and ready state. |
| RDR-027 | `docs/user/FIRST_RUN_WORKFLOW.md` | `assets/documentation/renders/recursion-first-run-inspection.png` | live host | Last Brief dropdown and Full Viewer showing selected cards, Activity, Prompt Packet, Settings, and Providers after a first Auto pass. |
| RDR-028 | `docs/release/0.1.0-pre-alpha.1.md` | `assets/documentation/renders/recursion-release-smoke-overview.png` | live host | Sanitized release smoke overview showing Recursion Bar ready state, progress completion, and no visible secrets or raw provider payloads. |
| RDR-030 | `docs/technical/CARD_DECK_AND_HAND.md` | `assets/documentation/renders/recursion-card-family-matrix.png` | diagram/static | Card family matrix showing the eight fixed families, prompt use, lifecycle state, emphasis, and inspector visibility. |
| RDR-031 | `docs/technical/HOST_INTEGRATION_MANUAL.md` | `assets/documentation/renders/recursion-host-adapter-boundary.png` | diagram/static | Host adapter boundary visual showing SillyTavern context, generation interceptor, prompt adapter, settings adapter, storage adapter, UI mount, and host-neutral runtime. |
| RDR-033 | `docs/technical/PROMPT_PACKET_AND_INJECTION.md` | `assets/documentation/renders/recursion-prompt-injection-lanes.png` | diagram/static | Injection visual showing Recursion prompt keys, clear-before-install, rollback on failure, and host prompt boundary. |
| RDR-036 | `docs/technical/RECURSION_TECHNICAL_MANUAL.md` | `assets/documentation/renders/recursion-diagnostics-boundary.png` | diagram/static | Diagnostic boundary visual showing settings, scene cache, run journal, activity, artifacts, redaction, and forbidden raw provider data. |
| RDR-038 | `docs/technical/RUNTIME_TURN_SEQUENCE.md` | `assets/documentation/renders/recursion-stale-result-discard.png` | diagram/static | Stale-result discard visual showing active run supersession, abort signal, and late provider result being ignored. |
| RDR-040 | `docs/technical/STORAGE_AND_DIAGNOSTICS.md` | `assets/documentation/renders/recursion-storage-redaction-boundary.png` | diagram/static | Redaction boundary visual showing allowed metadata, blocked secrets, blocked raw provider payloads, and sanitized UI/artifact outputs. |

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
