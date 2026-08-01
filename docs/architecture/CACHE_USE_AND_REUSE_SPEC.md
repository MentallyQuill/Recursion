# Turn Work, Checkpoints, And Reuse

This is the current V1 authority for generated-work reuse in Recursion.

## Core Rule

Recursion never guesses how long a narrative scene lasts. Generated cards, guidance, hands, packets, and stage artifacts belong to one exact turn key. There is no semantic scene lease, time-to-live controller, or cross-turn generated-work authority.

A turn key binds:

- chat identity;
- latest user message identity;
- bounded visible source band and its content hashes;
- selected assistant swipe identity where relevant;
- active character and group identity;
- normalized settings, provider route, pipeline, card configuration, and prompt contracts.

The bounded source band follows the configured source-window message and character limits. Editing text inside that band changes the turn key. Editing text outside it does not.

## Generation Classification

Every intercepted host generation is classified before provider work:

| Host action | Reuse contract |
| --- | --- |
| New user message | New turn. Revoke prior generation authority and run a new Arbiter. Repeated text with a new message id is still new. |
| Unchanged latest-assistant swipe | Same turn. Reinstall the validated packet with zero Recursion model calls. |
| Swipe after an edit inside the source band | Reject reuse, cancel matching queued intent, and rebuild. |
| Compatible paused Send, Swipe, or Regenerate | Continue saved work only after native SillyTavern generation re-enters the interceptor. |
| Missing or corrupt required artifact | Reject reuse and recompute rather than trusting incomplete state. |

Historical Last Brief data is display-only. It has no generation-facing read API and cannot authorize prompt reuse.

## Durable Execution

The V2 manifest contains metadata-only stage records. Each completed stage checkpoint binds its input hash, output hash, dependency hashes, provenance, attempt window, and isolated artifact reference. Resume is valid only when all bindings still match.

Pre-process stages are:

1. source snapshot;
2. Utility Arbiter;
3. Segmented card stages or one Fused bundle;
4. turn deck;
5. turn hand;
6. provider guidance;
7. prompt packet;
8. host prompt installation.

Post-process uses a separate operation bound to the completed assistant response identity. Every swipe body has a distinct response identity. A rewrite for one response body is never reused for another.

## Same-Turn Swipe Reuse

An unchanged swipe may reuse a completed Pre-process operation only when:

- turn key and source-band hash match;
- the stored operation completed successfully;
- the packet, hand, and install checkpoints exist and validate;
- provider, settings, pipeline, prompt, deck, and card contracts match;
- no matching Reprocess or Full Rebuild intent requires recomputation.

Reuse reinstalls the same validated packet, records checkpoint reuse, performs zero Recursion model calls, and leaves native SillyTavern generation in control of the story response.

## Reprocess On Next Swipe

`Reprocess from here on the next swipe` queues one stage and its dependents. Clicking it starts no provider work and no host generation. The intent binds to the current chat, phase, and turn key.

The next matching swipe consumes it once. Unaffected compatible checkpoints remain reusable. A new user turn, changed source band, chat change, or explicit cancellation deletes the intent instead of carrying it forward.

The queued row action becomes `Cancel queued reprocess`.

## Full Rebuild On Next Swipe

`Rebuild all Recursion work on the next swipe` queues a one-shot Full Rebuild for the active turn. Its selected state is `Full rebuild on next swipe: Queued`.

The click itself starts no work. The next matching swipe consumes the intent once and bypasses every Pre-process checkpoint for that operation. A normal new user message starts its own new turn and cancels the queued swipe intent.

Full Rebuild differs from Reset Turn Cache:

- Full Rebuild is queued and affects one matching swipe.
- Reset Turn Cache immediately deletes Recursion-generated work and queued intents for the active turn, then clears Recursion prompt lanes.
- Neither action changes SillyTavern messages.

## Stop, Resume, And Retry

Stop has one owner. The compact-bar Stop and contextual row Stop call the same runtime action. It pauses the durable graph, aborts active provider and Post-process work, requests native host Stop, clears Recursion prompt lanes, and records one bounded cleanup result.

Public Resume does not run provider work directly. It validates the paused operation, requests the matching native SillyTavern Send, Swipe, or Regenerate action, and leaves the manifest paused until the host interceptor returns. The interceptor then continues the earliest compatible frontier exactly once.

Retry is available only for the blocking failed stage. It resets that stage and descendants while preserving compatible accepted ancestors.

## Invalidation And Pruning

Source, turn, character/group, settings, provider, pipeline, prompt version, stage version, dependency hash, or artifact-integrity drift makes incompatible work stale. A stale operation cannot Resume, install a prompt, or commit Post-process output.

Retired pre-V2 generated records are recognized only by a private deletion matcher. They are pruned and cannot be loaded as generation input. Prior-turn execution artifacts are also pruned automatically after their authority ends, subject to the bounded diagnostics and recovery rules in the storage specification.

## Required Tests

The repository gates prove:

- repeated text with a new message id creates a new turn;
- edits inside the source band reject reuse while edits outside it do not;
- unchanged swipes reinstall a stable packet with zero Recursion model calls;
- corrupt artifacts recompute safely;
- Reprocess and Full Rebuild are one-shot, next-swipe-only, and turn-bound;
- new turns cancel queued swipe intents;
- Stop is idempotent and Resume is native-host-owned;
- Post-process response identities do not cross swipe bodies;
- retired generated records are deleted and never exposed through a generation-facing repository API.
