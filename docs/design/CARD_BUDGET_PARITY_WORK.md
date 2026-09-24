# Card budget and progress parity

Approved scope: Play settings set the total hand target (Low = Min, Medium/High = midpoint, Ultra = Max). Mandatory Priority coverage precedes ordinary work and may exceed that target. Fused and Segmented execute the same finalized selection. Progress reports delivered totals and shortfalls and survives restoration.

Implementation sequence:
1. Reproduce under-selection with real runtime fixtures, then enforce the shared target and complete eligible selection before dispatch. Preserve deck-ordered Priority coverage and explicit eligibility.
2. Record planned and delivered authored/generated counts and truthful shortfall reasons. Make durable progress render them, including restored Fused outcomes.
3. Exercise parity, partial bundle repair, insufficient eligibility, overflow, zero target, failure, and restored/cache state; update contracts and docs.
4. Run the full suite and isolated browser proof, review the scoped diff, integrate with latest main, push, and verify remote HEAD.

Verification record:
- Existing local restoration regression was reproduced before its fix; copied only its three scoped files into an isolated managed worktree. Unrelated viewer-scroll changes remain in the original checkout.
- All 89 offline test scripts pass after integration with current main, including target parity, actual installed packet references, Priority overflow, insufficient eligibility, failed generation, duplicate rankings, partial Fused repair, and same-turn reuse. The runtime race fixture polling allowance was widened from 100 to 1000 iterations to tolerate full-suite load without changing its ordering assertions.
- Independent code review found duplicate family proposals could create duplicate execution stages. Added a failing reproduction, deduplicated by canonical family while preserving first rank, and verified both workflows.
- Isolated Chromium proof uses the real runtime and UI with a deterministic provider at 1280px and 390px widths. Both workflows deliver identical ten-card hands, show authored/generated totals, restore seven generated rows after reload into a stale manifest, and display eligibility shortfalls. Screenshots and report are written to `artifacts/card-budget-browser/` by `node tools/scripts/prove-card-budget-browser.mjs`.
- The running SillyTavern host, user data, and configuration were not modified. Provider/live-host behavior is not claimed by the isolated proof.
- Integration retained main's Fused rejection/repair explanations and viewer-scroll preservation. Independent follow-up review found no further actionable issues.
- All three Playwright-dependent harness test scripts pass (`npm run test:browser`).

Decisions:
- Use the approved in-chat outline as the design; no new approval cycle is needed.
- Provider generation still validates grounded content. Filling an undersized selection chooses eligible generator families; it never fabricates card text or evidence.
