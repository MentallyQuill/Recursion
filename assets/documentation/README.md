# Documentation Assets

This folder holds reviewed documentation assets that are safe to reference from `README.md` and `docs/**/*.md`.

## Renders

Promoted PNGs live in [renders/](renders/). These files are documentation assets, not runtime artifacts.

Current asset classes:

- `live host`: reviewed, redaction-safe screenshots from live-served Recursion UI in SillyTavern.

Raw captures, Playwright traces, temporary screenshots, browser profiles, and renderer scratch output must stay under `artifacts/` or `.recursion-doc-renderer/`. Only reviewed, redacted, final PNGs move into this folder.

Explanatory diagrams should stay text-native in Markdown as Mermaid graphs or tables instead of promoted PNGs. The authoritative inventory is [Documentation Render Tracking](../../docs/testing/DOCUMENTATION_RENDER_TRACKING.md). That document tracks promoted live UI renders and any future open screenshot slots marked in target docs with `<Render Needed>`.
