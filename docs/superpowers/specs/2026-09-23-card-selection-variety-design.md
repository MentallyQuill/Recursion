# Intelligent card selection and controlled variety

Date: 2026-09-23
Status: Approved for implementation by the user's end-to-end authorization and explicit all-approvals instruction.

## Purpose
Auto mode should respond to the current turn's actual needs and select complementary guidance. A little default variety should expose useful alternatives without replacing the strongest choices or turning selection into arbitrary rotation. Users may opt into a strict cooldown. Message truncation removal is a separate ongoing change and is outside this feature.

## Settings and defaults
- `cardSelection.variety`: `off | low | medium | high`, default `low`.
- `cardSelection.cooldownTurns`: integer 0 through 10, default 0. Zero disables cooldown. One excludes a card during the next completed response turn; two excludes it during the next two.
- Settings apply only in Auto. Manual retains explicit selection.
- Priority and Refinement cards are always included in deck order, exempt from cooldown and randomness, including when mandatory coverage exceeds the hand budget.
- Use existing compact settings rows adjacent to card budgets. Labels: Selection variety and Card cooldown (turns). Explain mandatory-card exemption, 0 = off, and that shortages yield smaller hands.

## Need-based arbitration
Keep one arbiter call. Give it current scene evidence, pending user input, eligible card descriptions, mandatory coverage, discretionary capacity, and a compact body-free history of recent selections and their purposes. It should identify what changed, the user's immediate request/action, and remaining needs. Ask for ranked useful candidates, with brief evidence-facing reasons naming their distinct contribution; do not request hidden reasoning.

Continue generating builtin guidance by family, preserving the existing family-slot budget. Arbiter jobs may name source card IDs to narrow a family, and authored cards may be proposed by card ID. Missing source IDs means the currently eligible source cards of that family, not excluded cards. Priority and Refinement sources are always restored. Candidate reasons may carry a shared coverage key so redundant optional candidates can be omitted before filling capacity. Invalid IDs are filtered against the current deck. No candidate is inferred from randomness alone.

The runtime retains the highest ranked nonredundant choices. The Play settings own the total hand target; an Arbiter budget cannot lower it. If the ranked choices are insufficient, complete the target in stable order from currently eligible family/authored sources. This completion never restores a cooled source or a rejected duplicate-coverage candidate, and does not add unranked alternatives to the variety draw. With variety off, keep rank order. Low attempts one final optional-slot replacement with probability 25%, from at most the next two useful alternatives. Medium allows one replacement at 50%, from the next four. High allows one replacement at 100%, from all remaining useful alternatives. No eligible alternative means no change. This intentionally keeps the strongest optional choices stable at every setting. Diversity is a means to relevant guidance, not an objective by itself.

Seed the draw from chat/turn identity, active deck revision, and selection settings. Persist the selected plan in the existing durable checkpoint. Same-turn resumes and prepared swipes reuse it; they do not redraw or advance history. No extra provider calls and no changes to provider temperature.

## Cooldown and card identity
Track actual source deck card IDs, scoped to deck ID. Generated family IDs are ephemeral and must not be used as cooldown identity. A cooled source card must be absent from the arbiter eligible catalog, generator source instructions, final hand and both Fused and Segmented fallback paths. Other eligible cards in the same family remain available. A mandatory source does not pull cooled ordinary siblings back into the request.

Cooldown is a deterministic eligibility filter before model selection. The arbiter cannot override it. If too few cards remain, allow a smaller or empty optional hand. Priority-only and wholly empty eligible hands must complete cleanly without forcing a fabricated generator job or a retry loop. No cooldown fallback silently relaxes the rule.

## Usage history and lifecycle
Only a successful prepared prompt followed by a completed host assistant response records usage. Prompt preparation, failed generation, stopped generation, provider retries, previews and internal enhancement operations do not independently record a turn. Usage is saved with the assistant message and active swipe metadata through the existing host persistence boundary. Save body-free identifiers and short purposes, never raw story text or prompts.

Read history from the active chat branch and validate its source lineage. Switching a swipe, editing an earlier message or deleting messages must not leave usage attributed to a different branch. Same-message swipes count as one response position, not extra elapsed turns. Post-processing must preserve the original selection provenance on its replacement/swipe. Read branch history before the provider's bounded message window, and expose only a small recent summary to the arbiter. New chats have independent history. Reload preserves history. Old messages without selection metadata still count as completed response turns for cooldown expiry.

History write failures must be surfaced as diagnostics without preventing a successfully generated story from being read. Unverified metadata must never create phantom exclusions.

## Inspection and contracts
Selection diagnostics identify mandatory sources, selected candidates and reasons, duplicate coverage, cooldown exclusions with turns remaining, budget exclusions, and any variety replacement. Show a concise summary in existing inspection surfaces; do not add a permanent bar badge.

Include selection settings in prepared-generation signatures and bump the selection contract, so changes invalidate incompatible prepared work. Persist enough selection input with the durable snapshot to restore precisely the same eligibility on resume. Keep V1 coherent; no legacy migration layers.

## Acceptance and verification
1. Defaults Low/0; settings normalize and persist; Manual bypasses both controls.
2. Across fixed seeds, Low sometimes changes exactly the last optional slot and often preserves the whole ranked hand; repeated seed/input is identical; no alternative never changes it.
3. Priority and Refinement always survive, including zero discretionary slots, all optional cards cooled, and family siblings.
4. Cooldown 1/2/10 has exact inclusive boundaries, works per source ID/deck, and does not mutate saved card states.
5. Both pipelines and Fused fallback receive only selected eligible source instructions; custom authored cards follow the same eligibility.
6. Completed normal turns persist usage; stop/failure/duplicate events do not; swipe/branch/edit/delete/reload and enhancement propagation are covered.
7. Changed needs produce different selected optional guidance in scripted successive-turn fixtures, while an unchanged need can retain the same cards with cooldown off.
8. Full offline suite passes; settings interaction/layout receives browser evidence. Offline model stubs prove contracts, not measured live narrative quality.
9. Integrate current main in the isolated branch, preserve concurrent changes, run final tests, and push to main without changing the running SillyTavern installation.

## Main integration
The concurrent full-message-context and Refinement changes are retained. Refinement is mandatory and exempt alongside Priority. Card selection contract 8 includes both features. Receipt provenance survives post-process replacement, alternate swipes, and Restore original.
