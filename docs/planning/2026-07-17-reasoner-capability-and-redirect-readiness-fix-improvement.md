# Reasoner Capability and Redirect Readiness Fix-Improvement

**Date:** 2026-07-17  
**Status:** Implemented and dedicated-user verified
**Scope:** Provider capability state, provider-test isolation, Redirect
readiness, settings persistence, runtime routing, observability, regression
coverage, and installed-copy verification

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement the task list. Each task must use
> test-first execution and a reviewer checkpoint before the next task.

**Goal:** Eliminate recurring accidental Reasoner disablement and make
Medium-or-higher Redirect readiness stable, explicit, race-safe, and provable
against the served SillyTavern extension.

**Architecture:** Replace the hidden persisted enable Boolean with one shared
provider-capability resolver. Split provider configuration from health writes,
bind asynchronous results to configuration hashes, guard lane concurrency, and
require installed-copy identity before live proof.

**Tech Stack:** Browser-native JavaScript ESM, SillyTavern extension settings
and connection profiles, Node test scripts, Playwright, PowerShell, SHA-256
installed-copy verification.

## Purpose

This document defines the permanent fix for recurring
`RECURSION_REASONER_DISABLED` failures in live Redirect runs.

The immediate SG-1 failure was reported as:

```text
Reasoner provider lane is disabled. Enable Reasoner in Providers or select Low reasoning.
```

That message is accurate only at the final preflight boundary. It does not
explain why a complete Reasoner configuration repeatedly changes from usable to
disabled, why a provider that just completed production Transformer and
Verifier calls can fail its tiny connectivity test, or why the installed
runtime can differ from the repository runtime.

The fix must replace the underlying state model. Another conditional around the
Redirect preflight is insufficient.

## Executive Decision

Remove `providers.reasoner.enabled` from the V1 persisted provider contract.

Reasoner availability will instead be derived from:

- the selected Reasoning Level;
- source-specific configuration completeness;
- session credential readiness;
- health evidence bound to the exact provider configuration;
- the operation's lane requirements.

The resulting capability states are:

```text
unconfigured
untested
ready
unhealthy
```

There is no independent hidden `enabled` Boolean.

Low remains the explicit Utility-only Reasoning Level. Medium, High, and Ultra
use Reasoner according to their existing routing policies only when Reasoner is
`ready`. Ordinary prompt-packet work falls back to Utility when Reasoner is not
ready. Medium-or-higher Redirect does not silently fall back because its writer
and verifier contract requires Reasoner.

## Confirmed SG-1 Evidence

The relevant live artifacts are:

- `F:\SillyTavern\SillyTavern\data\default-user\chats\SG-1\SG-1 - 2025-11-17@15h46m05s - Branch #1.jsonl`
- `F:\SillyTavern\SillyTavern\data\default-user\user\files\recursion-run-journal-SG-1---2025-11-17-15h46m05s---Branch-1.v1.json`
- `F:\SillyTavern\SillyTavern\data\default-user\backups\settings_default-user_20260717-144927.json`
- `F:\SillyTavern\SillyTavern\data\default-user\backups\settings_default-user_20260717-150055.json`
- `F:\SillyTavern\SillyTavern\data\default-user\settings.json`

The event sequence is:

| Time, UTC | Evidence |
| --- | --- |
| Before 20:59 | Saved Reasoner configuration had `enabled: true`, selected profile `58b65ce8-74cf-4c2e-8197-d4f4de3ba855`, `maxTokens: 8192`, and `lastTest.status: not-run`. |
| 20:59:23 | `editorialTransformer` completed successfully through Reasoner using `zai-org/glm-5.2:thinking`. |
| 20:59:49 | `editorialVerifier` started through the same Reasoner route. |
| 21:00:27-21:00:43 | Three Reasoner provider tests used an effective ceiling of `256`, exhausted it with `finishReason: length`, and recorded `RECURSION_PROVIDER_TOKEN_LIMIT`. |
| 21:00:36 | The production `editorialVerifier` completed successfully. |
| 21:00:37 | Redirect settled successfully with a verified swipe. |
| 21:00:55 backup | Persisted Reasoner state had changed to `enabled: false` and `lastTest.status: fail`. |
| 21:34:26 | The next Redirect run failed before diagnosis with `RECURSION_REASONER_DISABLED`. |

The provider configuration also oscillated repeatedly on July 17:

```text
false -> true -> false -> true -> false
```

There is no visible Reasoner enable control in the current provider panel.
`src/ui.mjs` renders the value as a hidden checkbox and serializes it in every
full provider-form patch.

The exact callback that won the final settings write is not recorded. The
journal records provider-call and cache events, but it does not record
provider-configuration revisions or before/after capability state. The evidence
therefore proves the state transition and its timing, while the missing mutation
ledger prevents attributing the final write to one callback with certainty.
This observability gap is included in the fix.

## Confirmed Implementation Defects

### 1. Hidden mutable enablement

`src/ui.mjs` currently renders:

```js
body.appendChild(hiddenCheckedControl({
  checked: lane === 'utility' ? true : source.enabled === true,
  dataset: providerDataset('Enabled', lane),
  ariaLabel: `${title} enabled`
}));
```

The control is hidden, but `readProviderPatch()` still sends it:

```js
enabled: lane === 'utility'
  ? true
  : controlChecked(sourceRoot, providerSelector('enabled', lane))
```

Any provider-field autosave can therefore submit an unrelated, stale enable
value. The operator cannot inspect or deliberately change that value through
the visible provider UI.

### 2. Wide provider patches

Changing one provider field serializes source, profile, endpoint, model,
temperature, top-p, max tokens, session key, and hidden enablement together.
The save boundary cannot distinguish the field the operator changed from
unrelated DOM state.

### 3. Divergent Reasoner gates

Current eligibility decisions are split across several implementations:

- `src/runtime.mjs::reasonerUnavailableReason()` checks `enabled`, test health,
  source configuration, and credentials.
- `src/runtime.mjs` Redirect preflight checks only `enabled`.
- `src/providers.mjs::shouldAllowReasoner()` checks `reasonerUse` and `enabled`.
- general lane routing calls `reasonerLaneAvailable()`.
- provider status and route-summary presenters derive their own health labels.

These functions can disagree about the same configuration.

### 4. Nonrepresentative provider tests

The installed `default-user` runtime still uses:

```js
const PROVIDER_TEST_RESPONSE_TOKENS = 256;
```

The Reasoner profile consumed that ceiling before returning complete visible
JSON. The repository runtime has already changed the request to the configured
lane ceiling, `8192`, but the installed and served copies are stale.

### 5. Provider-test and Editorial concurrency

Provider tests ran while an Editorial verifier was in flight. A provider test
may mutate health metadata while an operation is using the same configuration.
UI-only busy state is not sufficient because multiple mounts, rerenders,
programmatic callers, or stale panels can bypass it.

### 6. Deployment drift

At diagnosis time:

- repository `src/runtime.mjs` used the configured provider ceiling;
- installed and public served copies still used `256`;
- repository and installed `src/providers.mjs` and `src/settings.mjs` matched;
- repository and installed `src/runtime.mjs` and `src/ui.mjs` did not match.

Live behavior cannot be certified from repository tests while this condition is
possible.

### 7. Regression tests assert the symptom

The focused settings, UI, and Editorial runtime suites pass. Existing tests
prove that an explicitly disabled Medium Redirect fails early. They do not
prove:

- a provider test preserves provider configuration;
- a failed test cannot change capability configuration;
- stale form state cannot overwrite unrelated fields;
- provider-test results are bound to the configuration they tested;
- page reload preserves capability;
- live provider testing uses the configured token ceiling;
- provider testing and Editorial work are mutually safe;
- the served runtime matches the tested repository state.

## Design Goals

1. Make accidental Reasoner disablement structurally impossible.
2. Establish one authoritative provider-capability decision.
3. Preserve Utility fallback for ordinary prompt-packet work.
4. Preserve the strict Medium+ Redirect Reasoner requirement.
5. Prevent stale provider forms and stale asynchronous tests from overwriting
   newer configuration.
6. Make provider testing representative of production routing.
7. Prevent provider tests from racing active Editorial operations.
8. Explain every capability transition without storing secrets or raw provider
   content.
9. Prove the exact served code before any live success claim.

## Non-Goals

- Silently routing Medium+ Redirect writing through Utility.
- Blocking normal SillyTavern generation because optional Reasoner is
  unavailable.
- Retaining the old `providers.reasoner.enabled` field for compatibility.
- Treating a configured profile as healthy without a valid health result.
- Persisting API keys, raw prompts, raw responses, hidden reasoning, or
  unbounded provider errors.
- Running automated generation against `default-user`.
- Reworking unrelated Utility fallback, card selection, or cache contracts.

## Intended Behavior

### Capability state

The provider capability resolver returns one of:

| State | Meaning | Ordinary Medium+ routing | Medium+ Redirect |
| --- | --- | --- | --- |
| `unconfigured` | The selected source lacks required route data or session credentials. | Utility fallback | Redirect unavailable |
| `untested` | Configuration is complete but no health result exists for its current hash. | Utility fallback | Redirect unavailable |
| `ready` | The current configuration has matching successful health evidence. | Use Reasoner according to Reasoning Level | Redirect available |
| `unhealthy` | The current configuration has matching failed health evidence. | Utility fallback | Redirect unavailable |

Provider Test remains available for `unconfigured` only when the selected source
can actually be called. For example, an OpenAI-compatible endpoint with no
session key is not testable.

### Reasoning Level

| Level | Ordinary routing | Redirect transformation |
| --- | --- | --- |
| Low | Utility only | Utility writer under the existing Low contract |
| Medium | Reasoner guidance when ready; otherwise Utility | Reasoner required |
| High | Reasoner Arbiter/priority cards/guidance when ready; otherwise Utility | Reasoner required |
| Ultra | Reasoner-heavy when ready; otherwise Utility | Reasoner required |

### Redirect selection and send behavior

When Medium+ is selected:

- the Redirect menu row is available only when Reasoner capability is `ready`;
- an unavailable row remains visible with a concise reason and `Test Reasoner`
  action;
- selecting an unavailable Redirect does not change the active Enhancement
  mode;
- if an already-selected Redirect becomes unavailable later, the selection
  remains visible as blocked so the operator's intent is not silently changed;
- send interception detects the blocked state before host generation begins,
  records one warning, and marks Redirect skipped for that turn;
- the host generation continues normally;
- no Utility Redirect is attempted;
- no post-generation `RECURSION_REASONER_DISABLED` error is emitted.

This is a configuration warning, not an Editorial model-output failure.

### Provider Test

Provider Test:

- snapshots the current provider configuration and its hash;
- uses the configured max-token ceiling, default `8192`;
- uses the same source, profile, model, credential context, and structured
  response path as production;
- is single-flight per lane;
- cannot start while an operation is actively using that lane;
- writes only health metadata;
- applies its result only if the current configuration hash still matches the
  tested hash;
- never changes provider source, profile, endpoint, model, token ceiling, or
  capability configuration.

### General fallback

Reasoner unavailability must remain fail-soft for normal Recursion preparation.
The selected Reasoning Level stays visible, and routing uses Utility with a
specific reason such as:

```text
Reasoner untested. Utility composed.
Reasoner unhealthy. Utility composed.
Reasoner profile incomplete. Utility composed.
```

### Persistence

Provider configuration and provider health are persisted separately:

```js
{
  providers: {
    reasoner: {
      lane: 'reasoner',
      source: 'host-connection-profile',
      hostConnectionProfileId: '...',
      openAICompatible: {
        baseUrl: '',
        model: '',
        sessionApiKeyPresent: false
      },
      temperature: 0.4,
      topP: 0.95,
      maxTokens: 8192,
      configRevision: 12,
      health: {
        status: 'pass',
        configHash: '7e23c91a',
        checkedAt: '2026-07-17T21:00:36.227Z',
        source: 'provider-test'
      }
    }
  }
}
```

`sessionApiKeyPresent` remains a session-derived display flag. The key itself is
never persisted.

## Architecture

### New capability module

Create `src/provider-capability.mjs`. It is the only owner of source
configuration completeness, health binding, operation requirements, and
Reasoner eligibility.

```js
export const PROVIDER_CAPABILITY_STATES = Object.freeze([
  'unconfigured',
  'untested',
  'ready',
  'unhealthy'
]);

export function providerConfigHash(provider = {}) {
  return hashJson({
    lane: String(provider.lane || ''),
    source: String(provider.source || ''),
    hostConnectionProfileId: String(provider.hostConnectionProfileId || ''),
    openAICompatible: {
      baseUrl: String(provider.openAICompatible?.baseUrl || ''),
      model: String(provider.openAICompatible?.model || ''),
      sessionApiKeyPresent:
        provider.openAICompatible?.sessionApiKeyPresent === true
    },
    temperature: Number(provider.temperature),
    topP: Number(provider.topP),
    maxTokens: Number(provider.maxTokens)
  });
}
```

The resolver consumes explicit context rather than reaching into UI or host
globals:

```js
export function resolveProviderCapability({
  settings = {},
  lane = 'utility',
  operation = 'prompt-packet',
  host = {}
} = {}) {
  const provider = settings.providers?.[lane] || {};
  const configHash = providerConfigHash(provider);
  const configuration = validateProviderRoute(provider, host);
  const health = provider.health || {};
  const healthMatches = health.configHash === configHash;
  const state = !configuration.complete
    ? 'unconfigured'
    : !healthMatches || !['pass', 'fail'].includes(health.status)
      ? 'untested'
      : health.status === 'pass'
        ? 'ready'
        : 'unhealthy';
  const reasoningLevel = normalizeReasoningLevel(settings.reasoningLevel);
  const required = lane === 'reasoner'
    && operation === 'redirect'
    && reasoningLevel !== 'low';
  const selectedByPolicy = lane === 'utility'
    || reasoningLevel !== 'low';

  return Object.freeze({
    lane,
    state,
    configHash,
    configRevision: Number(provider.configRevision) || 0,
    configured: configuration.complete,
    testable: configuration.testable,
    ready: state === 'ready',
    required,
    eligible: selectedByPolicy && state === 'ready',
    reasonCode: capabilityReasonCode({
      lane,
      state,
      required,
      configuration
    }),
    message: capabilityMessage({
      lane,
      state,
      required,
      configuration
    })
  });
}
```

The module must not import runtime, UI, providers, or settings stores. Those
consumers import this module.

### Settings transactions

Replace whole-form provider mutation with two narrow operations:

```js
updateProviderConfig(lane, patch, { expectedRevision })
recordProviderHealth(lane, result, { configHash })
```

Configuration updates:

```js
function updateProviderConfig(lane, patch = {}, {
  expectedRevision = null
} = {}) {
  const current = getProvider(lane);
  if (
    expectedRevision !== null
    && current.configRevision !== expectedRevision
  ) {
    return {
      ok: false,
      error: {
        code: 'RECURSION_PROVIDER_CONFIG_STALE',
        message: 'Provider settings changed before this edit was saved.'
      }
    };
  }

  const next = normalizeProviderSettings(lane, {
    ...current,
    ...pickProviderConfigPatch(patch),
    configRevision: current.configRevision + 1,
    health: { status: 'not-run' }
  }, secretStore);

  return {
    ok: true,
    provider: persistProvider(lane, next),
    changedKeys: changedProviderConfigKeys(current, next)
  };
}
```

Health updates use compare-and-swap semantics:

```js
function recordProviderHealth(lane, result = {}, {
  configHash = ''
} = {}) {
  const current = getProvider(lane);
  if (providerConfigHash(current) !== configHash) {
    return {
      ok: false,
      stale: true,
      error: {
        code: 'RECURSION_PROVIDER_TEST_STALE',
        message: 'Provider settings changed before the test completed.'
      }
    };
  }

  return {
    ok: true,
    provider: persistProvider(lane, {
      ...current,
      health: normalizeProviderHealth({
        ...result,
        configHash
      })
    })
  };
}
```

Provider health writes cannot contain configuration keys. Tests must reject
such input.

### Field-scoped UI autosave

Each visible provider control maps to one narrow patch:

```js
const PROVIDER_FIELD_PATCHERS = Object.freeze({
  source: (control) => ({ source: control.value }),
  profile: (control) => ({
    hostConnectionProfileId: control.value
  }),
  'base-url': (control) => ({
    openAICompatible: { baseUrl: control.value }
  }),
  model: (control) => ({
    openAICompatible: { model: control.value }
  }),
  'max-tokens': (control) => ({
    maxTokens: Number(control.value)
  })
});
```

The event handler sends only the changed field:

```js
function providerPatchFromControl(control) {
  const field = providerFieldFromDataset(control.dataset);
  const patcher = PROVIDER_FIELD_PATCHERS[field];
  return patcher ? patcher(control) : {};
}

function handleProviderAutoSave(event) {
  const control = event?.target;
  if (!isProviderAutoSaveControl(control)) return;
  const lane = providerLaneFromDataset(control.dataset);
  const revision = Number(
    control.closest('[data-recursion-provider-body]')
      ?.dataset.recursionProviderRevision
  );
  runAction(runtime.updateProviderConfig(
    lane,
    providerPatchFromControl(control),
    { expectedRevision: revision }
  ));
}
```

Delete `hiddenCheckedControl()` and all provider-enabled datasets.

### Runtime operation guard

Runtime owns lane activity:

```js
const activeProviderOperations = new Map();
const activeProviderTests = new Map();

function beginProviderOperation(lane, operation) {
  if (activeProviderTests.has(lane)) {
    return busyProviderResult(lane, 'provider-test');
  }
  const token = Object.freeze({
    id: makeId(`provider-operation-${lane}`),
    lane,
    operation
  });
  activeProviderOperations.set(lane, token);
  return { ok: true, token };
}

function endProviderOperation(token) {
  if (activeProviderOperations.get(token.lane)?.id === token.id) {
    activeProviderOperations.delete(token.lane);
  }
}
```

Provider Test is single-flight and rejects active-lane overlap:

```js
async function testProvider(lane = 'utility') {
  const resolvedLane = providerLane(lane);
  if (activeProviderOperations.has(resolvedLane)) {
    return {
      ok: false,
      error: {
        code: 'RECURSION_PROVIDER_BUSY',
        message: `${providerLaneTitle(resolvedLane)} is in use. Test it after the current operation finishes.`
      }
    };
  }
  if (activeProviderTests.has(resolvedLane)) {
    return activeProviderTests.get(resolvedLane);
  }

  const operation = runProviderTest(resolvedLane)
    .finally(() => activeProviderTests.delete(resolvedLane));
  activeProviderTests.set(resolvedLane, operation);
  return operation;
}
```

Provider Test must not call `supersedeActiveRun()`.

### Representative provider-test budget

The request uses the current configuration snapshot:

```js
async function runProviderTest(lane) {
  const settings = settingsStore.get();
  const capability = resolveProviderCapability({
    settings,
    lane,
    operation: 'provider-test',
    host: providerHostCapabilities()
  });
  if (!capability.testable) {
    return providerNotTestableResult(capability);
  }

  const provider = settings.providers[lane];
  const configHash = capability.configHash;
  const result = await generationRouter.generate('providerTest', {
    lane,
    responseLength: provider.maxTokens,
    prompt: providerTestPrompt(lane),
    ...reasoningRequestMetadata(settings, 'provider-test')
  }, {
    timeoutMs: PROVIDER_TEST_TIMEOUT_MS,
    maxAttempts: 1
  });

  const healthResult = validProviderTestResult(result)
    ? providerHealthPass(result)
    : providerHealthFailure(result);
  const persisted = settingsStore.recordProviderHealth(
    lane,
    healthResult,
    { configHash }
  );

  return persisted.stale
    ? staleProviderTestResult(persisted.error)
    : resultWithHealth(result, persisted.provider.health);
}
```

`responseLength` must resolve to `8192` for untouched Utility and Reasoner
defaults.

### Runtime routing integration

Replace `reasonerUnavailableReason()`, `reasonerLaneAvailable()`,
`shouldAllowReasoner()`, and the Redirect enabled-only preflight with calls to
the shared resolver.

Ordinary routing:

```js
function providerLaneForPolicyLane(policyLane, settings, host) {
  if (policyLane !== 'reasoner') return 'utility';
  const capability = resolveProviderCapability({
    settings,
    lane: 'reasoner',
    operation: 'prompt-packet',
    host
  });
  return capability.eligible ? 'reasoner' : 'utility';
}
```

Redirect readiness:

```js
function redirectReadiness(settings, host) {
  if (reasoningPolicyForSettings(settings).level === 'low') {
    return {
      ready: true,
      lane: 'utility',
      capability: null
    };
  }
  const capability = resolveProviderCapability({
    settings,
    lane: 'reasoner',
    operation: 'redirect',
    host
  });
  return {
    ready: capability.ready,
    lane: 'reasoner',
    capability
  };
}
```

The provider boundary performs defense-in-depth validation with the same
resolver. It must not recreate a second Reasoner policy.

### Pre-generation Redirect guard

At send interception, before host generation:

```js
const redirect = redirectReadiness(settings, providerHostCapabilities());
if (
  settings.enhancements.mode === 'redirect'
  && !redirect.ready
) {
  markEnhancementSkippedForPendingTurn({
    mode: 'redirect',
    reasonCode: redirect.capability.reasonCode,
    reason: redirect.capability.message
  });
  stageRuntimeActivity({
    phase: 'editorialPreflight',
    severity: 'warning',
    label: `Redirect unavailable. ${redirect.capability.message}`,
    detail: {
      capability: sanitizeProviderCapability(redirect.capability)
    }
  });
}
```

When the assistant response lands, the marked turn does not start Editorial
diagnosis. The host response remains visible and unchanged.

### UI readiness

The Redirect menu consumes `view.providerCapabilities.reasoner`:

```js
{
  value: 'redirect',
  label: 'Redirect',
  qualifier: 'Experimental',
  disabled: reasoningLevel !== 'low'
    && reasonerCapability.state !== 'ready',
  reason: reasonerCapability.message,
  action: reasonerCapability.testable
    ? { id: 'test-reasoner', label: 'Test Reasoner' }
    : { id: 'open-reasoner', label: 'Configure Reasoner' }
}
```

The Reasoner provider header shows capability rather than the obsolete enable
state:

```text
Reasoner Provider        Ready
Reasoner Provider        Untested
Reasoner Provider        Unhealthy
Reasoner Provider        Configure
```

### Capability mutation journal

Every provider configuration or health mutation records:

```js
{
  event: 'provider.capability.changed',
  severity: next.state === 'unhealthy' ? 'warn' : 'info',
  details: {
    lane: 'reasoner',
    mutation: 'config' | 'health',
    changedKeys: ['hostConnectionProfileId'],
    configRevision: 13,
    previousState: 'ready',
    nextState: 'untested',
    reasonCode: 'reasoner-config-changed'
  }
}
```

The event must not contain profile names, endpoint URLs, API keys, raw provider
errors, model output, or prompt text. Profile identifiers may be represented by
a bounded hash only when diagnostics require correlation.

## Pre-Alpha Contract Migration

Recursion is pre-alpha. Normalize persisted settings directly to the new
contract:

```js
export function normalizeProviderSettings(lane, value = {}, secretStore = null) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_RECURSION_SETTINGS.providers[lane];
  const normalized = {
    lane,
    source: normalizeProviderSource(source.source, defaults.source),
    hostConnectionProfileId: normalizeProfileId(
      source.hostConnectionProfileId
    ),
    openAICompatible: normalizeOpenAiConfig(
      source.openAICompatible,
      secretStore,
      lane
    ),
    temperature: numberInRange(
      source.temperature,
      defaults.temperature,
      0,
      2
    ),
    topP: numberInRange(source.topP, defaults.topP, 0, 1),
    maxTokens: Math.round(numberInRange(
      source.maxTokens,
      defaults.maxTokens,
      64,
      131072
    )),
    configRevision: nonNegativeInteger(source.configRevision, 0),
    health: normalizeProviderHealth(source.health)
  };

  return bindHealthToCurrentConfig(normalized);
}
```

Do not read or preserve `source.enabled`.

Legacy `lastTest` has no configuration hash and therefore cannot prove which
route it tested. Ignore it during migration and normalize health to `not-run`;
do not guess that an old pass applies to the current route.

Remove persisted `reasonerUse` as an independent authority if it is still
stored. Runtime may derive an internal route value from Reasoning Level.

## File Map

Expected production changes:

- Create `src/provider-capability.mjs`
  - provider configuration hashing, route completeness, capability state,
    operation requirements, and safe reason text.
- Modify `src/settings.mjs`
  - remove provider `enabled`, split configuration and health mutation, add
    revisions and stale-result protection.
- Modify `src/providers.mjs`
  - consume shared capability state and remove `shouldAllowReasoner`.
- Modify `src/runtime.mjs`
  - consume shared capability state, add lane operation/test guards, move
    Redirect readiness to pre-generation, and remove the enabled-only preflight.
- Modify `src/ui.mjs`
  - remove hidden enablement, use field-scoped autosave, render capability, and
    guard Redirect selection.
- Modify `src/ui/view-model.mjs`
  - expose safe provider capability models.
- Modify `src/extension/index.js`
  - pass host capability context into the shared resolver without globals.
- Create `tools/scripts/test-provider-capability.mjs`
  - capability-state and operation matrix.
- Modify `tools/scripts/test-settings.mjs`
  - migration, revision, field-scoped patch, and stale health tests.
- Modify `tools/scripts/test-providers.mjs`
  - provider-boundary capability and test-budget assertions.
- Modify `tools/scripts/test-runtime.mjs`
  - ordinary fallback, pre-generation guard, concurrency, and journal tests.
- Modify `tools/scripts/test-editorial-runtime.mjs`
  - Medium+ Redirect readiness and no-call blocked-state tests.
- Modify `tools/scripts/test-ui.mjs`
  - visible capability and unavailable Redirect interactions.
- Create `tools/scripts/verify-installed-copy.mjs`
  - repository/installed/public production-tree hash verification.
- Modify `tools/scripts/run-tests.mjs`
  - register new deterministic suites.
- Update canonical provider, runtime, UI, operator, and testing documentation.

## Implementation Plan

### Task 1: Introduce provider capability state

**Files:**

- Create `src/provider-capability.mjs`
- Create `tools/scripts/test-provider-capability.mjs`
- Modify `tools/scripts/run-tests.mjs`

**Produces:**

```js
providerConfigHash(provider)
resolveProviderCapability({ settings, lane, operation, host })
sanitizeProviderCapability(capability)
```

- [ ] Add a table-driven test covering both lanes, all four capability states,
  all four Reasoning Levels, ordinary prompt work, provider testing, and
  Redirect.
- [ ] Assert Medium+ ordinary work falls back when Reasoner is not ready.
- [ ] Assert Medium+ Redirect is required and unavailable unless state is
  `ready`.
- [ ] Assert Low Redirect selects Utility regardless of Reasoner state.
- [ ] Run `node tools/scripts/test-provider-capability.mjs` and confirm failure
  because the module does not exist.
- [ ] Implement the isolated capability module with no runtime/UI imports.
- [ ] Run the focused test and require `[pass] provider capability`.

Representative assertion:

```js
const blocked = resolveProviderCapability({
  settings: mediumSettings({
    reasoner: configuredReasoner({
      health: {
        status: 'fail',
        configHash: expectedConfigHash
      }
    })
  }),
  lane: 'reasoner',
  operation: 'redirect',
  host: completeHostCapabilities()
});

assertEqual(blocked.state, 'unhealthy', 'matching failed health is unhealthy');
assertEqual(blocked.required, true, 'Medium Redirect requires Reasoner');
assertEqual(blocked.eligible, false, 'unhealthy Reasoner is not eligible');
```

### Task 2: Replace persisted enablement with transactional configuration

**Files:**

- Modify `src/settings.mjs`
- Modify `tools/scripts/test-settings.mjs`

**Produces:**

```js
settingsStore.updateProviderConfig(lane, patch, { expectedRevision })
settingsStore.recordProviderHealth(lane, health, { configHash })
```

- [ ] Add a migration fixture containing `reasoner.enabled: false` with a
  complete profile and assert the normalized provider no longer has an
  `enabled` property.
- [ ] Add a migration fixture containing `reasoner.enabled: true` and assert it
  produces the same normalized contract.
- [ ] Assert changing one field increments `configRevision`, clears bound
  health, and preserves every unrelated configuration field.
- [ ] Assert a mismatched `expectedRevision` returns
  `RECURSION_PROVIDER_CONFIG_STALE` without a write.
- [ ] Assert a health result with a stale `configHash` is discarded.
- [ ] Assert pass and failure health writes cannot change provider
  configuration.
- [ ] Run `node tools/scripts/test-settings.mjs` and confirm the new assertions
  fail.
- [ ] Implement the new settings operations and remove the obsolete field.
- [ ] Run `node tools/scripts/test-settings.mjs` and require `[pass] settings`.

Critical regression:

```js
const before = store.get().providers.reasoner;
store.recordProviderHealth('reasoner', {
  status: 'fail',
  checkedAt: '2026-07-17T21:00:39.857Z',
  compactError: 'Provider response reached its token ceiling.'
}, {
  configHash: providerConfigHash(before)
});
const after = store.get().providers.reasoner;

assertDeepEqual(
  providerConfiguration(after),
  providerConfiguration(before),
  'failed provider test cannot mutate provider configuration'
);
```

### Task 3: Make provider tests representative and single-flight

**Files:**

- Modify `src/runtime.mjs`
- Modify `src/providers.mjs`
- Modify `tools/scripts/test-runtime.mjs`
- Modify `tools/scripts/test-providers.mjs`

**Produces:**

```js
runtime.testProvider(lane)
runtime.providerOperationState()
```

- [ ] Add a Reasoner test fixture with `maxTokens: 8192` and assert the router
  receives `responseLength: 8192`.
- [ ] Add a test proving two simultaneous `testProvider('reasoner')` callers
  share one provider promise and make one model call.
- [ ] Add a test proving Provider Test returns `RECURSION_PROVIDER_BUSY` while
  an Editorial Reasoner operation is active.
- [ ] Add a test proving Provider Test no longer calls
  `supersedeActiveRun()`.
- [ ] Add a test where configuration changes during a provider call and assert
  the stale result does not update health.
- [ ] Run `node tools/scripts/test-runtime.mjs` and
  `node tools/scripts/test-providers.mjs`; confirm the new assertions fail.
- [ ] Implement runtime lane guards, configured-budget testing, and health-only
  settlement.
- [ ] Run both suites and require `[pass] runtime` and `[pass] providers`.

### Task 4: Replace all divergent Reasoner gates

**Files:**

- Modify `src/runtime.mjs`
- Modify `src/providers.mjs`
- Modify `src/ui/view-model.mjs`
- Modify `tools/scripts/test-runtime.mjs`
- Modify `tools/scripts/test-editorial-runtime.mjs`
- Modify `tools/scripts/test-ui.mjs`

- [ ] Add source assertions that
  `reasonerUnavailableReason`, `reasonerLaneAvailable`,
  `shouldAllowReasoner`, and production reads of
  `providers.reasoner.enabled` no longer exist.
- [ ] Add ordinary Medium/High/Ultra fixtures proving Utility fallback for
  `unconfigured`, `untested`, and `unhealthy`.
- [ ] Add ready fixtures proving existing Reasoning Level lane assignments are
  unchanged.
- [ ] Add Medium+ Redirect fixtures proving no diagnosis or writer call occurs
  when capability is not ready.
- [ ] Add a Low Redirect fixture proving Utility behavior is unchanged.
- [ ] Run the three focused suites and confirm failure.
- [ ] Replace every eligibility decision with
  `resolveProviderCapability()`.
- [ ] Run the suites and require all pass.

### Task 5: Move blocked Redirect handling before host generation

**Files:**

- Modify `src/runtime.mjs`
- Modify `src/progress.mjs`
- Modify `tools/scripts/test-runtime.mjs`
- Modify `tools/scripts/test-progress.mjs`

- [ ] Add a pending-turn test for Medium + Redirect + unhealthy Reasoner.
- [ ] Assert host generation continues.
- [ ] Assert the turn records one `editorialPreflight` warning before the host
  response.
- [ ] Assert no Editorial diagnosis, Transformer, or Verifier calls occur after
  the response.
- [ ] Assert the assistant message remains visible and unchanged.
- [ ] Assert the final state is `skipped`, not `error`.
- [ ] Assert no `RECURSION_REASONER_DISABLED` failure is produced.
- [ ] Run runtime and progress tests and confirm failure.
- [ ] Implement the operation-scoped preflight marker and post-generation skip.
- [ ] Run both suites and require pass.

Expected result:

```js
assertEqual(result.hostGenerationContinued, true, 'host generation continues');
assertEqual(result.editorial.status, 'skipped', 'blocked Redirect is skipped');
assertEqual(routerCalls.length, 0, 'blocked Redirect spends no provider calls');
assert(
  progress.steps.some((step) =>
    step.id === 'editorial-preflight'
    && step.state === 'warning'
    && step.reason.includes('Reasoner')
  ),
  'blocked Redirect explains readiness before generation'
);
```

### Task 6: Replace hidden enablement with capability UX

**Files:**

- Modify `src/ui.mjs`
- Modify `src/ui/view-model.mjs`
- Modify `styles/recursion.css`
- Modify `tools/scripts/test-ui.mjs`
- Modify `DESIGN.md`
- Modify `docs/design/UI_SPEC.md`

- [ ] Add a source assertion that hidden provider-enabled controls are absent.
- [ ] Assert the Reasoner header renders `Ready`, `Untested`, `Unhealthy`, or
  `Configure`.
- [ ] Assert a Medium+ unavailable Redirect row remains visible, is disabled,
  exposes its reason accessibly and visibly, and offers the correct action.
- [ ] Assert an unavailable Redirect click leaves the prior Enhancement mode
  unchanged.
- [ ] Assert Low permits Redirect regardless of Reasoner capability.
- [ ] Assert changing Max Tokens sends only `{ maxTokens }` and the expected
  revision.
- [ ] Assert changing Profile sends only `{ hostConnectionProfileId }`.
- [ ] Run `node tools/scripts/test-ui.mjs` and confirm failure.
- [ ] Implement field-scoped autosave and capability presentation while
  retaining the compact graphite-native design.
- [ ] Run the UI suite and require `[pass] ui`.

No new dashboard, modal, large warning card, or visible control label is
required. The change belongs in the existing provider header, readiness line,
Redirect row, and compact status.

### Task 7: Add provider capability mutation observability

**Files:**

- Modify `src/runtime.mjs`
- Modify `src/activity.mjs`
- Modify `src/storage.mjs`
- Modify `tools/scripts/test-activity.mjs`
- Modify `tools/scripts/test-storage.mjs`
- Modify `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`

- [ ] Add safe event tests for configuration and health transitions.
- [ ] Assert changed keys and state transitions are present.
- [ ] Assert profile IDs, endpoint URLs, keys, raw errors, prompts, responses,
  and reasoning are absent.
- [ ] Assert stale test results record a neutral diagnostic without changing
  capability.
- [ ] Run activity and storage tests and confirm failure.
- [ ] Implement the bounded journal event.
- [ ] Run both suites and require pass.

### Task 8: Enforce installed-copy identity

**Files:**

- Create `tools/scripts/verify-installed-copy.mjs`
- Create `tools/scripts/test-installed-copy-verifier.mjs`
- Modify `tools/scripts/run-tests.mjs`
- Modify `docs/testing/TESTING_STRATEGY.md`
- Modify `docs/testing/SILLYTAVERN_PLAYWRIGHT_HARNESS.md`

**Produces:**

```powershell
node tools\scripts\verify-installed-copy.mjs --user recursion-soak-a
node tools\scripts\verify-installed-copy.mjs --user default-user
```

- [ ] Define the production allowlist: `manifest.json`, `package.json`,
  production `src`, production `styles`, and required runtime assets.
- [ ] Add a fixture where repository and installed files match.
- [ ] Add missing, stale, extra-production-file, and public-copy mismatch
  fixtures.
- [ ] Assert mismatches produce a nonzero exit and exact relative paths.
- [ ] Run the verifier test and confirm failure because the script does not
  exist.
- [ ] Implement byte-for-byte SHA-256 comparison for repository, user
  extension, and public served extension.
- [ ] Register and run the test.
- [ ] Require installed-copy verification before every live proof.

The verifier must not inspect chats, user settings, secrets, or provider
payloads.

### Task 9: Update canonical contracts

**Files:**

- Modify `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- Modify `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify `docs/user/PROVIDER_SETUP.md`
- Modify `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify `docs/testing/TESTING_STRATEGY.md`
- Modify `docs/DOCUMENTATION_INDEX.md`
- Modify `docs/planning/README.md`

- [ ] Replace `enabled/disabled` provider language with capability-state
  language.
- [ ] Document ordinary Utility fallback versus strict Redirect readiness.
- [ ] Document field-scoped provider autosave and health/configuration
  separation.
- [ ] Document configured `8192` Provider Test behavior.
- [ ] Document pre-generation Redirect skip behavior.
- [ ] Link this fix-improvement document from the planning index and canonical
  documentation index.
- [ ] Search for obsolete contract language:

```powershell
rg -n "reasoner.*enabled|reasoner.*disabled|providers\.reasoner\.enabled|RECURSION_REASONER_DISABLED" docs src tools/scripts
```

- [ ] Review every remaining match and retain only historical release notes or
  explicit migration evidence.

## Deterministic Test Matrix

| Area | Required cases |
| --- | --- |
| Capability | Every state, every Reasoning Level, ordinary work, Redirect, Provider Test |
| Settings migration | Old `enabled: true`, old `enabled: false`, missing field, old `lastTest`, current health |
| Configuration writes | Every visible provider field, stale revision, unrelated-field preservation |
| Health writes | Pass, fail, stale hash, malformed result, no configuration mutation |
| Provider Test | Utility/Reasoner, `8192`, single-flight, busy lane, timeout, auth, length, malformed JSON, invalid schema |
| Runtime routing | Ordinary fallback, ready Reasoner routes, Low Redirect, blocked Medium+ Redirect |
| Concurrency | Active Redirect vs Provider Test, config edit during test, duplicate test callers |
| UI | Four capability labels, blocked Redirect reason/action, field-scoped patches, no hidden enable input |
| Journal | Config transition, health transition, stale result, redaction |
| Deployment | Matching tree, stale runtime, missing file, public-copy mismatch |

## Verification Process

### 1. Static contract checks

```powershell
git diff --check
rg -n "T[B]D|T[O]DO|PLACEH[O]LDER" docs/planning/2026-07-17-reasoner-capability-and-redirect-readiness-fix-improvement.md
rg -n "providers\.reasoner\.enabled|RECURSION_REASONER_DISABLED|hiddenCheckedControl" src tools/scripts
```

Expected:

- no whitespace errors;
- no placeholders in this document;
- no production reads of the obsolete Reasoner enabled state;
- no production `RECURSION_REASONER_DISABLED` settlement.

### 2. Focused suites

```powershell
node tools\scripts\test-provider-capability.mjs
node tools\scripts\test-settings.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-editorial-runtime.mjs
node tools\scripts\test-progress.mjs
node tools\scripts\test-ui.mjs
node tools\scripts\test-activity.mjs
node tools\scripts\test-storage.mjs
node tools\scripts\test-installed-copy-verifier.mjs
```

Expected: every script prints `[pass]`.

### 3. Full deterministic suite

```powershell
npm.cmd test
```

Expected: exit code `0` with every registered test script passing.

### 4. Install to dedicated soak user

Copy the exact tested repository state to
`data\recursion-soak-a\extensions\Recursion` using the existing safe deployment
allowlist. Do not copy repository metadata, tests, artifacts, temporary files,
or debug logs.

Then run:

```powershell
node tools\scripts\verify-installed-copy.mjs --user recursion-soak-a
```

Expected:

```text
[pass] repository, installed, and public Recursion production files match
```

### 5. Live provider-readiness proof

Against `recursion-soak-a`:

1. Configure Reasoner with the intended host connection profile.
2. Confirm Max Tokens displays `8192`.
3. Run Provider Test once.
4. Confirm one provider call occurs with effective max tokens `8192`.
5. Confirm capability changes `untested -> ready`.
6. Reload SillyTavern.
7. Confirm capability remains `ready`.
8. Change an unrelated provider field and confirm only that field changes,
   capability becomes `untested`, and configuration revision increments once.
9. Run Provider Test again and confirm readiness is restored.

The report stores only:

- lane;
- capability states;
- configuration revision;
- bounded configuration hash;
- effective max tokens;
- sanitized provider status/model labels;
- timestamps;
- served file hashes.

### 6. Live blocked-Redirect negative control

Against `recursion-soak-a`:

1. Configure Medium + Redirect.
2. Put Reasoner into `untested` or injected `unhealthy` state without changing
   its route.
3. Confirm Redirect is visibly unavailable before send.
4. Send a safe dedicated-user test turn.
5. Confirm host generation continues.
6. Confirm Redirect settles `skipped`, not `error`.
7. Confirm no Editorial provider calls occur.
8. Confirm the original response remains unchanged.
9. Confirm progress and journal contain the same sanitized readiness reason.

The negative control must exit nonzero if any
`RECURSION_REASONER_DISABLED` event appears.

### 7. Live SG-1-shaped Redirect success proof

Run:

```powershell
node tools\scripts\prove-live-enhancements.mjs --user recursion-soak-a --mode redirect
```

Required evidence:

- exact installed-copy verification passed before navigation;
- Reasoner capability was `ready` for the tested configuration hash;
- no Provider Test overlapped Editorial work;
- Medium+ Redirect used Reasoner Transformer and Reasoner Verifier;
- all expected calls used a ceiling no greater than configured `8192`;
- exactly one verified Recursion-owned swipe was added and selected;
- no unmatched provider starts;
- no warning/error journal entry remained unexplained;
- no hidden configuration mutation occurred;
- final capability remained `ready`.

### 8. Default-user deployment

Only after deterministic and dedicated-user live gates pass:

1. copy the exact certified production tree to `default-user`;
2. copy the same tree to the public served extension path;
3. run:

```powershell
node tools\scripts\verify-installed-copy.mjs --user default-user
```

4. reload SillyTavern;
5. inspect provider capability and configuration only;
6. do not run automated generation against `default-user`.

## Acceptance Criteria

The work is complete only when:

- `providers.reasoner.enabled` no longer exists in the active contract;
- no hidden provider-enable control exists;
- provider capability is derived by one shared resolver;
- a failed Provider Test cannot mutate provider configuration;
- stale form and stale test writes are rejected;
- Provider Test uses the configured `8192` default ceiling;
- Provider Test is single-flight and cannot overlap an active same-lane
  Editorial operation;
- ordinary Medium/High/Ultra work falls back to Utility when Reasoner is not
  ready;
- Medium+ Redirect never silently falls back to Utility;
- unavailable Medium+ Redirect is explained before host generation and settles
  as skipped rather than a post-generation critical error;
- every provider capability transition is safely observable;
- repository, installed, and public production files match before live proof;
- the exact SG-1-shaped dedicated-user regression passes through the real
  SillyTavern/provider path;
- focused tests and `npm.cmd test` pass.

## Superseded Behavior

This document supersedes the narrow behavior introduced by
`f59490a7 fix(redirect): preflight disabled reasoner`, where Medium+ Redirect
checks the hidden Boolean and returns:

```text
RECURSION_REASONER_DISABLED
```

The prior preflight may remain useful as historical evidence, but it is not the
target architecture. The replacement prevents invalid capability state from
being armed, uses one shared readiness contract, and preserves normal host
generation without spending Editorial calls.

## Post-Deployment UI Regression Addendum

The first `default-user` SG-1 verification exposed two presentation defects
after the provider-capability implementation was deployed:

1. The Reasoner Provider Test succeeded, the following normal generation used
   Reasoner successfully, and Redirect completed its Diagnostician,
   Transformer, and Verifier path and applied a verified swipe. Despite that
   runtime evidence, the already-mounted Redirect row still displayed its old
   unavailable description ending in `Test Reasoner below.` The readiness
   resolver was correct; `renderEnhancementsState()` overlaid unavailable copy
   but did not restore the row's canonical ARIA label, title, or card-evidence
   description after capability changed to `ready`.
2. Fused child rows retained routine reasons such as
   `Included in category generation.` The renderer inserted those reasons into
   every row, while CSS expanded height only for `warning` and `failed` rows.
   Completed child rows therefore kept their compact fixed height and allowed
   the reason text to overlap neighboring rows on mobile.

The permanent presentation contract is:

- every Enhancements render restores canonical option metadata before applying
  any state-specific unavailable overlay;
- a ready Redirect immediately restores
  `Uses card-evidence to replace a misaligned trajectory with a stronger,
  verified response.` and hides the Test Reasoner action;
- progress reasons remain in sanitized row metadata and tooltips;
- only `warning` and `failed` rows render a visible wrapped reason subline;
- routine completed, generated, included, and cached child rows remain compact.

Regression coverage must exercise state changes on the same mounted DOM nodes:

```js
unavailable Redirect -> ready Redirect
warning child with visible reason -> done child with tooltip-only reason
```

## Implementation Verification Record

Completed on 2026-07-17:

- all 36 deterministic test scripts passed through `npm.cmd test`;
- the installed-copy verifier matched 69 production files across the
  repository, `recursion-soak-a` installation, and public served copy;
- no-generation SillyTavern smoke passed with zero page errors and exact served
  extension hashes;
- the live Reasoner provider test used Max Tokens `8192`, reached `ready`, and
  remained `ready` after page reload;
- the SG-1-shaped Standard Redirect proof passed through the real
  SillyTavern/provider path with a ready Reasoner writer/verifier, all nine
  production verification checks passing, one validated Recursion-owned swipe,
  no unmatched provider calls, no unhealthy or unexplained journal transitions,
  and no private Redirect leakage;
- the live proof artifact is
  `artifacts/live-redirect/prove-live-enhancements-mrpk00fe-jmqtef`.

After the post-deployment UI regressions were fixed, the tested tree was copied
to the `default-user` installed extension and public served copy. The
installed-copy verifier matched all 69 production files. No automated provider
test or generation was run against `default-user` during this corrective
deployment.
