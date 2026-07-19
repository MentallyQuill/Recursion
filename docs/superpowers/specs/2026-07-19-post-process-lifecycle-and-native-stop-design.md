# Post-process Lifecycle and Native Stop Design

**Status:** Approved for implementation

**Date:** 2026-07-19

**Extends:** [Recursion Post-process Cards Design](2026-07-18-recursion-post-process-cards-design.md)

## Problem

SillyTavern's `GENERATION_ENDED` event passes `chat.length`, not the final
assistant message id. Recursion currently normalizes that scalar as a message
id. The Post-process final-target guard therefore rejects a valid completed
assistant message as a mismatch. The invalid-target branch also returns before
settling host-generation state, leaving Recursion's Stop affordance active even
though Post-processing never began.

The latest `default-user` SG-1 Branch #2 run demonstrated this exact failure:
Pre-process completed and installed its packet, the original assistant response
landed, no Post-process activity was recorded, and the hanging Stop state was
eventually canceled manually.

## Lifecycle Contract

For `generation_ended`, Recursion treats SillyTavern's scalar payload as an
event count and binds the event to the host's authoritative latest assistant
identity. Object payloads that explicitly carry `messageId`, `mesid`, `id`, or
`message_id` remain authoritative for test harnesses and host variants.

The assistant-landed handler must settle normal host-generation state on every
terminal branch. A missing, stale, or mismatched Post-process target may leave
the Post-process arm available for a later valid duplicate terminal event, but
it must not leave `hostGenerationActive` true.

One valid final assistant target claims the armed operation exactly once.
Duplicate terminal events cannot start a second Post-process operation, unlock
native controls early, or run Rapid warming twice.

## Native Stop Ownership

When Post-process Cards is enabled and an armed operation reaches a valid final
assistant target, Recursion locks SillyTavern's native generation controls
before guidance synthesis begins. This uses the host's
`deactivateSendButtons()` seam, which shows the native `#mes_stop` button at the
right of the message bar.

The native Stop remains visible and active for the complete Post-process
window:

1. Recursion guidance synthesis, including its same-lane retry.
2. SillyTavern native quiet rewrite, including its host-only retry.
3. Final source validation and As Swipe or Replace commit.

The native Stop click uses SillyTavern's own stop path. Its
`GENERATION_STOPPED` event cancels the Post-process arm or active abort
controller, stops the native quiet rewrite, clears Recursion-owned transient
prompt lanes, prevents late chat mutation, and settles progress as canceled
rather than failed.

Recursion releases native control ownership in `finally` after success,
failure, stale cancellation, or user Stop. When Post-process Cards is disabled,
Recursion never extends native Stop visibility beyond SillyTavern's ordinary
generation lifecycle.

## Progress Contract

Post-processing uses the existing normalized progress model and Hero Pixel
Array. The first Post-process activity event begins before guidance synthesis,
so the array and progress menu visibly transition into running state while the
native Stop is already available.

The progress surface shows:

- `Post-processing response`
- guidance synthesis running, retried, completed, or failed
- SillyTavern rewrite running, retried, completed, or failed
- Progressive category parents when applicable
- final As Swipe or Replace commit
- terminal completed, partial, failed, stale, or canceled state

Running blocks are cyan and completed blocks are green. Retry or partial states
are amber; hard failures are red. Cancellation is skipped/canceled, not a
provider warning. No raw transcript, prompt, guidance, provider response, or
secret may enter progress or journal output.

## Verification

The implementation must prove:

- a real SillyTavern scalar `generation_ended` payload binds to the latest
  assistant and starts exactly one Post-process operation;
- an invalid terminal target settles `hostGenerationActive`;
- native controls lock before guidance starts and unlock only after the full
  Post-process operation settles;
- native Stop cancels guidance and quiet rewrite work and prevents late commit;
- Hero Pixel Array and progress rows expose running and completed Post-process
  stages;
- Post-process disabled does not extend native Stop ownership;
- the installed `default-user` extension copy matches the repository;
- the latest SG-1 failure shape is covered by deterministic regression tests
  and a live-host proof.

