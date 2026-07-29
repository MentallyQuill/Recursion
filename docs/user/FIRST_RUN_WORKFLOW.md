# First Run Workflow

Recursion is a current-scene prompt compiler. It observes the active chat, builds a compact scene deck and turn hand, and installs a bounded prompt packet when Auto or Manual mode is active. Pipeline selection is separate from Auto and Manual: Segmented generates cards through a series of narrow calls, while Fused asks a stronger model for one multi-card bundle and repairs or falls back through Segmented when needed.

Recursion is not a memory manager, lore database, summary engine, vector recall layer, or campaign save system. Its editable card decks are local operator configuration, not durable lore.

## 1. Open Recursion

1. Open a SillyTavern chat.
2. Find the compact Recursion Bar attached to the chat.
3. Turn Recursion on.
4. Open the ellipsis menu and choose Providers.

## 2. Configure Utility

Utility is required.

1. Choose Current Host Model, a Host Connection Profile, or an OpenAI-Compatible Endpoint.
2. Complete the visible fields.
3. If using a direct endpoint, enter the session-only API key.
4. Run Test Provider.
5. Confirm Utility reports Ready.

Provider Test uses a bounded diagnostic deadline. Normal Recursion model stages do not: a slow local or remote model may remain pending until it returns, fails, or you stop the operation.

## 3. Choose Segmented

Start with Segmented. It gives each requested card family a smaller, simpler structured call and is the safest first choice for local, small, or less capable models.

1. Open the icon-only Pipeline selector immediately left of Mode.
2. Select Segmented.
3. Set Mode to Auto.
4. Leave Tense & PoV on Auto.
5. Send a message.
6. Watch the progress tree reach Prompt ready or show a clear fail-soft outcome.

SillyTavern's primary story generation remains host-owned. Recursion never automatically retries it.

## 4. Understand Recovery

Recursion checkpoints accepted stage work, so one failed late call does not require replaying the whole pipeline.

The progress tree exposes one contextual icon per eligible row:

| State | Action |
| --- | --- |
| Active | Stop |
| Paused | Resume |
| Retryable failure | Retry Stage |
| Reusable completed/cached | Clear Cache |
| Eligible completed/stale | Reprocess from Here |

Stop pauses the Recursion operation and preserves accepted checkpoints. Resume continues from the earliest incomplete stage. Retry Stage resets only the failed stage. Reprocess from Here queues that stage and its dependents for the next generation.

Hover the icon for its tooltip. On touch devices, the accessible label supplies the same meaning. The action slot stays fixed while long stage text truncates.

## 5. Tune Attempts

Open Advanced settings and find Attempts per step.

- Default: 2
- Range: 1 through 5
- Meaning: total automatic model attempts for each Recursion model stage

Only dispatched model calls consume attempts. Local validation, persistence, cache reads, prompt installation, and host commits do not. A pending slow call is not duplicated.

## 6. Try Manual

Manual uses the same Segmented or Fused execution graph but limits runnable card work to the families and sub-items you select.

1. Open Cards.
2. Select the card scope you want.
3. Set Mode to Manual.
4. Send or swipe.
5. Confirm only the allowed runnable cards appear in the completed hand.

## 7. Try Fused

Use Fused when the configured model is strong at larger structured JSON contracts.

1. Confirm Segmented works first.
2. Select Fused from the Pipeline control.
3. Send a message.
4. Watch for bundle generation and validation.

Fused keeps useful siblings from a partial bundle and repairs only damaged siblings through Segmented calls. It uses the full Segmented card path only when no useful bundle cards survive.

## 8. Queue Fresh Work

When Recursion is idle, the command slot shows Regenerate.

1. Click it once.
2. The button's state becomes `Full fresh generation: Queued`.
3. Send or swipe when ready.

The click itself starts no model or host work. The next generation consumes the intent once and bypasses reusable Pre-process checkpoints and scene-cache work. Clicking again before consumption cancels it.

Use Reprocess from Here when only one stage and its dependents need rebuilding. Use Clear Cache when a specific cached stage should no longer be reusable.

## 9. Inspect Results

Use Last Brief and Full Viewer to inspect:

- selected cards and omissions;
- Guidance, Card Evidence, and Guardrails;
- operation and stage states;
- attempts and normalized failure classes;
- cache and checkpoint reuse;
- queued, stale, and completed lifecycle states.

Diagnostics remain sanitized. Raw prompts, raw provider responses, transcript text, draft prose, hidden reasoning, API keys, and artifact bodies do not appear in normal diagnostic output.

## 10. Optional Post-process

Post-process is off by default. When enabled, it begins only after SillyTavern completes an assistant response.

- Unified applies the enabled Post-process deck in one guidance/rewrite sequence.
- Progressive carries the latest valid draft through enabled categories.
- As Swipe appends a selected Recursion-owned swipe.
- Replace commits only a complete successful result.

Guidance and rewrite drafts are checkpointed. Stop preserves the original response and accepted work. Resume continues from the earliest incomplete Post-process stage. A host-commit receipt prevents a resumed operation from duplicating a swipe or replacement.

## 11. Reset

Use Reset only when you want to remove all Recursion-owned operational state. It clears:

- scene cache;
- execution manifests and artifacts;
- queued intents;
- prepared-generation state;
- in-memory packet, hand, and plan state;
- journals;
- Recursion prompt keys.

Reset does not delete or rewrite SillyTavern chat history.

## First-Session Checklist

- Utility provider is configured and tested.
- Segmented reaches Prompt ready or a clear fail-soft outcome.
- The progress tree shows at most one contextual action per row.
- Stop preserves accepted checkpoints; Resume does not replay successful upstream stages.
- Attempts per step reflects the amount of automatic recovery you want.
- Fused either accepts its bundle, performs targeted Segmented repair, or reports full Segmented fallback.
- A queued full-fresh generation begins only on the next send or swipe.
- Power Off clears Recursion-owned prompt keys.

Related docs:

- [Provider Setup](PROVIDER_SETUP.md)
- [Recursion Operator Manual](RECURSION_OPERATOR_MANUAL.md)
- [Runtime Turn Sequence](../technical/RUNTIME_TURN_SEQUENCE.md)
