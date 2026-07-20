<p align="center">
  <img src="assets/branding/recursion-banner-white-transparent.png" alt="Recursion" style="max-width:100%;height:auto">
</p>

# Recursion

Recursion is a SillyTavern extension that helps a roleplay model notice what matters before it writes.

It reads the active chat, reasons over the immediate scene, builds a compact deck of scene cards, and selects the cards that matter for the next reply. The result is an inspectable prompt packet with guidance, card evidence, and guardrails for the current moment: pressure, intent, constraints, consequences, hidden boundaries, environmental affordances, and unresolved threads.

Recursion is a scene reasoning layer for the reply in front of you.

## How It Works

Recursion starts with a broad scene deck, selects a compact turn hand, and injects only the guidance and evidence that matter for the next reply. The selection step keeps the prompt focused without turning the deck into durable memory.

![Dynamic card selection from the full scene deck to the injected guidance packet](assets/documentation/renders/recursion-dynamic-card-selection.png)

Before SillyTavern generates, Recursion's Pre-process Cards prepare the focused guidance packet. After the host response lands, optional Post-process Cards can revise it through the host's native quiet-generation path.

![Recursion Post-process Cards Unified controls after the host response lands](assets/documentation/renders/recursion-post-process-panel-unified.png)

## At A Glance

- Builds scene cards for motivations, social subtext, consequences, knowledge, environment, items, and open threads.
- Gives you an independent Pre-process Cards deck for scene evidence and an independent Post-process Cards deck for response revision.
- Lets you use bundled starter decks or build custom decks with categories, authored cards, ordering, and card Assist where supported.
- Gives every editable card `off`, `active`, and `priority` states so you can control focus without rewriting the scene.
- Lets you duplicate the bundled Default Deck, create categories and authored cards, drag to reorder, and use Card Assist before committing edits.
- Selects a focused turn hand so the prompt gets what matters now, not every possible note.
- Uses separate Utility and optional Reasoner lanes, so fast planning and deeper synthesis can be tuned independently.
- Supports Auto mode for hands-off preparation and Manual mode for explicit operator control.
- Lets you leave tense and point of view on Auto or force the active story form when the Arbiter needs correction.
- Installs Recursion-owned SillyTavern prompt entries, then shows exactly what was prepared through Last Brief, progress states, and the Full Viewer.
- Keeps provider secrets and raw model I/O out of saved settings, prompt packets, run journals, diagnostics, browser storage, and SillyTavern file storage.

![Pre-process Cards control with the active deck and card-state summary](assets/documentation/renders/recursion-pre-process-cards-panel.png)

## Feature Surfaces

<table>
  <tr>
    <td width="50%">
      <div align="center"><img src="assets/documentation/renders/recursion-operator-pipeline-controls.png" alt="Recursion pipeline controls" style="max-width:100%;height:auto"></div><br>
      <strong>Pipelines</strong><br>
      Pick Standard, Rapid, or Fused depending on whether you want maximum clarity, lower send-time latency, or one larger structured card pass.
    </td>
    <td width="50%">
      <div align="center"><img src="assets/documentation/renders/recursion-operator-mode-controls.png" alt="Recursion mode controls" style="max-width:100%;height:auto"></div><br>
      <strong>Modes</strong><br>
      Use Auto when Recursion should prepare the next reply on its own, or Manual when you want to choose when scene work runs.
    </td>
  </tr>
  <tr>
    <td width="50%">
      <div align="center"><img src="assets/documentation/renders/recursion-pre-process-cards-panel.png" alt="Recursion Pre-process Cards deck control with categories and card states" style="max-width:100%;height:auto"></div><br>
      <strong>Pre-process Cards</strong><br>
      Prepare scene evidence before generation. Use the fixed catalog or duplicate it into an editable deck with categories, authored cards, drag ordering, and priority states.
    </td>
    <td width="50%">
      <div align="center"><img src="assets/documentation/renders/recursion-operator-last-brief-states.png" alt="Recursion selected card hand inspection" style="max-width:100%;height:auto"></div><br>
      <strong>Card Hand</strong><br>
      Recursion selects a bounded hand for the next reply. Last Brief and the Full Viewer show the selected cards, omissions, evidence, and packet metadata.
    </td>
  </tr>
  <tr>
    <td width="50%">
      <div align="center"><img src="assets/documentation/renders/recursion-post-process-panel-unified.png" alt="Recursion Post-process Cards Unified controls" style="max-width:100%;height:auto"></div><br>
      <strong>Post-process Cards</strong><br>
      Revise the completed reply with ordered cards through Unified or Progressive flow, then keep the result as a swipe or replace the selected response.
    </td>
    <td width="50%">
      <div align="center"><img src="assets/documentation/renders/recursion-operator-story-form-controls.png" alt="Recursion tense and point of view controls" style="max-width:100%;height:auto"></div><br>
      <strong>Tense &amp; PoV</strong><br>
      Let Recursion match the chat automatically, or force a past/present tense and point of view when the scene needs a steadier form.
    </td>
  </tr>
  <tr>
    <td width="50%">
      <div align="center"><img src="assets/documentation/renders/recursion-operator-progress-menu-states.png" alt="Recursion progress dropdown states" style="max-width:100%;height:auto"></div><br>
      <strong>Progress Dropdown</strong><br>
      Watch snapshot, planning, card work, prompt composition, install, fallback, and ready states without leaving the chat.
    </td>
    <td width="50%">
      <div align="center"><img src="assets/documentation/renders/recursion-operator-last-brief-states.png" alt="Recursion Last Brief card viewer" style="max-width:100%;height:auto"></div><br>
      <strong>Last Brief</strong><br>
      Inspect the latest selected hand, card evidence, guidance, guardrails, omissions, and packet metadata from the compact viewer.
    </td>
  </tr>
</table>

## Why Use It

LLMs can lose the practical shape of a scene even when the relevant text is still in context. They remember that a room exists, but miss the locked door. They know a character is angry, but fail to let that anger change the exchange. They know a secret, but reveal it too early.

Recursion is built for that gap. It helps the model read the scene like an operator would: what changed, what is under pressure, what should stay hidden, what consequences are now active, and what details should shape the next reply.

That makes it useful for long-running roleplay, scenes with layered motives, social tension, investigations, hidden information, object continuity, environmental constraints, and any setup where the next reply should respond to more than the last line of dialogue.

## Recursion vs Stepped Thinking

Stepped Thinking gives a character a private pre-generation pass. It is useful when the missing piece is character interiority: what a character feels, intends, hides, or thinks before speaking.

Recursion works at the scene level, building a card deck across the live situation, choosing the most relevant cards for this turn, and turning that into prompt evidence the next reply can use. Recursion addresses the problem of scene awareness: missed constraints, unresolved threads, hidden knowledge, social pressure, consequences, items, environment, and continuity that should affect the reply right now.

To that effect, it's a structured scene-reasoning and prompt-packet tool. It doesn't delve into character thoughts like Stepped Thinking, but instead acts as a dedicated thinking layer to ask: *What needs to be tracked and expanded upon to make the next generation feel like a rich continuation of the scene?*

## Pipelines

Pipeline controls decide how Recursion schedules scene work. Auto and Manual decide when it runs.

| Pipeline | Best Fit | Tradeoff |
| --- | --- | --- |
| Standard | Cheap and fast models such as Gemma, GPT OSS, o3-mini, Flash-style variants from DeepSeek, Gemini, Qwen, and similar. | Most debuggable and reliable path, but it does the full foreground pass before generation continues. |
| Rapid | Stable scenes where you want a shorter send-time pass after Recursion has warmed exact-source card evidence in the background. | Lower latency when warm, but escalates to Standard if the warm artifact is missing, stale, invalid, empty, or marked with a mandatory gap. |
| Fused | Lower-cost models with stronger structured reasoning, such as DeepSeek, MiniMax, MiMo, Nemotron, Qwen, and similar. | Fewer card calls through one larger bundle, but depends on the model returning trustworthy structured card output. |

### Cost Shape

Recursion adds provider work around the host model's normal generation: Pre-process planning and card guidance before the host writes, followed by optional Post-process guidance and native quiet rewriting after the response lands. Utility or Reasoner supplies structured guidance; SillyTavern remains the prose writer. Prompt Footprint affects the final Pre-process packet, while Post-process Evidence Messages bounds only Recursion's frozen evidence window.

Cost depends most on pipeline, Reasoning Level, card count, footprint, cache reuse, provider hidden reasoning, and any external model multiplier. For the detailed call breakdown and planning estimates, see [Recursion Cost Research](docs/technical/RECURSION_COST_RESEARCH.md).

Under the medium-reasoning Standard example in that research, Recursion adds roughly 1-1.5 cents per turn on top of normal SillyTavern generation.

## Post-process Cards

Post-process Cards run after the assistant reply lands. Recursion freezes the source response, bounded visible evidence, the Pre-process Prompt Packet, the active Post-process Deck, and the selected operation settings. Utility or Reasoner synthesizes contextual guidance; SillyTavern's native quiet-generation path writes the revised response using the active host preset and context.

Choose `Unified` to synthesize all enabled categories together and perform one host rewrite. Choose `Progressive` to rewrite one enabled category at a time in deck order, carrying each valid draft forward. The Post-process feature is off by default, and each card is independently On or Off.

Every operation checks source identity, stale-state boundaries, guidance shape, host output, exact no-op results, cancellation, and final application safety. A failed Unified operation leaves the original unchanged. A failed Progressive category leaves the last valid draft in place and later categories may continue; partial Progressive output commits only as a new swipe so the original remains available.

| Post-process feature | Function | Use it when |
| --- | --- | --- |
| `Off` | Leaves the host response unchanged. | You do not want a post-generation rewrite. |
| `Unified` | Synthesizes all enabled categories together, then performs one native host rewrite. | Categories reinforce one another and one combined revision is preferable. |
| `Progressive` | Runs enabled categories in order, carrying each valid draft into the next category. | You want visible category ordering and independent fail-soft boundaries. |
| `As Swipe` | Keeps the original and appends/selects one final rewritten swipe. | You want to compare or return to the original. |
| `Replace` | Replaces the selected response only after complete success. | You want the rewritten result to become the active response directly. |
| Post-process card `On` / `Off` | Enables or skips one ordered revision instruction; category activity derives from child cards. | You want to tune the deck without changing Pre-process selection. |

![Post-process Cards progress showing frozen evidence, guidance, native host rewrite, and swipe settlement](assets/documentation/renders/recursion-first-run-post-process-result.png)

## What You Can Inspect

- Last Brief: the latest selected card hand and prepared prompt packet.
- Full Viewer: Now, Deck, Activity, Prompt Packet, Settings, Providers, and diagnostics.
- Prompt Packet: guidance, card evidence, guardrails, references, omissions, fallbacks, and metadata.
- Progress States: live pass status, fallback paths, repair work, install state, and readiness.
- Post-process Results: guidance status, category outcomes, retries, host-writer settlement, swipe/replace behavior, and explicit failure reasons.
- Tense & PoV: Auto story-form detection or a forced past/present first-, second-, third-person, or mixed POV form for the next prompt contract.
- Provider Health: Utility and Reasoner tests, session-only direct keys, fallback visibility, and lane status.

## Fast Start

1. Install Recursion as a SillyTavern extension and refresh your browser.
2. Configure and test the Utility provider and Reasoner provider.
3. Use Standard pipeline for fast-cheap-dumb models (<500B models, like Llama, Qwen, Gemma , GPT OSS, flash-lite models, o3-mini, etc). Use Fused pipeline for fast-lesscheap-smart models (>500B models, like Nemotron, Deepseek, and similar)
4. Use Auto for normal hands-off preparation, or Manual when you want explicit control over what cards are pre-processed. Set cards to Priority for semi-auto.
5. Open Last Brief after generation to inspect what Recursion prepared.
6. If the completed reply needs further revision, enable Post-process Cards, choose a starter deck, and try `Unified` with `As Swipe` first.

For a guided first session, start with [First Run Workflow](docs/user/FIRST_RUN_WORKFLOW.md). For the full surface-by-surface guide, use the [Operator Manual](docs/user/RECURSION_OPERATOR_MANUAL.md).

## Documentation

- [Documentation Index](docs/DOCUMENTATION_INDEX.md) - Canonical map for user, technical, design, testing, release, and planning docs.
- [Post-process Cards Runtime](docs/architecture/POST_PROCESS_CARDS_RUNTIME.md) - Current operation boundary, writer ownership, flows, retries, persistence, and privacy.
- [Release Notes](docs/release/README.md) - Current pre-alpha checkpoints, verification, and known constraints.
- [First Run Workflow](docs/user/FIRST_RUN_WORKFLOW.md) - First-session path from installation through Manual, Auto, inspection, and cleanup.
- [Operator Manual](docs/user/RECURSION_OPERATOR_MANUAL.md) - Complete guide for UI surfaces, modes, settings, operation, diagnostics, storage, mobile behavior, and smoke checks.
- [Provider Setup](docs/user/PROVIDER_SETUP.md) - Utility and Reasoner setup, provider tests, fallback behavior, and safe verification.
- [Prompt Privacy And Safety](docs/user/PROMPT_PRIVACY_AND_SAFETY.md) - Prompt packet contents, injection boundary, storage limits, redaction, and coexistence with other SillyTavern context systems.
- [Technical Manuals](docs/technical/README.md) - Runtime, card, prompt, provider, storage, diagnostics, and host integration manuals.
- [Recursion Cost Research](docs/technical/RECURSION_COST_RESEARCH.md) - Provider call counts, token-budget ranges, example estimates, and cost-tuning levers.
- [Testing Strategy](docs/testing/TESTING_STRATEGY.md) - Deterministic gates, Playwright readiness, guarded live smoke, artifacts, and documentation render checks.
- [Cache Use And Reuse Spec](docs/architecture/CACHE_USE_AND_REUSE_SPEC.md) - Exact-source cache, swipe reuse, invalidation, and fresh-next-generation rules.
- [Post-process Cards Design](docs/superpowers/specs/2026-07-18-recursion-post-process-cards-design.md) - Current product and data contract for Post-process decks and host rewriting.

## Security And Privacy

Recursion treats provider secrets and raw model I/O as sensitive. OpenAI-compatible direct keys are session-only and do not persist to settings, scene cache, prompt packets, run journals, diagnostics, browser local storage, SillyTavern file storage, or test artifacts.

Normal diagnostics use hashes, compact statuses, bounded metadata, and sanitized activity instead of raw prompts, raw provider responses, hidden reasoning, or full transcript text.

## License

See [LICENSE](LICENSE).
