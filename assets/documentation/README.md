# Documentation Assets

This folder holds reviewed documentation assets that are safe to reference from `README.md` and `docs/**/*.md`.

## Renders

Promoted PNG and JPG images live in [renders/](renders/). These files are documentation assets, not runtime artifacts.

Current asset classes:

- `live host`: reviewed, redaction-safe screenshots from live-served Recursion UI in SillyTavern.

The `.6` card-system render family covers the Cards control, Auto/Manual scope, eye-state priority, custom deck/category/card editing, Card Assist, hand inspection, fail-soft behavior, and mobile interaction. Standalone screenshots document a specific contract; contact sheets document related state families. Pending captures stay visible in their target docs with `<Render Needed>` markers.

Raw captures, Playwright traces, temporary screenshots, browser profiles, and renderer scratch output must stay under `artifacts/` or `.recursion-doc-renderer/`. Only reviewed, redacted, final PNGs move into this folder.

Explanatory diagrams should stay text-native in Markdown as Mermaid graphs or tables instead of promoted PNGs. The authoritative inventory is [Documentation Render Tracking](../../docs/testing/DOCUMENTATION_RENDER_TRACKING.md). That document tracks promoted live UI renders and any future open screenshot slots marked in target docs with `<Render Needed>`.
