# Card Provider Contract Hardening Design

**Status:** Approved from live Writer diagnosis

**Date:** 2026-07-31

**Feature owner:** Recursion

## Problem

The live `default-user` Writer run using `TheDrummer/Cydonia-24B-v4.3`
proved that the provider was reachable while individual Segmented card stages
still failed. Utility Arbiter and Guidance Composer succeeded. Scene Frame
needed a correction attempt, Active Cast failed both attempts, and Character
Motivation never produced an accepted card artifact.

The rejected card responses parsed as JSON objects with top-level fields
`envelope` and `items`, but no top-level `schema`. Recursion rejected them as
`RECURSION_PROVIDER_SCHEMA_MISMATCH`. The durable stage then collapsed that
specific failure into a generic validation failure, persisted no useful
failure message, and allowed the overall fail-soft operation to display as
`Ready` even though requested cards were absent.

The next Writer run using `google/gemma-4-31b-it:thinking` completed the same
pipeline with three valid cards. The defect is therefore model-sensitive
structured-output handling, not provider unavailability.

## Root Causes

1. `machineJsonSchemaForRequest(...)` uses the generic schema fallback for
   `recursion.card.v1`. That fallback requires only `schema` and, when present,
   `snapshotHash`; it does not describe the required card role, family, or
   single `items` entry.
2. Recursion has safe request-owned identity repair after a canonical card
   envelope reaches `cardsFromProviderResult(...)`, but the provider router
   rejects the observed nested envelope before that validation boundary.
3. `classifyModelFailure(...)` and the scheduler's persisted failure record
   discard the specific provider/validation message and suggested recovery.
4. completed fail-soft execution is titled `Ready` even when a continuing card
   stage remains failed.
5. schema-mismatch diagnostics preserve returned field names but omit the
   requested role, expected schema, model, and a bounded structural description
   of the returned object.

## Goals

- Send a complete dynamic JSON Schema for every Segmented
  `recursion.card.v1` request.
- Recover the observed `{ envelope, items }` response only when the frozen
  request owns an unambiguous role, family, and snapshot identity and no
  returned identity conflicts with it.
- Reject wrong-role, wrong-family, wrong-snapshot, wrong-schema, multi-item,
  and non-object-item variants normally.
- Preserve precise provider and semantic validation failures through the
  durable attempt policy, checkpoint manifest, progress rows, and diagnostics.
- Add a correction instruction to a retried Segmented card request naming the
  exact failed contract.
- Display completed fail-soft runs with failed card stages as
  `Needs attention`, while leaving accepted siblings and prompt installation
  intact.
- Keep raw provider output, prompt text, transcript text, and hidden reasoning
  out of diagnostics.

## Non-Goals

- Guaranteeing useful prose from every model.
- Accepting arbitrary legacy response shapes.
- Weakening card safety, evidence, instruction-shape, catalog, or snapshot
  validation.
- Retrying an already accepted card stage.
- Turning a partial Segmented run into a blocking operation.
- Persisting raw malformed provider responses.
- Changing provider credentials, connection profiles, or model settings.

## Design

### 1. Complete card machine schema

`machineJsonSchemaForRequest(...)` will recognize
`recursion.card.v1` before the generic fallback. Its schema will require:

- top-level `schema`, `snapshotHash`, `role`, `family`, and `items`;
- request-owned `const` values for snapshot, role, and family;
- exactly one object in `items`;
- item-level `promptText` and `evidenceRefs`;
- bounded optional `summary`, `tokenEstimate`, `detailProfile`, `emphasis`,
  and `inspectorNotes` fields.

The provider contract version advances because the machine contract changes.
Runtime semantic validation remains authoritative after schema generation.

### 2. Guarded nested-envelope normalization

Before role-schema validation, a card-role response shaped as
`{ envelope, items }` may be converted to the canonical flat
`recursion.card.v1` envelope. Recovery requires all of the following:

- the requested role is one of the Segmented card roles;
- request metadata identifies the expected role and family;
- the frozen request contains a nonempty snapshot hash;
- `envelope` is an object;
- `items` contains exactly one object;
- every returned schema, role, family, and snapshot value, wherever supplied,
  agrees with the frozen request.

Missing identity is filled only from the frozen request. Conflicting identity
is never overwritten. Successful recovery records the compact diagnostic
`semanticNormalization: "nested-card-envelope"` without retaining provider
text.

### 3. Actionable failure propagation

Provider schema mismatch errors will include safe metadata:

```js
{
  code: 'RECURSION_PROVIDER_SCHEMA_MISMATCH',
  roleId: 'activeCastCard',
  expectedSchema: 'recursion.card.v1',
  actualSchema: '(missing)',
  responseFields: ['envelope', 'items'],
  responseShape: ['envelope:object(...)', 'items:array(1)']
}
```

The response shape contains types, counts, and bounded field names only.
Provider failure diagnostics also retain the safe provider source and model
available on the raw response boundary.

Segmented card validation preserves provider failures instead of replacing
them with `RECURSION_CARD_INVALID`. Semantic card failures name their stable
reject reason, such as `evidence-message-missing` or `catalog-mismatch`.
Durable attempt classification and checkpoint normalization retain the safe
message and suggested action.

### 4. Corrected retry request

When a Segmented card attempt is rejected and another attempt remains, the
next request appends a compact correction block containing the prior stable
code/message and the canonical `recursion.card.v1` requirement. The original
frozen role, family, snapshot, and source context remain unchanged.

### 5. Truthful partial completion

Segmented card stages continue using `failurePolicy: "continue"`. Accepted
siblings still reach deck, hand, guidance, packet, and installation. If the
operation completes with one or more failed execution stages, progress uses
`Needs attention` rather than `Ready`, keeps failed rows red, and exposes the
persisted reason and suggested action.

## Verification

- Provider tests prove the dynamic card JSON Schema and guarded live-shape
  normalization, including every conflicting-identity rejection.
- Attempt-policy and scheduler tests prove exact validation failures survive
  into durable stage records.
- Runtime Pre-process tests prove a malformed card receives a precise
  correction request while valid sibling cards survive.
- Progress tests prove a completed fail-soft run with a failed card is titled
  `Needs attention` and displays the actionable reason.
- Focused suites run after each red/green cycle, followed by `npm.cmd test`,
  `npm.cmd run test:alpha`, and `git diff --check` on the merged `refactor`
  result.

