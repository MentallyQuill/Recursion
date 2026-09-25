# Storage And Diagnostics Manual

This is the release-facing guide to Recursion storage. The implementation authority is [Storage And Diagnostics](../architecture/STORAGE_AND_DIAGNOSTICS.md).

## What Recursion Stores

Recursion stores normalized settings, a display-only Last Brief, a bounded run journal, one V2 operation manifest per active chat, isolated stage artifacts, and one-shot queued swipe intents.

Generated cards and prompt work are not long-lived story memory. They belong to an exact turn key and become ineligible when the user sends a new message or when the bounded source band changes.

## Context And Retention Controls

Advanced settings expose four bounds:

- Source Freshness Messages
- Source Freshness Text Budget
- Provider Analysis Messages
- Journal Entries

The first three limit Recursion-owned reading and analysis windows. They do not replace SillyTavern writer context. Journal Entries controls sanitized diagnostic history. Prior-turn generated artifacts are pruned automatically and have no user-tuned lifetime.

## Turn Checkpoints

Each V2 stage checkpoint records hashes, dependency bindings, attempt counts, and an isolated artifact reference. Manifests never contain raw prompt, card, provider, transcript, or rewrite bodies.

Resume and same-turn swipe reuse validate every relevant binding. Missing or corrupt artifacts force safe recomputation. An unchanged swipe may reinstall the same packet with zero Recursion model calls; a new user message always starts new work.

## Last Brief

Last Brief remains visible for inspection after a turn completes and may hydrate after reload. It is historical UI data only. Recursion never uses Last Brief as input to a later generation.

## Queued Swipe Actions

Reprocess and Full Rebuild start no work when clicked. They bind to the active turn and affect only the next matching swipe. A new user turn or edited source band cancels them. Each consumed intent is deleted immediately.

## Reset Turn Cache

Reset Turn Cache deletes Recursion-generated work and queued intents for the active turn and clears Recursion prompt lanes. It does not alter SillyTavern messages.

## Automatic Cleanup

Recursion repairs its system index, deletes orphan stage artifacts, prunes prior-turn execution data after authority ends, and deletes retired pre-V2 generated records. Retired records are recognized only for deletion and cannot be loaded into generation.

## Journal And Diagnostics

The run journal records bounded lifecycle codes, ids, hashes, counts, stage states, attempts, and prompt/host mutation outcomes. Diagnostics can export the same safe operational evidence plus normalized settings and provider capability summaries.

Failed Guidance stages may include `validationRule`: `model-reasoning`, `character-interiority`, or `unrevealed-story`. This allowlisted identifier survives attempt classification, manifest persistence, reload, and diagnostic export. It identifies the rejected wording category without exporting the matched phrase or rejected Guidance. Unknown rule values are omitted. A successful correction completes normally; the active failure explanation clears.

Recursion stores no endpoint or credential for model access. Raw chat text, provider prompts and responses, Connection Profile ids, hidden reasoning, credentials, cookies, and stack traces do not belong in manifests, journals, reports, or verification artifacts.

When storage persistence fails, Recursion can continue in memory and surfaces a warning. A memory fallback is never presented as durable storage.

## Troubleshooting Checklist

When reporting a lifecycle problem, capture:

1. operation id and turn-key hash;
2. native generation type;
3. manifest state and pause reason;
4. stage ids, states, attempts, and failure codes;
5. provider-call, prompt-install, prompt-clear, host-start, and host-stop counts;
6. queued-intent state;
7. installed extension version and content hash.

Do not include raw story text unless explicitly needed and intentionally sanitized.
