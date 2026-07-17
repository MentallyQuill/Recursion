# Documentation Assets

This folder holds reviewed documentation assets that are safe to reference from `README.md` and `docs/**/*.md`.

## Renders

Promoted PNG and JPG images live in [renders/](renders/). These files are documentation assets, not runtime artifacts.

Current asset classes:

- `live host`: reviewed, redaction-safe screenshots from live-served Recursion UI in SillyTavern.

The `.6` card-system render family covers the Cards control, Auto/Manual scope, eye-state priority, custom deck/category/card editing, Card Assist, hand inspection, fail-soft behavior, and mobile interaction. Standalone screenshots document a specific contract; contact sheets document related state families. Pending captures stay visible in their target docs with `<Render Needed>` markers.

Live card-system assets include `recursion-card-control.png` for the deck/scope surface and `recursion-card-authored-card-editor.png` for the bounded authored-card editor. The older supplied JPG captures are superseded by these live-host renders.

The same documentation pass now has open capture slots for the Cards scope popover, Enhancement recovery/status states, first-run Enhancement settlement, and normalized provider failure reasons. These are intentionally not fabricated from fixture HTML; capture them from the sterile live-host renderer and promote only after redaction review.

Raw captures, Playwright traces, temporary screenshots, browser profiles, and renderer scratch output must stay under `artifacts/` or `.recursion-doc-renderer/`. Only reviewed, redacted, final PNGs move into this folder.

Explanatory diagrams should stay text-native in Markdown as Mermaid graphs or tables instead of promoted PNGs. The authoritative inventory is [Documentation Render Tracking](../../docs/testing/DOCUMENTATION_RENDER_TRACKING.md). That document tracks promoted live UI renders and any future open screenshot slots marked in target docs with `<Render Needed>`.
