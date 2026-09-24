import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { createProviderClient, createGenerationRouter } from '../../src/providers.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { validateGuidanceStageResult, buildGuidanceCorrectionRequest } from '../../src/prompt.mjs';
import { hashJson } from '../../src/core.mjs';
import { classifyModelFailure } from '../../src/execution/attempt-policy.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const profile = { id: 'guidance-profile', name: 'Guidance', api: 'openai', model: 'controlled-model' };
let output;
let calls = 0;
const host = createSillyTavernHost({ contextFactory: () => ({
  ConnectionManagerRequestService: {
    getSupportedProfiles: () => [profile], getProfile: () => profile,
    validateProfile: () => ({ selected: 'openai', type: 'openai' }),
    async sendRequest() { calls++; return { choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }; }
  }
}), settingsRoot: {}, saveSettings() {} });
const settingsStore = createSettingsStore({ root: { recursion: { providers: {
  utility: { connectionProfileId: profile.id }, reasoner: { connectionProfileId: profile.id }
} } }, save() {} });
const router = createGenerationRouter({ client: createProviderClient({ host, settingsStore }) });
const request = { snapshotHash: hashJson({}), prompt: 'Compose grounded Guidance.', lane: 'reasoner' };
output = { guidanceText: 'Answer the immediate question.' };
const usable = await router.generate('guidanceComposer', request);
assertEqual(usable.ok, true, 'host/provider boundary accepts usable Guidance missing request-owned identifiers');
assertEqual(validateGuidanceStageResult(usable).ok, true, 'bound Guidance passes semantic validation');
assertEqual(calls, 1, 'bookkeeping normalization adds no provider call');
assertEqual(usable.diagnostics.semanticNormalization, 'guidance-request-envelope', 'local normalization is observable');

for (const invalid of [
  { guidanceText: 'Valid prose', schema: 'wrong.schema' },
  { guidanceText: 'Valid prose', snapshotHash: 'different-turn' },
  { guidanceText: '' },
  { guidanceText: { text: 'PRIVATE_RESPONSE_CANARY' } }
]) {
  output = invalid;
  const result = await router.generate('guidanceComposer', request);
  const validation = validateGuidanceStageResult(result);
  assert(!result.ok || !validation.ok, 'host boundary cannot accept conflicting or unusable Guidance');
  assert(!JSON.stringify(result.diagnostics).includes('PRIVATE_RESPONSE_CANARY'), 'structural diagnostics exclude returned prose');
}

// The previous failure included a real field-type mismatch. Correction must keep
// that safe structure instead of collapsing it into a generic schema message.
output = { guidanceText: { text: 'PRIVATE_RESPONSE_CANARY' } };
const invalid = await router.generate('guidanceComposer', request, { stageAttempt: 2 });
assertEqual(invalid.diagnostics.stageAttempt, 2, 'Guidance failure distinguishes scheduler correction attempts from router retry count');
const validation = validateGuidanceStageResult(invalid);
assert(classifyModelFailure(validation.error, { kind: 'validation' }).message.includes('guidanceText:object'), 'durable failure summary preserves safe structural reason');
const corrected = buildGuidanceCorrectionRequest({ request, failure: validation.error });
assert(corrected.prompt.includes('guidanceText:object'), 'correction identifies the returned Guidance field type');
assert(!corrected.prompt.includes('PRIVATE_RESPONSE_CANARY'), 'correction excludes rejected provider prose');
console.log('[pass] Guidance host contract');
