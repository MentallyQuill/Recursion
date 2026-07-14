import {
  REASONER_ROLE_IDS,
  UTILITY_ROLE_IDS,
  createGenerationRouter,
  createProviderClient,
  fetchOpenAICompatibleModels,
  listProviderConnectionProfiles,
  machineJsonSchemaForRequest,
  parseStructuredOutput,
  providerModelStatus,
  providerRouteSummary,
  validateProviderConfiguration,
  roleLane
} from '../../src/providers.mjs';
import { readFileSync } from 'node:fs';
import { createActivityReporter } from '../../src/activity.mjs';
import { createSessionSecretStore, createSettingsStore } from '../../src/settings.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

function createStore() {
  return createSettingsStore({ root: {}, secretStore: createSessionSecretStore() });
}

function assertNoSecret(value, message) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes('sk-live-secret'), message);
  assert(!serialized.includes('session-key'), message);
  assert(!serialized.includes('Bearer'), message);
}

function assertNoRawBatchMarker(value, message) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes('RAW_BATCH'), message);
}

function assertNoProviderMarker(value, marker, message) {
  assert(!JSON.stringify(value).includes(marker), message);
}

function responseSchemaForRole(roleId) {
  if (roleId === 'reasonerComposer') return 'recursion.reasonerComposer.v1';
  if (roleId === 'utilityArbiter') return 'recursion.utilityArbiter.v1';
  if (roleId === 'rapidTurnDelta') return 'recursion.rapidTurnDelta.v2';
  if (roleId === 'guidanceComposer') return 'recursion.guidanceComposer.v1';
  if (roleId === 'cardAuthoringAssist') return 'recursion.cardAuthoringAssist.v1';
  if (roleId === 'generationReviewer') return 'recursion.generationReview.v1';
  if (roleId === 'editorialDiagnostician') return 'recursion.editorialDiagnosis.v1';
  if (roleId === 'editorialTransformer') return 'recursion.editorialPass.v1';
  if (roleId === 'editorialVerifier') return 'recursion.editorialVerification.v1';
  if (roleId === 'fusedCardBundle') return 'recursion.cardBundle.v1';
  if (roleId === 'providerTest') return 'recursion.providerTest.v1';
  return 'recursion.card.v1';
}

function responseTextForRole(roleId, fields = {}) {
  return JSON.stringify({ schema: responseSchemaForRole(roleId), ok: true, ...fields });
}

async function flushMicrotasks(count = 6) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

assertEqual(parseStructuredOutput('```json\n{"schema":"x"}\n```').schema, 'x', 'structured parser accepts fenced json');
assertEqual(parseStructuredOutput('Here is the JSON:\n{"schema":"x","ok":true}\nDone.').schema, 'x', 'structured parser extracts a JSON object from wrapper prose');
assertEqual(roleLane('unknownRole'), '', 'unknown roles have no provider lane');
assertEqual(roleLane('reasonerComposer'), 'reasoner', 'reasonerComposer uses reasoner lane');
const expectedUtilityRoles = [
  'utilityArbiter',
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'socialSubtextCard',
  'sceneConstraintsCard',
  'knowledgeSecretsCard',
  'clocksConsequencesCard',
  'environmentAffordancesCard',
  'possessionsItemsCard',
  'openThreadsCard',
  'fusedCardBundle',
  'rapidTurnDelta',
  'guidanceComposer',
  'cardAuthoringAssist',
  'generationReviewer',
  'editorialDiagnostician',
  'editorialTransformer',
  'editorialVerifier',
  'providerTest'
];
assertDeepEqual(UTILITY_ROLE_IDS, expectedUtilityRoles, 'utility role catalog exactly matches Task 6 plan');
assert(!UTILITY_ROLE_IDS.includes('briefUtilityComposer'), 'old brief utility composer role is removed');
assertDeepEqual(REASONER_ROLE_IDS, ['reasonerComposer'], 'reasoner role catalog exactly matches Task 6 plan');
for (const utilityRole of expectedUtilityRoles) {
  assertEqual(roleLane(utilityRole), 'utility', `${utilityRole} uses utility lane`);
}
const providerSpec = readFileSync(new URL('../../docs/architecture/PROVIDER_AND_GENERATION_SPEC.md', import.meta.url), 'utf8');
for (const utilityRole of expectedUtilityRoles) {
  assert(providerSpec.includes(`\`${utilityRole}\``), `provider spec documents ${utilityRole}`);
}
assert(providerSpec.includes('`reasonerComposer`'), 'provider spec documents reasonerComposer');
assert(!/characterLensCard|environmentTextureCard/.test(providerSpec), 'provider spec omits legacy card role names');

const delegatedProfiles = [
  { id: 'ctx-utility', name: 'Context Utility', label: 'Context Utility / glm-fast', model: 'glm-fast' }
];
assertDeepEqual(
  listProviderConnectionProfiles({ host: { providerProfiles: { list: () => delegatedProfiles } } }),
  delegatedProfiles,
  'provider core delegates connection profile listing to host capability'
);
assertDeepEqual(
  listProviderConnectionProfiles({ listConnectionProfiles: () => delegatedProfiles }),
  delegatedProfiles,
  'provider core supports explicit profile-list callback'
);
assertDeepEqual(
  listProviderConnectionProfiles({}),
  [],
  'provider core returns empty profiles without host discovery capability'
);

const profileStatus = providerModelStatus({
  lane: 'utility',
  source: 'host-connection-profile',
  hostConnectionProfileId: 'ctx-utility'
}, {
  host: { providerProfiles: { list: () => delegatedProfiles } }
});
assertEqual(profileStatus.ready, true, 'provider status reports selected connection profile ready');
assertEqual(profileStatus.model, 'glm-fast', 'provider status resolves connection profile model');
assertEqual(profileStatus.label, 'Context Utility / glm-fast', 'provider status exposes readable profile/model label');

const currentHostStatus = providerModelStatus({
  lane: 'utility',
  source: 'host-current-model'
}, {
  globals: {
    power_user: { model: 'gpt-4-turbo' }
  }
});
assertEqual(currentHostStatus.ready, true, 'current host provider status is ready when host model is detected');
assertEqual(currentHostStatus.model, 'gpt-4-turbo', 'current host provider status keeps the host model as model metadata');
assertEqual(currentHostStatus.label, 'Current Host Model', 'current host provider status does not present the model as provider identity');

const directValidation = validateProviderConfiguration({
  source: 'openai-compatible',
  openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
  maxTokens: 4096
});
assertEqual(directValidation.ready, false, 'OpenAI-compatible validation catches missing setup');
assertDeepEqual(
  directValidation.missing,
  ['baseUrl', 'model', 'sessionApiKey'],
  'OpenAI-compatible validation names missing setup fields'
);

const routeSummary = providerRouteSummary({
  reasoningLevel: 'high',
  providers: {
    reasoner: { enabled: true, lastTest: { status: 'pass' } }
  }
});
assertEqual(routeSummary.level, 'high', 'provider route summary tracks reasoning level');
assert(routeSummary.text.includes('Arbiter: Reasoner'), 'provider route summary exposes Reasoner Arbiter route');
assert(routeSummary.text.includes('Composer: Reasoner'), 'provider route summary exposes Reasoner composer route');

const modelFetchCalls = [];
const fetchedModels = await fetchOpenAICompatibleModels({
  baseUrl: 'https://models.example/v1/chat/completions',
  apiKey: 'sk-live-secret',
  fetchImpl: async (url, init = {}) => {
    modelFetchCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            { id: 'alpha-model', name: 'Alpha Model' },
            { id: 'beta-model' }
          ]
        };
      }
    };
  }
});
assertDeepEqual(
  fetchedModels.models.map((model) => [model.id, model.label]),
  [
    ['alpha-model', 'Alpha Model'],
    ['beta-model', 'beta-model']
  ],
  'OpenAI-compatible model fetch parses /models data'
);
assertEqual(modelFetchCalls[0].url, 'https://models.example/v1/models', 'OpenAI-compatible model fetch normalizes endpoint to /models');
assertEqual(modelFetchCalls[0].init.method, 'GET', 'OpenAI-compatible model fetch uses GET');
assertEqual(modelFetchCalls[0].init.headers.Authorization, 'Bearer sk-live-secret', 'OpenAI-compatible model fetch sends session bearer key');
assertNoSecret(fetchedModels, 'OpenAI-compatible model fetch result does not expose session secret');

const calls = [];
const host = {
  generation: {
    async generate(request) {
      calls.push(request);
      return { text: responseTextForRole(request.roleId), providerId: 'fake-host', model: 'fake-model' };
    },
    async batch(requests) {
      return Promise.all(requests.map((request) => this.generate(request)));
    }
  }
};
const store = createStore();
const client = createProviderClient({ host, settingsStore: store });
const router = createGenerationRouter({ client });
const result = await router.generate('utilityArbiter', { prompt: 'Return JSON' });
assertEqual(result.ok, true, 'generation succeeds');
assertEqual(result.data.ok, true, 'json data parsed');
assertEqual(result.diagnostics.timeoutMs, 120000, 'default provider timeout allows slow live connection profiles');
assertEqual(calls[0].lane, 'utility', 'utility lane selected');
assertEqual(calls[0].roleId, 'utilityArbiter', 'role id passed to host');
assertEqual(calls[0].providerSource, 'host-current-model', 'provider source passed to host');
assertEqual(calls[0].responseSchema, 'recursion.utilityArbiter.v1', 'provider request carries expected response schema');
assertEqual(calls[0].machineJson, true, 'provider request marks machine JSON calls');
await router.generate('rapidTurnDelta', { prompt: 'Rapid delta' });
assertEqual(calls.at(-1).lane, 'utility', 'rapidTurnDelta uses utility lane');
assertEqual(calls.at(-1).responseSchema, 'recursion.rapidTurnDelta.v2', 'rapidTurnDelta request carries expected response schema');
await router.generate('guidanceComposer', { prompt: 'Guidance composer' });
assertEqual(calls.at(-1).lane, 'utility', 'guidanceComposer uses utility lane');
assertEqual(calls.at(-1).responseSchema, 'recursion.guidanceComposer.v1', 'guidanceComposer request carries expected response schema');
await router.generate('cardAuthoringAssist', { prompt: 'Card authoring assist' });
assertEqual(calls.at(-1).lane, 'utility', 'cardAuthoringAssist uses utility lane');
assertEqual(calls.at(-1).responseSchema, 'recursion.cardAuthoringAssist.v1', 'cardAuthoringAssist request carries expected response schema');
await router.generate('generationReviewer', { prompt: 'Generation review' });
assertEqual(calls.at(-1).lane, 'utility', 'generationReviewer uses utility lane');
assertEqual(calls.at(-1).responseSchema, 'recursion.generationReview.v1', 'generationReviewer request carries expected response schema');
await router.generate('editorialDiagnostician', { prompt: 'Editorial diagnosis' });
assertEqual(calls.at(-1).lane, 'utility', 'editorialDiagnostician uses utility lane by default');
assertEqual(calls.at(-1).responseSchema, 'recursion.editorialDiagnosis.v1', 'editorialDiagnostician request carries diagnosis schema');
await router.generate('editorialTransformer', { prompt: 'Editorial transform' });
assertEqual(calls.at(-1).responseSchema, 'recursion.editorialPass.v1', 'editorialTransformer request carries pass schema');
await router.generate('editorialVerifier', { prompt: 'Editorial verify' });
assertEqual(calls.at(-1).responseSchema, 'recursion.editorialVerification.v1', 'editorialVerifier request carries verifier schema');
await router.generate('fusedCardBundle', { prompt: 'Fused card bundle', snapshotHash: 'fused-provider-hash' });
assertEqual(calls.at(-1).lane, 'utility', 'fusedCardBundle uses utility lane by default');
assertEqual(calls.at(-1).responseSchema, 'recursion.cardBundle.v1', 'fusedCardBundle request carries card-bundle response schema');
assertEqual(calls.at(-1).machineJson, true, 'fusedCardBundle request marks machine JSON calls');
assertEqual(machineJsonSchemaForRequest(calls.at(-1)).schema.properties.schema.const, 'recursion.cardBundle.v1', 'fusedCardBundle machine schema constrains bundle schema');

const editorialDiagnosisMachineSchema = machineJsonSchemaForRequest({
  responseSchema: 'recursion.editorialDiagnosis.v1',
  machineJson: true,
  mode: 'recompose',
  sourceHash: 'editorial-source-hash',
  snapshotHash: 'editorial-snapshot-hash',
  validEvidenceIds: ['user:0', 'message:17', 'source:0'],
  validPreservationEvidenceIds: ['user:0', 'message:17']
});
assertDeepEqual(
  editorialDiagnosisMachineSchema.schema.required,
  ['schema', 'mode', 'sourceHash', 'snapshotHash', 'decision', 'brief'],
  'Editorial diagnosis machine schema requires the semantic identity and decision envelope'
);
assertEqual(editorialDiagnosisMachineSchema.schema.properties.sourceHash.const, 'editorial-source-hash', 'Editorial diagnosis machine schema freezes source identity');
assertEqual(editorialDiagnosisMachineSchema.schema.properties.snapshotHash.const, 'editorial-snapshot-hash', 'Editorial diagnosis machine schema freezes snapshot identity');
assertEqual(editorialDiagnosisMachineSchema.schema.properties.mode.const, 'recompose', 'Editorial diagnosis machine schema freezes selected mode');
assertDeepEqual(
  editorialDiagnosisMachineSchema.schema.properties.brief.required,
  ['mode', 'diagnosis', 'preserve', 'discard', 'allowedChanges', 'forbiddenChanges'],
  'Editorial diagnosis machine schema requires the complete validated brief'
);
assertDeepEqual(
  editorialDiagnosisMachineSchema.schema.properties.brief.properties.preserve.items.properties.evidenceRefs.items.enum,
  ['user:0', 'message:17'],
  'Editorial diagnosis machine schema excludes source-draft evidence from preservation claims'
);
assertDeepEqual(
  editorialDiagnosisMachineSchema.schema.properties.brief.properties.discard.items.properties.evidenceRefs.items.enum,
  ['user:0', 'message:17', 'source:0'],
  'Editorial diagnosis machine schema keeps source-draft evidence available to discard claims'
);
const editorialPassMachineSchema = machineJsonSchemaForRequest({
  responseSchema: 'recursion.editorialPass.v1',
  machineJson: true,
  mode: 'recompose',
  sourceHash: 'editorial-source-hash',
  snapshotHash: 'editorial-snapshot-hash',
  diagnosisHash: 'editorial-diagnosis-hash',
  validEvidenceIds: ['user:0', 'message:17', 'source:0'],
  validPreservationEvidenceIds: ['user:0', 'message:17'],
  installedCardIds: ['card-a', 'card-b']
});
assertDeepEqual(editorialPassMachineSchema.schema.properties.cardOutcomes.items.properties.cardId.enum, ['card-a', 'card-b'], 'Editorial pass machine schema constrains card outcomes to the frozen installed hand');
assertDeepEqual(editorialPassMachineSchema.schema.properties.cardOutcomes.items.properties.evidenceRefs.items.enum, ['user:0', 'message:17', 'source:0'], 'Editorial pass machine schema constrains outcome evidence to frozen ids');
assertDeepEqual(editorialPassMachineSchema.schema.properties.candidate.required, ['text', 'preservationLedger', 'changeLedger', 'riskFlags'], 'Editorial full-candidate schema requires every semantically validated field');
assertDeepEqual(editorialPassMachineSchema.schema.properties.candidate.properties.preservationLedger.items.properties.evidenceRefs.items.enum, ['user:0', 'message:17'], 'Editorial candidate schema excludes source-draft evidence from preservation claims');
const editorialVerifierMachineSchema = machineJsonSchemaForRequest({
  responseSchema: 'recursion.editorialVerification.v1',
  machineJson: true,
  sourceHash: 'editorial-source-hash',
  snapshotHash: 'editorial-snapshot-hash',
  diagnosisHash: 'editorial-diagnosis-hash',
  validEvidenceIds: ['user:0', 'message:17']
});
assertDeepEqual(
  editorialVerifierMachineSchema.schema.required,
  ['schema', 'sourceHash', 'snapshotHash', 'diagnosisHash', 'decision'],
  'Editorial verifier machine schema requires the candidate identity and decision envelope'
);
assertDeepEqual(editorialVerifierMachineSchema.schema.properties.evidenceRefs.items.enum, ['user:0', 'message:17'], 'Editorial verifier constrains optional evidence references to frozen ids');

const editorialIdentityRouter = createGenerationRouter({
  client: {
    async generate(roleId) {
      const shared = {
        schema: responseSchemaForRole(roleId),
        sourceHash: 'model-authored-source-hash',
        snapshotHash: 'model-authored-snapshot-hash'
      };
      if (roleId === 'editorialDiagnostician') {
        return {
          text: JSON.stringify({
            ...shared,
            mode: 'redirect',
            decision: 'proceed',
            brief: {
              mode: 'recompose',
              diagnosis: [],
              preserve: [],
              discard: [],
              allowedChanges: [],
              forbiddenChanges: []
            }
          })
        };
      }
      if (roleId === 'editorialTransformer') {
        return {
          text: JSON.stringify({
            ...shared,
            mode: 'redirect',
            diagnosisHash: 'model-authored-diagnosis-hash',
            cardOutcomes: [],
            candidate: {
              text: 'Recomposed candidate.',
              preservationLedger: [],
              changeLedger: [],
              riskFlags: []
            }
          })
        };
      }
      return {
        text: JSON.stringify({
          ...shared,
          diagnosisHash: 'model-authored-diagnosis-hash',
          decision: 'accept'
        })
      };
    }
  }
});
const trustedEditorialIdentity = {
  mode: 'recompose',
  sourceHash: 'trusted-source-hash',
  snapshotHash: 'trusted-snapshot-hash',
  diagnosisHash: 'trusted-diagnosis-hash'
};
const normalizedDiagnosis = await editorialIdentityRouter.generate('editorialDiagnostician', trustedEditorialIdentity);
assertEqual(normalizedDiagnosis.data.mode, trustedEditorialIdentity.mode, 'Editorial diagnosis mode comes from the frozen request');
assertEqual(normalizedDiagnosis.data.sourceHash, trustedEditorialIdentity.sourceHash, 'Editorial diagnosis source identity comes from the frozen request');
assertEqual(normalizedDiagnosis.data.snapshotHash, trustedEditorialIdentity.snapshotHash, 'Editorial diagnosis snapshot identity comes from the frozen request');
const normalizedTransform = await editorialIdentityRouter.generate('editorialTransformer', trustedEditorialIdentity);
assertEqual(normalizedTransform.data.mode, trustedEditorialIdentity.mode, 'Editorial transform mode comes from the frozen request');
assertEqual(normalizedTransform.data.sourceHash, trustedEditorialIdentity.sourceHash, 'Editorial transform source identity comes from the frozen request');
assertEqual(normalizedTransform.data.snapshotHash, trustedEditorialIdentity.snapshotHash, 'Editorial transform snapshot identity comes from the frozen request');
assertEqual(normalizedTransform.data.diagnosisHash, trustedEditorialIdentity.diagnosisHash, 'Editorial transform diagnosis identity comes from the frozen request');
const normalizedVerification = await editorialIdentityRouter.generate('editorialVerifier', trustedEditorialIdentity);
assertEqual(normalizedVerification.data.sourceHash, trustedEditorialIdentity.sourceHash, 'Editorial verification source identity comes from the frozen request');
assertEqual(normalizedVerification.data.snapshotHash, trustedEditorialIdentity.snapshotHash, 'Editorial verification snapshot identity comes from the frozen request');
assertEqual(normalizedVerification.data.diagnosisHash, trustedEditorialIdentity.diagnosisHash, 'Editorial verification diagnosis identity comes from the frozen request');

const generationReviewMachineSchema = machineJsonSchemaForRequest({
  responseSchema: 'recursion.generationReview.v1',
  machineJson: true,
  sourceHash: 'review-source-hash',
  validTargetIds: ['dialogue:1', 'prose:2'],
  installedCardIds: ['room-boundary']
});
assert(generationReviewMachineSchema.schema.required.includes('sourceHash'), 'generation review machine schema requires its frozen source hash');
assert(generationReviewMachineSchema.schema.required.includes('cardOutcomes'), 'generation review machine schema requires the card-outcome ledger');
assert(generationReviewMachineSchema.schema.required.includes('patches'), 'generation review machine schema requires the bounded patch list');
assertDeepEqual(generationReviewMachineSchema.schema.properties.cardOutcomes.items.properties.status.enum, ['honored', 'repaired', 'not-applicable', 'partially-reflected', 'violated', 'requires-regeneration'], 'generation review machine schema constrains card-outcome status values');
assertDeepEqual(generationReviewMachineSchema.schema.properties.cardOutcomes.items.properties.cardId.enum, ['room-boundary'], 'generation review machine schema constrains outcomes to installed cards');
assertDeepEqual(generationReviewMachineSchema.schema.properties.cardOutcomes.items.properties.evidenceTargetIds.items.enum, ['dialogue:1', 'prose:2'], 'generation review machine schema constrains evidence to frozen targets');
assertDeepEqual(generationReviewMachineSchema.schema.properties.patches.items.properties.id.enum, ['dialogue:1', 'prose:2'], 'generation review machine schema constrains patches to frozen targets');

const rawReviewRouter = createGenerationRouter({
  client: {
    async generate() {
      return {
        text: 'Mara crossed the room and stopped at the handle.',
        providerId: 'fake-host',
        model: 'fake-model'
      };
    }
  }
});
const rawReviewResult = await rawReviewRouter.generate('generationReviewer', { prompt: 'Return a patch ledger.' });
assertEqual(rawReviewResult.ok, false, 'generationReviewer rejects raw text because a patch ledger is required');
assertEqual(rawReviewResult.error.code, 'RECURSION_JSON_PARSE_FAILED', 'generationReviewer raw text has a stable parse error');

store.update({ reasonerUse: 'always' });
store.updateProvider('reasoner', { enabled: true });
const reasoner = await router.generate('reasonerComposer', { prompt: 'Reason' });
assertEqual(reasoner.ok, true, 'reasoner route succeeds');
assertEqual(calls.at(-1).lane, 'reasoner', 'reasoner lane selected');

const utilityOverride = await router.generate('reasonerComposer', { lane: 'utility', prompt: 'Use utility override' });
assertEqual(utilityOverride.ok, true, 'reasoner role can be explicitly routed to utility');
assertEqual(calls.at(-1).lane, 'utility', 'explicit utility lane override applied');

const callsBeforeUnknownRole = calls.length;
const unknownRole = await router.generate('unknownRole', { lane: 'utility', prompt: 'Do not route unknown roles.' });
assertEqual(unknownRole.ok, false, 'unknown provider role fails');
assertEqual(unknownRole.error.code, 'RECURSION_PROVIDER_ROLE_UNSUPPORTED', 'unknown provider role uses stable error code');
assertEqual(calls.length, callsBeforeUnknownRole, 'unknown provider role does not call host generation');

const batchCallsBeforeUnknownRole = calls.length;
const unknownRoleBatch = await router.batch([
  { roleId: 'utilityArbiter', prompt: 'Known role still runs.' },
  { roleId: 'unknownRole', prompt: 'Unknown role should fail.' }
]);
assertEqual(unknownRoleBatch[0].ok, true, 'batch with unknown role keeps known slot successful');
assertEqual(unknownRoleBatch[1].ok, false, 'batch with unknown role fails unknown slot');
assertEqual(unknownRoleBatch[1].error.code, 'RECURSION_PROVIDER_ROLE_UNSUPPORTED', 'batch unknown role uses stable error code');
assertEqual(calls.length, batchCallsBeforeUnknownRole + 1, 'batch unknown role does not call host for unknown slot');

const batchCallsBeforeMalformedEntry = calls.length;
const malformedEntryBatch = await router.batch([
  { roleId: 'utilityArbiter', prompt: 'Known role still runs after malformed sibling.' },
  null,
  { prompt: 'Missing role should fail without aborting sibling slots.' }
], { runId: 'provider-batch-malformed-entry' });
assertEqual(malformedEntryBatch[0].ok, true, 'batch with malformed entry keeps known slot successful');
assertEqual(malformedEntryBatch[1].ok, false, 'batch with malformed entry fails only malformed slot');
assertEqual(malformedEntryBatch[1].error.code, 'RECURSION_PROVIDER_REQUEST_INVALID', 'batch malformed entry uses stable error code');
assertEqual(malformedEntryBatch[2].ok, false, 'batch with missing role fails only missing-role slot');
assertEqual(malformedEntryBatch[2].error.code, 'RECURSION_PROVIDER_ROLE_MISSING', 'batch missing role uses stable error code');
assertEqual(calls.length, batchCallsBeforeMalformedEntry + 1, 'batch malformed entries do not call host');
assertDeepEqual(
  malformedEntryBatch.map((entry) => entry.diagnostics.runId),
  ['provider-batch-malformed-entry', 'provider-batch-malformed-entry', 'provider-batch-malformed-entry'],
  'batch malformed-entry diagnostics keep shared run id'
);

const wrongSchemaRouter = createGenerationRouter({
  client: {
    async generate() {
      return { text: '{"schema":"wrong.schema","ok":true}', providerId: 'fake-host', model: 'fake-model' };
    },
    async batch(requests) {
      return requests.map((request) => ({
        text: request.roleId === 'utilityArbiter'
          ? '{"schema":"recursion.utilityArbiter.v1","snapshotHash":"hash-ok"}'
          : '{"schema":"wrong.schema","ok":true}',
        providerId: 'fake-host',
        model: 'fake-model'
      }));
    }
  }
});
const wrongSchema = await wrongSchemaRouter.generate('providerTest', { prompt: 'Wrong schema.' });
assertEqual(wrongSchema.ok, false, 'known provider role rejects mismatched schema');
assertEqual(wrongSchema.error.code, 'RECURSION_PROVIDER_SCHEMA_MISMATCH', 'known provider role schema mismatch uses stable error code');
assertEqual(wrongSchema.error.actualSchema, 'wrong.schema', 'schema mismatch exposes the returned schema name without raw provider text');
assertDeepEqual(wrongSchema.error.responseFields, ['ok', 'schema'], 'schema mismatch exposes only safe top-level response keys for diagnosis');
const wrongSchemaBatch = await wrongSchemaRouter.batch([
  { roleId: 'utilityArbiter', prompt: 'Known valid schema.' },
  { roleId: 'providerTest', prompt: 'Known wrong schema.' }
]);
assertEqual(wrongSchemaBatch[0].ok, true, 'batch schema validation keeps valid slot successful');
assertEqual(wrongSchemaBatch[1].ok, false, 'batch schema validation fails wrong-schema slot');
assertEqual(wrongSchemaBatch[1].error.code, 'RECURSION_PROVIDER_SCHEMA_MISMATCH', 'batch wrong-schema slot uses stable error code');

const schemaOmittedReviewRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          return {
            text: JSON.stringify({
              cardOutcomes: [],
              patches: []
            }),
            providerId: 'fake-host',
            model: 'fake-model'
          };
        }
      }
    },
    settingsStore: createStore()
  })
});
const schemaOmittedReview = await schemaOmittedReviewRouter.generate('generationReviewer', {
  prompt: 'Return the reviewer result.',
  sourceHash: 'review-source-hash'
});
assertEqual(schemaOmittedReview.ok, true, 'generation reviewer recovers a complete response that only omits its schema envelope');
assertEqual(schemaOmittedReview.data.schema, 'recursion.generationReview.v1', 'generation reviewer normalizes the omitted schema from its requested contract');
assertEqual(schemaOmittedReview.data.sourceHash, 'review-source-hash', 'generation reviewer normalizes an omitted immutable source hash from its request');
assertDeepEqual(schemaOmittedReview.data.assessment, {}, 'generation reviewer supplies an empty assessment when the provider omits optional display metadata');

const staleReviewRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          return {
            text: JSON.stringify({
              sourceHash: 'wrong-source-hash',
              cardOutcomes: [],
              patches: []
            }),
            providerId: 'fake-host',
            model: 'fake-model'
          };
        }
      }
    },
    settingsStore: createStore()
  })
});
const staleReview = await staleReviewRouter.generate('generationReviewer', {
  prompt: 'Return the reviewer result.',
  sourceHash: 'review-source-hash'
});
assertEqual(staleReview.ok, false, 'generation reviewer does not normalize a nonempty wrong source hash');
assertEqual(staleReview.error.code, 'RECURSION_PROVIDER_SCHEMA_MISMATCH', 'wrong reviewer source remains a provider schema failure before patch application');

const disabledReasonerProviderTestCalls = [];
const disabledReasonerProviderTestStore = createStore();
disabledReasonerProviderTestStore.updateProvider('reasoner', {
  enabled: false,
  source: 'host-connection-profile',
  hostConnectionProfileId: 'reasoner-profile'
});
const disabledReasonerProviderTestRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate(request) {
          disabledReasonerProviderTestCalls.push(request);
          return {
            text: responseTextForRole(request.roleId),
            providerId: 'deepseek',
            model: 'deepseek-v4-pro'
          };
        }
      }
    },
    settingsStore: disabledReasonerProviderTestStore
  })
});
const disabledReasonerProviderTest = await disabledReasonerProviderTestRouter.generate('providerTest', {
  lane: 'reasoner',
  prompt: 'Reasoner provider test while lane is disabled.'
});
assertEqual(disabledReasonerProviderTest.ok, true, 'provider test can validate a configured disabled Reasoner lane');
assertEqual(disabledReasonerProviderTestCalls.length, 1, 'disabled Reasoner provider test calls host once');
assertEqual(disabledReasonerProviderTestCalls[0].lane, 'reasoner', 'disabled Reasoner provider test keeps the requested lane');
assertEqual(disabledReasonerProviderTestCalls[0].roleId, 'providerTest', 'disabled Reasoner provider test keeps providerTest role');
assertEqual(disabledReasonerProviderTestCalls[0].providerSource, 'host-connection-profile', 'disabled Reasoner provider test uses selected Reasoner provider source');

const reasonerOverrideStore = createStore();
const reasonerOverrideRouter = createGenerationRouter({
  client: createProviderClient({ host, settingsStore: reasonerOverrideStore })
});
const disabledLaneOverride = await reasonerOverrideRouter.generate('utilityArbiter', { lane: 'reasoner', prompt: 'Disabled reasoner override' });
assertEqual(disabledLaneOverride.ok, false, 'utility role cannot use disabled reasoner lane');
assertEqual(disabledLaneOverride.error.code, 'RECURSION_REASONER_DISABLED', 'disabled lane override exposes reasoner disabled code');
reasonerOverrideStore.update({ reasonerUse: 'always' });
reasonerOverrideStore.updateProvider('reasoner', { enabled: true });
const enabledLaneOverride = await reasonerOverrideRouter.generate('utilityArbiter', { lane: 'reasoner', prompt: 'Enabled reasoner override' });
assertEqual(enabledLaneOverride.ok, true, 'utility role can use enabled explicit reasoner lane');
assertEqual(calls.at(-1).lane, 'reasoner', 'explicit reasoner lane override applied when enabled');

const malformedHost = {
  generation: {
    async generate() {
      return { text: 'not-json', providerId: 'fake-host', model: 'fake-model' };
    }
  }
};
const malformedStore = createStore();
const malformedRouter = createGenerationRouter({
  client: createProviderClient({ host: malformedHost, settingsStore: malformedStore })
});
const malformed = await malformedRouter.generate('utilityArbiter', { prompt: 'Return bad JSON' });
assertEqual(malformed.ok, false, 'malformed json returns failure result');
assertEqual(malformed.error.code, 'RECURSION_JSON_PARSE_FAILED', 'malformed json exposes useful parse code');

const fusedRecoverableText = '{"schema":"recursion.cardBundle.v1","snapshotHash":"snapshot-fused-1","items":[{"schema":"recursion.card.v1","family":"Scene Frame","role":"sceneFrameCard","promptText":"FUSED_FRAGMENT_RECOVERED_SCENE survives truncation.","evidenceRefs":["message:8"]},{"schema":"recursion.card.v1","family":"Scene Constraints","role":"sceneConstraintsCard","promptText":"unfinished"';
const fusedMalformedRouter = createGenerationRouter({
  client: {
    async generate() {
      return { text: fusedRecoverableText, providerId: 'fake-host', model: 'fake-model' };
    }
  }
});
const fusedMalformed = await fusedMalformedRouter.generate('fusedCardBundle', {
  prompt: 'Return malformed fused JSON.',
  snapshotHash: 'snapshot-fused-1'
});
assertEqual(fusedMalformed.ok, false, 'malformed fused bundle returns failure result');
assert(fusedMalformed.recoverableText.includes('FUSED_FRAGMENT_RECOVERED_SCENE'), 'malformed fused bundle exposes bounded recoverable text');
assert(fusedMalformed.recoverableText.length <= 12000, 'malformed fused recoverable text is bounded');

const repairedMarker = 'RAW_REPAIRED_PROVIDER_TEXT';
const repairedActivity = createActivityReporter();
const repairedJournal = [];
const repairedRouter = createGenerationRouter({
  client: {
    async generate() {
      return {
        text: `Here is the JSON ${repairedMarker}:
\`\`\`json
{
  // provider comment
  "schema": "recursion.utilityArbiter.v1",
  "ok": true,
}
\`\`\``,
        providerId: 'fake-host',
        model: 'fake-model'
      };
    }
  },
  activity: repairedActivity,
  journal: { append: (entry) => repairedJournal.push(entry) }
});
const repairedRouterResult = await repairedRouter.generate('utilityArbiter', { prompt: 'Repair JSON.' });
assertEqual(repairedRouterResult.ok, true, 'router accepts safely repaired provider json');
assertEqual(repairedRouterResult.diagnostics.structuredOutputRepaired, true, 'router diagnostics record repaired structured output');
assertEqual(repairedRouterResult.diagnostics.structuredOutputRepairCode, 'json_repaired', 'router diagnostics record compact repair code');
assertEqual(typeof repairedRouterResult.diagnostics.visibleContentLength, 'number', 'router diagnostics record visible content length');
assertNoProviderMarker(repairedRouterResult, repairedMarker, 'repaired result does not expose raw malformed provider text');
assertNoProviderMarker(repairedActivity.history(), repairedMarker, 'repaired activity does not expose raw malformed provider text');
assertNoProviderMarker(repairedJournal, repairedMarker, 'repaired journal does not expose raw malformed provider text');

let repairedMissingSchemaAttempts = 0;
const repairedMissingSchemaRouter = createGenerationRouter({
  client: {
    async generate() {
      repairedMissingSchemaAttempts += 1;
      return {
        text: '{"ok":true,}',
        providerId: 'fake-host',
        model: 'fake-model'
      };
    }
  }
});
const repairedMissingSchema = await repairedMissingSchemaRouter.generate('utilityArbiter', { prompt: 'Missing schema after repair.' });
assertEqual(repairedMissingSchema.ok, false, 'repaired json missing schema still fails');
assertEqual(repairedMissingSchema.error.code, 'RECURSION_PROVIDER_SCHEMA_MISMATCH', 'repaired json missing schema keeps schema mismatch code');
assertEqual(repairedMissingSchemaAttempts, 2, 'repaired schema mismatch still gets one correction retry');

let formatRetryAttempts = 0;
const formatRetryPrompts = [];
const formatRetryRouter = createGenerationRouter({
  client: {
    async generate(roleId, request) {
      formatRetryAttempts += 1;
      formatRetryPrompts.push(request.prompt);
      if (formatRetryAttempts === 1) {
        return { text: '{"schema":"wrong.schema","ok":true}', providerId: 'fake-host', model: 'fake-model' };
      }
      return { text: responseTextForRole(roleId), providerId: 'fake-host', model: 'fake-model' };
    }
  }
});
const formatRetried = await formatRetryRouter.generate('utilityArbiter', {
  prompt: 'Return Utility Arbiter JSON.',
  snapshotHash: 'retry-snapshot-hash'
});
assertEqual(formatRetried.ok, true, 'structured-output schema mismatch retries once');
assertEqual(formatRetryAttempts, 2, 'structured-output retry makes exactly one retry attempt');
assertEqual(formatRetried.diagnostics.retryCount, 1, 'structured-output retry records retry count');
assertEqual(formatRetried.recoverySpent, true, 'structured-output retry marks the shared recovery budget spent');
assertEqual(formatRetried.diagnostics.structuredOutputRecovery, 'slot_correction_retry', 'structured-output retry has stable recovery metadata');
assert(formatRetryPrompts[1].includes('Previous response was rejected'), 'structured-output retry adds correction prompt');
assert(formatRetryPrompts[1].includes('recursion.utilityArbiter.v1'), 'structured-output retry names expected schema');
assert(formatRetryPrompts[1].includes('"schema": "recursion.utilityArbiter.v1"'), 'structured-output retry spells out schema field');
assert(formatRetryPrompts[1].includes('"snapshotHash": "retry-snapshot-hash"'), 'structured-output retry spells out snapshot hash field');

let noStructuredRecoveryAttempts = 0;
const noStructuredRecovery = await createGenerationRouter({
  client: {
    async generate() {
      noStructuredRecoveryAttempts += 1;
      return { text: '{"schema":"wrong.schema"}', providerId: 'fake-host', model: 'fake-model' };
    }
  }
}).generate('generationReviewer', { prompt: 'Do not spend another recovery request.' }, { allowStructuredRecovery: false });
assertEqual(noStructuredRecovery.ok, false, 'explicitly spent recovery budget rejects a second structured retry');
assertEqual(noStructuredRecoveryAttempts, 1, 'spent recovery budget does not make a second provider call');
assertEqual(noStructuredRecovery.recoverySpent, true, 'result retains caller-provided recovery-spent state');

const slotBatchCalls = [];
const slotRecoveryRouter = createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generation is not expected');
    },
    async batch(requests) {
      slotBatchCalls.push(requests);
      if (slotBatchCalls.length === 1) {
        return [
          { text: responseTextForRole('sceneFrameCard'), providerId: 'fake-host', model: 'fake-model' },
          { text: '{"schema":"wrong.schema"}', providerId: 'fake-host', model: 'fake-model' }
        ];
      }
      return [{ text: responseTextForRole('sceneConstraintsCard'), providerId: 'fake-host', model: 'fake-model' }];
    }
  }
});
const slotRecovered = await slotRecoveryRouter.batch([
  { roleId: 'sceneFrameCard', prompt: 'Scene Frame' },
  { roleId: 'sceneConstraintsCard', prompt: 'Scene Constraints' }
]);
assertEqual(slotBatchCalls.length, 2, 'one invalid structured batch slot gets one correction batch');
assertEqual(slotBatchCalls[1].length, 1, 'valid batch sibling is not reissued');
assertEqual(slotRecovered[0].diagnostics.retryCount, 0, 'initial valid batch sibling remains clean');
assertEqual(slotRecovered[1].ok, true, 'corrected batch slot succeeds');
assertEqual(slotRecovered[1].diagnostics.retryCount, 1, 'corrected batch slot records one retry');
assertEqual(slotRecovered[1].diagnostics.structuredOutputRecovery, 'slot_correction_retry', 'corrected batch slot records structured recovery');

let retryAttempts = 0;
const retryHost = {
  generation: {
    async generate() {
      retryAttempts += 1;
      if (retryAttempts === 1) {
        const error = new Error('temporary network failure');
        error.code = 'ECONNRESET';
        error.retryable = true;
        throw error;
      }
      return { text: responseTextForRole('utilityArbiter') };
    }
  }
};
const retryRouter = createGenerationRouter({
  client: createProviderClient({ host: retryHost, settingsStore: createStore() })
});
const retried = await retryRouter.generate('utilityArbiter', { prompt: 'Retry once' });
assertEqual(retried.ok, true, 'transient retry succeeds');
assertEqual(retryAttempts, 2, 'transient failure retries exactly once');
assertEqual(retried.diagnostics.retryCount, 1, 'retry count recorded');

let nestedHostRetryAttempts = 0;
const nestedHostRetryRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          nestedHostRetryAttempts += 1;
          if (nestedHostRetryAttempts === 1) {
            const cause = new Error('temporary connection profile reset');
            cause.code = 'ECONNRESET';
            throw new Error('API request failed', { cause });
          }
          return { text: responseTextForRole('utilityArbiter') };
        }
      }
    },
    settingsStore: createStore()
  })
});
const nestedHostRetried = await nestedHostRetryRouter.generate('utilityArbiter', { prompt: 'Retry nested host failure.' });
assertEqual(nestedHostRetried.ok, true, 'nested SillyTavern connection-profile failure retries');
assertEqual(nestedHostRetryAttempts, 2, 'nested connection-profile failure retries exactly once');
assertEqual(nestedHostRetried.diagnostics.retryCount, 1, 'nested connection-profile retry count recorded');

let nestedHostFailureAttempts = 0;
const nestedHostFailure = await createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          nestedHostFailureAttempts += 1;
          const cause = new Error('temporary connection profile reset');
          cause.code = 'ECONNRESET';
          throw new Error('API request failed', { cause });
        }
      }
    },
    settingsStore: createStore()
  })
}).generate('editorialDiagnostician', { prompt: 'Report nested host failure.' });
assertEqual(nestedHostFailure.ok, false, 'repeated nested connection-profile failure remains visible');
assertEqual(nestedHostFailureAttempts, 2, 'repeated nested connection-profile failure spends one retry');
assertEqual(nestedHostFailure.error.code, 'ECONNRESET', 'nested connection-profile diagnostics expose the safe root cause code');
assertEqual(nestedHostFailure.error.message, 'temporary connection profile reset', 'nested connection-profile diagnostics expose the safe root cause message');

let staleRetryAttempts = 0;
const staleRetryGuardContexts = [];
const staleRetryRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          staleRetryAttempts += 1;
          const error = new Error('temporary network failure after superseded run');
          error.code = 'ECONNRESET';
          error.retryable = true;
          throw error;
        }
      }
    },
    settingsStore: createStore()
  })
});
const staleRetry = await staleRetryRouter.generate('utilityArbiter', { prompt: 'Do not retry stale run' }, {
  runId: 'stale-single-run',
  async isCurrent(context) {
    staleRetryGuardContexts.push(context);
    return false;
  }
});
assertEqual(staleRetry.ok, false, 'stale single retry returns failure result');
assertEqual(staleRetryAttempts, 1, 'stale single retry guard prevents second attempt');
assertEqual(staleRetry.error.code, 'ECONNRESET', 'stale single retry keeps sanitized provider failure code');
assertEqual(staleRetry.diagnostics.retryCount, 0, 'stale single retry does not count a skipped retry');
assertEqual(staleRetry.diagnostics.retrySkippedReason, 'stale-current-guard', 'stale single retry records skipped retry reason');
assertEqual(staleRetryGuardContexts.length, 1, 'stale single retry checks freshness once');
assertEqual(staleRetryGuardContexts[0].roleId, 'utilityArbiter', 'stale single retry guard receives role id');
assertEqual(staleRetryGuardContexts[0].lane, 'utility', 'stale single retry guard receives lane');
assertEqual(staleRetryGuardContexts[0].runId, 'stale-single-run', 'stale single retry guard receives run id');
assertEqual(staleRetryGuardContexts[0].attempt, 1, 'stale single retry guard receives next attempt number');

let requestSignalRetryAttempts = 0;
const requestSignalRetryController = new AbortController();
const requestSignalOptionsController = new AbortController();
const requestSignalRetry = await createGenerationRouter({
  client: {
    async generate() {
      requestSignalRetryAttempts += 1;
      if (requestSignalRetryAttempts === 1) {
        requestSignalRetryController.abort();
        const error = new Error('temporary failure after request was aborted');
        error.code = 'ECONNRESET';
        error.retryable = true;
        throw error;
      }
      return { text: responseTextForRole('utilityArbiter') };
    }
  }
}).generate('utilityArbiter', {
  prompt: 'Request signal should block retry.',
  signal: requestSignalRetryController.signal
}, {
  runId: 'request-signal-retry-guard',
  signal: requestSignalOptionsController.signal
});
assertEqual(requestSignalRetry.ok, false, 'aborted request signal blocks single retry even when options signal is open');
assertEqual(requestSignalRetryAttempts, 1, 'aborted request signal prevents second single attempt');
assertEqual(requestSignalRetry.diagnostics.retrySkippedReason, 'aborted', 'aborted request signal records skipped retry reason');

let throwingGuardAttempts = 0;
const throwingGuard = await createGenerationRouter({
  client: {
    async generate() {
      throwingGuardAttempts += 1;
      const error = new Error('temporary failure before throwing guard');
      error.code = 'ECONNRESET';
      error.retryable = true;
      throw error;
    }
  }
}).generate('utilityArbiter', { prompt: 'Throwing retry guard.' }, {
  runId: 'throwing-guard-single-run',
  isRetryCurrent() {
    throw new Error('guard unavailable');
  }
});
assertEqual(throwingGuard.ok, false, 'throwing retry guard returns failure result');
assertEqual(throwingGuardAttempts, 1, 'throwing retry guard prevents second attempt');
assertEqual(throwingGuard.diagnostics.retrySkippedReason, 'current-guard-failed', 'throwing retry guard records current-guard-failed reason');

let nonTransientAttempts = 0;
const nonTransientHost = {
  generation: {
    async generate() {
      nonTransientAttempts += 1;
      const error = new Error('bad request');
      error.code = 'RECURSION_BAD_REQUEST';
      error.retryable = false;
      throw error;
    }
  }
};
const nonTransientRouter = createGenerationRouter({
  client: createProviderClient({ host: nonTransientHost, settingsStore: createStore() })
});
const nonTransient = await nonTransientRouter.generate('utilityArbiter', { prompt: 'Do not retry' });
assertEqual(nonTransient.ok, false, 'non-transient failure returns failure result');
assertEqual(nonTransientAttempts, 1, 'non-transient failure is not retried');

const disabledReasonerCalls = [];
const disabledReasonerRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate(request) {
          disabledReasonerCalls.push(request);
          return { text: '{"schema":"should.not.call"}' };
        }
      }
    },
    settingsStore: createStore()
  })
});
const disabledReasoner = await disabledReasonerRouter.generate('reasonerComposer', { prompt: 'Reason disabled' });
assertEqual(disabledReasoner.ok, false, 'disabled reasoner returns failure result');
assertEqual(disabledReasoner.error.code, 'RECURSION_REASONER_DISABLED', 'disabled reasoner exposes stable code');
assertEqual(disabledReasonerCalls.length, 0, 'disabled reasoner does not call host');

let missingKeyFetches = 0;
const missingKeyStore = createStore();
missingKeyStore.updateProvider('utility', {
  source: 'openai-compatible',
  openAICompatible: { baseUrl: 'https://example.test/v1', model: 'utility-model' }
});
const missingKeyRouter = createGenerationRouter({
  client: createProviderClient({
    settingsStore: missingKeyStore,
    fetchImpl: async () => {
      missingKeyFetches += 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    }
  })
});
const missingKey = await missingKeyRouter.generate('utilityArbiter', { prompt: 'Needs key' });
assertEqual(missingKey.ok, false, 'missing direct endpoint key returns failure result');
assertEqual(missingKey.error.code, 'RECURSION_PROVIDER_KEY_MISSING', 'missing key exposes stable code');
assertEqual(missingKeyFetches, 0, 'missing key does not call fetch');

const fallbackBatchCalls = [];
const fallbackBatchClient = createProviderClient({
  host: {
    generation: {
      async generate(request) {
        fallbackBatchCalls.push(request);
        return { text: `{"schema":"${request.roleId}","lane":"${request.lane}"}` };
      }
    }
  },
  settingsStore: createStore()
});
const fallbackBatchResults = await fallbackBatchClient.batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'guidanceComposer', prompt: 'B' }
]);
assertEqual(fallbackBatchResults.length, 2, 'batch fallback returns all results');
assertDeepEqual(fallbackBatchCalls.map((request) => request.roleId), ['utilityArbiter', 'guidanceComposer'], 'batch fallback enriches role ids');
assertDeepEqual(fallbackBatchCalls.map((request) => request.lane), ['utility', 'utility'], 'batch fallback enriches lanes');

const hostBatchCalls = [];
const hostBatchSlotEvents = [];
const hostBatchClient = createProviderClient({
  host: {
    generation: {
      async generate() {
        throw new Error('host generate should not be used when batch is available');
      },
      async batch(requests, options = {}) {
        hostBatchCalls.push(...requests);
        return requests.map((request, index) => {
          const response = { text: responseTextForRole(request.roleId, { lane: request.lane }) };
          options.onSlotSettled?.({ index, request, response });
          return response;
        });
      },
      capabilities: {
        batch: {
          mode: 'concurrent',
          maxConcurrency: 4,
          slotIsolation: true,
          supportsAbortSignal: true,
          source: 'fake-host-batch'
        }
      }
    }
  },
  settingsStore: createStore()
});
const hostBatchResults = await hostBatchClient.batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], {
  onSlotSettled: (slot) => hostBatchSlotEvents.push(slot)
});
assertEqual(hostBatchResults.length, 2, 'host batch returns all responses');
assertDeepEqual(hostBatchCalls.map((request) => request.roleId), ['utilityArbiter', 'providerTest'], 'host batch receives enriched role ids');
assertDeepEqual(hostBatchCalls.map((request) => request.lane), ['utility', 'utility'], 'host batch receives enriched lanes');
assertDeepEqual(
  hostBatchSlotEvents.map((slot) => [slot.index, slot.roleId, slot.response?.text && JSON.parse(slot.response.text).schema]),
  [
    [0, 'utilityArbiter', 'recursion.utilityArbiter.v1'],
    [1, 'providerTest', 'recursion.providerTest.v1']
  ],
  'provider client forwards normalized host batch slot callbacks'
);
assertDeepEqual(
  hostBatchResults.map((entry) => ({
    batchMode: entry.batchMode,
    concurrencyLimit: entry.concurrencyLimit,
    slotIsolation: entry.slotIsolation
  })),
  [
    { batchMode: 'concurrent', concurrencyLimit: 4, slotIsolation: true },
    { batchMode: 'concurrent', concurrencyLimit: 4, slotIsolation: true }
  ],
  'host batch response metadata carries batch capability diagnostics'
);

let routerHostBatchCallCount = 0;
let routerHostGenerateCallCount = 0;
const routerHostBatchCalls = [];
const routerHostBatchRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate(request) {
          routerHostGenerateCallCount += 1;
          return { text: responseTextForRole(request.roleId, { lane: request.lane }) };
        },
        async batch(requests) {
          routerHostBatchCallCount += 1;
          routerHostBatchCalls.push(requests);
          return requests.map((request) => ({ text: responseTextForRole(request.roleId, { lane: request.lane }) }));
        },
        capabilities: {
          batch: {
            mode: 'concurrent',
            maxConcurrency: 4,
            slotIsolation: true,
            supportsAbortSignal: true,
            source: 'fake-router-host-batch'
          }
        }
      }
    },
    settingsStore: createStore()
  })
});
const routerHostBatchResults = await routerHostBatchRouter.batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
]);
assertEqual(routerHostBatchCallCount, 1, 'router batch calls host/client batch once when available');
assertEqual(routerHostGenerateCallCount, 0, 'router batch does not call host/client single generate when batch is available');
assertDeepEqual(routerHostBatchCalls[0].map((request) => request.roleId), ['utilityArbiter', 'providerTest'], 'router batch sends enriched role ids to host batch');
assertDeepEqual(routerHostBatchResults.map((entry) => entry.ok), [true, true], 'router batch returns router-style success results');
assertDeepEqual(
  routerHostBatchResults.map((entry) => entry.data.schema),
  ['recursion.utilityArbiter.v1', 'recursion.providerTest.v1'],
  'router batch validates each response schema'
);
assertDeepEqual(
  routerHostBatchResults.map((entry) => ({
    batchMode: entry.diagnostics.batchMode,
    concurrencyLimit: entry.diagnostics.concurrencyLimit,
    slotIsolation: entry.diagnostics.slotIsolation
  })),
  [
    { batchMode: 'concurrent', concurrencyLimit: 4, slotIsolation: true },
    { batchMode: 'concurrent', concurrencyLimit: 4, slotIsolation: true }
  ],
  'router batch diagnostics preserve host batch capability metadata'
);

{
  let releaseSlowSlot = null;
  let streamedBatchFinished = false;
  const streamedActivity = createActivityReporter();
  const streamedRouter = createGenerationRouter({
    client: {
      async generate() {
        throw new Error('single generate should not be used for streamed batch progress');
      },
      async batch(requests, options = {}) {
        return Promise.all(requests.map(async (request, index) => {
          if (request.roleId === 'utilityArbiter') {
            await new Promise((resolve) => {
              releaseSlowSlot = resolve;
            });
          }
          const response = {
            text: responseTextForRole(request.roleId, { lane: request.lane || 'utility' }),
            providerId: 'fake-host',
            model: 'fake-model'
          };
          options.onSlotSettled?.({ index, request, response });
          return response;
        }));
      }
    },
    activity: streamedActivity
  });
  const pendingStreamedBatch = streamedRouter.batch([
    { roleId: 'utilityArbiter', prompt: 'Slow slot.' },
    { roleId: 'providerTest', prompt: 'Fast slot.' }
  ], { runId: 'provider-batch-streamed-progress' });
  pendingStreamedBatch.then(() => {
    streamedBatchFinished = true;
  });
  await flushMicrotasks();
  const fastSettledEvents = streamedActivity.history()
    .filter((event) => event.phase === 'providerCallSettled' && event.detail?.roleId === 'providerTest');
  assertEqual(streamedBatchFinished, false, 'router streamed progress test keeps batch pending while slow slot is blocked');
  assertEqual(fastSettledEvents.length, 1, 'router emits settled progress for a completed batch slot before the whole batch resolves');
  assertEqual(fastSettledEvents[0].outcome, 'success', 'router streamed slot progress marks successful slot done');
  releaseSlowSlot();
  const streamedResults = await pendingStreamedBatch;
  assertDeepEqual(streamedResults.map((entry) => entry.ok), [true, true], 'router streamed batch still returns all slot results');
}

const routerHostSlotFailure = await createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async batch(requests) {
          return requests.map((request) => {
            if (request.roleId === 'providerTest') {
              return {
                ok: false,
                error: {
                  code: 'RECURSION_TEST_HOST_SLOT_FAILED',
                  message: 'isolated host slot failed',
                  retryable: false
                }
              };
            }
            return { text: responseTextForRole(request.roleId, { lane: request.lane }) };
          });
        },
        capabilities: {
          batch: {
            mode: 'concurrent',
            maxConcurrency: 4,
            slotIsolation: true,
            supportsAbortSignal: true,
            source: 'fake-router-slot-failure'
          }
        }
      }
    },
    settingsStore: createStore()
  })
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], { runId: 'provider-batch-host-slot-failure' });
assertEqual(routerHostSlotFailure[0].ok, true, 'router host batch keeps successful slot when sibling host slot fails');
assertEqual(routerHostSlotFailure[1].ok, false, 'router host batch returns failure only for failed host slot');
assertEqual(routerHostSlotFailure[1].error.code, 'RECURSION_TEST_HOST_SLOT_FAILED', 'router host batch preserves failed slot code');
assertEqual(routerHostSlotFailure[1].diagnostics.batchMode, 'concurrent', 'router host batch failure diagnostics preserve batch mode');
assertEqual(routerHostSlotFailure[1].diagnostics.slotIsolation, true, 'router host batch failure diagnostics preserve slot isolation');

const suppliedBatchRunId = 'provider-batch-run-test';
const routerRunIdBatch = await routerHostBatchRouter.batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], { runId: suppliedBatchRunId });
assertDeepEqual(routerRunIdBatch.map((entry) => entry.diagnostics.runId), [suppliedBatchRunId, suppliedBatchRunId], 'router batch diagnostics use supplied shared run id');
assertDeepEqual(routerRunIdBatch.map((entry) => entry.roleId), ['utilityArbiter', 'providerTest'], 'router batch preserves role ids in parsed results');

let transientBatchCalls = 0;
const transientBatch = await createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generate should not be used for transient batch retry');
    },
    async batch(requests) {
      transientBatchCalls += 1;
      if (transientBatchCalls === 1) {
        const error = new Error('temporary reset');
        error.code = 'ECONNRESET';
        throw error;
      }
      return requests.map((request) => ({ text: responseTextForRole(request.roleId, { lane: request.lane }) }));
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], { runId: 'provider-batch-transient-retry' });
assertEqual(transientBatchCalls, 2, 'router batch retries one transient transport failure');
assertDeepEqual(transientBatch.map((entry) => entry.ok), [true, true], 'transient retry returns successful batch entries');
assertDeepEqual(transientBatch.map((entry) => entry.diagnostics.retryCount), [1, 1], 'retried batch entries record retry count');

let staleBatchCalls = 0;
const staleBatchGuardContexts = [];
const staleBatch = await createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generate should not be used for stale batch retry');
    },
    async batch() {
      staleBatchCalls += 1;
      const error = new Error('temporary batch reset after superseded run');
      error.code = 'ECONNRESET';
      error.retryable = true;
      throw error;
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], {
  runId: 'stale-batch-run',
  async isCurrent(context) {
    staleBatchGuardContexts.push(context);
    return false;
  }
});
assertEqual(staleBatchCalls, 1, 'stale batch retry guard prevents second batch call');
assertDeepEqual(staleBatch.map((entry) => entry.ok), [false, false], 'stale batch retry returns failure entries');
assertDeepEqual(staleBatch.map((entry) => entry.error.code), ['ECONNRESET', 'ECONNRESET'], 'stale batch retry keeps sanitized provider failure codes');
assertDeepEqual(staleBatch.map((entry) => entry.diagnostics.retryCount), [0, 0], 'stale batch retry does not count skipped retry');
assertDeepEqual(
  staleBatch.map((entry) => entry.diagnostics.retrySkippedReason),
  ['stale-current-guard', 'stale-current-guard'],
  'stale batch retry records skipped retry reason for pending entries'
);
assertEqual(staleBatchGuardContexts.length, 1, 'stale batch retry checks freshness once');
assertEqual(staleBatchGuardContexts[0].runId, 'stale-batch-run', 'stale batch retry guard receives run id');
assertEqual(staleBatchGuardContexts[0].attempt, 1, 'stale batch retry guard receives next attempt number');
assertEqual(staleBatchGuardContexts[0].batch, true, 'stale batch retry guard identifies batch retry');
assertDeepEqual(
  staleBatchGuardContexts[0].entries.map((entry) => entry.roleId),
  ['utilityArbiter', 'providerTest'],
  'stale batch retry guard receives pending batch entries'
);

let malformedSlotBatchCalls = 0;
const routerMalformedSlot = await createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generate should not be used for malformed batch test');
    },
    async batch() {
      malformedSlotBatchCalls += 1;
      if (malformedSlotBatchCalls > 1) {
        return [{ text: 'not-json', roleId: 'providerTest', lane: 'utility', providerId: 'fake-host', model: 'fake-model' }];
      }
      return [
        { text: responseTextForRole('utilityArbiter'), roleId: 'utilityArbiter', lane: 'utility', providerId: 'fake-host', model: 'fake-model' },
        { text: 'not-json', roleId: 'providerTest', lane: 'utility', providerId: 'fake-host', model: 'fake-model' }
      ];
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], { runId: 'provider-batch-malformed-test' });
assertEqual(routerMalformedSlot[0].ok, true, 'router batch keeps valid slot successful when another slot is malformed');
assertEqual(routerMalformedSlot[1].ok, false, 'router batch returns failure result for malformed slot');
assertEqual(routerMalformedSlot[1].error.code, 'RECURSION_JSON_PARSE_FAILED', 'router batch malformed slot exposes parse code');

const routerBatchLeakActivity = createActivityReporter();
const routerBatchLeakJournal = [];
let routerBatchLeakCalls = 0;
const routerBatchLeak = await createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generate should not be used for leak batch test');
    },
    async batch() {
      routerBatchLeakCalls += 1;
      if (routerBatchLeakCalls > 1) {
        return [{ text: 'RAW_BATCH_RESPONSE_MARKER_42 not json', roleId: 'providerTest', lane: 'utility', providerId: 'fake-host', model: 'fake-model' }];
      }
      return [
        { text: responseTextForRole('utilityArbiter'), roleId: 'utilityArbiter', lane: 'utility', providerId: 'fake-host', model: 'fake-model' },
        { text: 'RAW_BATCH_RESPONSE_MARKER_42 not json', roleId: 'providerTest', lane: 'utility', providerId: 'fake-host', model: 'fake-model' }
      ];
    }
  },
  activity: routerBatchLeakActivity,
  journal: { append: (entry) => routerBatchLeakJournal.push(entry) }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A', snapshotHash: 'batch-snapshot-a' },
  { roleId: 'providerTest', prompt: 'B', snapshotHash: 'batch-snapshot-b' }
], { runId: 'provider-batch-leak-test', timeoutMs: 3456 });
assertEqual(routerBatchLeak[0].ok, true, 'router batch leak regression keeps valid slot successful');
assertEqual(routerBatchLeak[1].ok, false, 'router batch leak regression returns failure for malformed slot');
assertDeepEqual(
  routerBatchLeakJournal.map((entry) => entry.status),
  ['started', 'started', 'success', 'validation-failed'],
  'router batch journal records started events before slot outcomes'
);
assertDeepEqual(
  routerBatchLeakJournal.slice(0, 2).map((entry) => entry.roleId),
  ['utilityArbiter', 'providerTest'],
  'router batch started journal records each role'
);
assertDeepEqual(
  routerBatchLeakJournal.slice(0, 2).map((entry) => entry.snapshotHash),
  ['batch-snapshot-a', 'batch-snapshot-b'],
  'router batch started journal records each request snapshot hash'
);
assertDeepEqual(
  routerBatchLeakJournal.map((entry) => entry.timeoutMs),
  [3456, 3456, 3456, 3456],
  'router batch journal records effective timeout on every entry'
);
assertNoRawBatchMarker(routerBatchLeak, 'router batch result diagnostics do not expose raw malformed provider response');
assertNoRawBatchMarker(routerBatchLeakJournal, 'router batch journal does not expose raw malformed provider response');
assertNoRawBatchMarker(routerBatchLeakActivity.history(), 'router batch activity does not expose raw malformed provider response');
assertEqual(routerBatchLeakActivity.current().phase, 'settled', 'router batch activity settles after all slots');
assertEqual(routerBatchLeakActivity.current().severity, 'warning', 'router batch activity reports mixed slot failure as warning');
assert(routerBatchLeakActivity.current().detail.failed === 1, 'router batch activity detail records failed slot count');

const abortedBatchController = new AbortController();
abortedBatchController.abort();
const abortedBatchJournal = [];
const abortedBatch = await createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generate should not be used for aborted batch slot');
    },
    async batch() {
      throw new Error('provider batch should not run aborted slot');
    }
  },
  journal: { append: (entry) => abortedBatchJournal.push(entry) }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'Aborted before batch.', signal: abortedBatchController.signal }
], { runId: 'provider-batch-aborted-slot' });
assertEqual(abortedBatch[0].ok, false, 'aborted batch slot returns failure result');
assertDeepEqual(
  abortedBatchJournal.map((entry) => entry.status),
  ['aborted'],
  'aborted batch slot does not record a provider-call started event'
);

let routerSequentialFallbackCalls = 0;
const routerSequentialFallback = await createGenerationRouter({
  client: {
    async generate(roleId, request) {
      routerSequentialFallbackCalls += 1;
      return { text: responseTextForRole(roleId, { lane: request.lane || 'utility' }) };
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
]);
assertEqual(routerSequentialFallbackCalls, 2, 'router batch falls back to sequential generate when client batch is absent');
assertDeepEqual(
  routerSequentialFallback.map((entry) => entry.data.schema),
  ['recursion.utilityArbiter.v1', 'recursion.providerTest.v1'],
  'router batch sequential fallback validates response schemas'
);
assert(routerSequentialFallback[0].diagnostics.runId.startsWith('provider-batch-'), 'router sequential fallback mints a batch run id');
assertEqual(
  routerSequentialFallback[1].diagnostics.runId,
  routerSequentialFallback[0].diagnostics.runId,
  'router sequential fallback uses one shared batch run id'
);

let routerSequentialFallbackActivityStarts = 0;
const routerSequentialFallbackActivity = await createGenerationRouter({
  client: {
    async generate(roleId, request) {
      return { text: responseTextForRole(roleId, { lane: request.lane || 'utility' }) };
    }
  },
  activity: {
    start(event) {
      routerSequentialFallbackActivityStarts += 1;
      return { ...event, runId: `${event.runId}-activity-${routerSequentialFallbackActivityStarts}` };
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A', runId: 'slot-a-run' },
  { roleId: 'providerTest', prompt: 'B', runId: 'slot-b-run' }
]);
assertEqual(routerSequentialFallbackActivityStarts, 2, 'router sequential fallback still emits per-slot start activity');
assert(routerSequentialFallbackActivity[0].diagnostics.runId.startsWith('provider-batch-'), 'router sequential fallback ignores per-slot request run ids');
assertEqual(
  routerSequentialFallbackActivity[1].diagnostics.runId,
  routerSequentialFallbackActivity[0].diagnostics.runId,
  'router sequential fallback keeps shared run id even when activity returns per-slot ids'
);

const badHostBatchClient = createProviderClient({
  host: {
    generation: {
      async batch() {
        return [{ text: '{"schema":"only-one"}' }];
      }
    }
  },
  settingsStore: createStore()
});
let badBatchCode = '';
try {
  await badHostBatchClient.batch([
    { roleId: 'utilityArbiter', prompt: 'A' },
    { roleId: 'providerTest', prompt: 'B' }
  ]);
} catch (error) {
  badBatchCode = error.code;
}
assertEqual(badBatchCode, 'RECURSION_PROVIDER_BATCH_INVALID', 'host batch validates response length');

const fetchCalls = [];
const openAiStore = createStore();
openAiStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'session-key',
  openAICompatible: { baseUrl: 'https://provider.test/v1/', model: 'utility-model' },
  temperature: 0.25,
  topP: 0.8,
  maxTokens: 321
});
const openAiRouter = createGenerationRouter({
  client: createProviderClient({
    settingsStore: openAiStore,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      fetchCalls.push({ url, options, body });
      const schema = body?.response_format?.json_schema?.schema?.properties?.schema?.const;
      const responseRoleId = schema === 'recursion.providerTest.v1' ? 'providerTest' : 'utilityArbiter';
      return {
        ok: true,
        json: async () => ({
          id: 'chatcmpl-test',
          model: 'utility-model',
          choices: [{ message: { content: responseTextForRole(responseRoleId) } }]
        })
      };
    }
  })
});
const openAiResult = await openAiRouter.generate('utilityArbiter', {
  prompt: 'OpenAI compatible',
  snapshotHash: 'openai-snapshot-hash'
});
assertEqual(openAiResult.ok, true, 'openai-compatible route succeeds');
assertEqual(fetchCalls[0].url, 'https://provider.test/v1/chat/completions', 'openai-compatible endpoint is constructed');
assertEqual(fetchCalls[0].options.headers.Authorization, 'Bearer session-key', 'session key sent as bearer token');
assertEqual(fetchCalls[0].body.model, 'utility-model', 'configured model sent');
assertEqual(fetchCalls[0].body.temperature, 0.25, 'configured temperature sent');
assertEqual(fetchCalls[0].body.top_p, 0.8, 'configured top_p sent');
assertEqual(fetchCalls[0].body.max_tokens, 321, 'configured max tokens sent');
assertEqual(fetchCalls[0].body.response_format.type, 'json_schema', 'openai-compatible requests schema-constrained JSON');
assertEqual(fetchCalls[0].body.response_format.json_schema.schema.properties.schema.const, 'recursion.utilityArbiter.v1', 'openai-compatible JSON schema constrains role schema');
assertEqual(fetchCalls[0].body.response_format.json_schema.schema.properties.snapshotHash.const, 'openai-snapshot-hash', 'openai-compatible JSON schema constrains snapshot hash');
assertEqual(fetchCalls[0].body.messages[0].content, 'OpenAI compatible', 'prompt sent as chat message');
const openAiProviderTestResult = await openAiRouter.generate('providerTest', {
  prompt: 'OpenAI compatible provider test',
  responseLength: 256
});
assertEqual(openAiProviderTestResult.ok, true, 'openai-compatible provider test route succeeds');
assertEqual(fetchCalls[1].body.max_tokens, 256, 'openai-compatible provider test request uses responseLength instead of configured max tokens');

async function captureReasoningBody({
  baseUrl,
  model,
  reasoningIntent = 'medium',
  responseRoleId = 'reasonerComposer',
  fetchImpl = null
} = {}) {
  const calls = [];
  const store = createStore();
  store.updateProvider('reasoner', {
    enabled: true,
    source: 'openai-compatible',
    apiKey: 'session-key',
    openAICompatible: { baseUrl, model },
    maxTokens: 4096
  });
  const router = createGenerationRouter({
    client: createProviderClient({
      settingsStore: store,
      fetchImpl: fetchImpl || (async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: `${responseRoleId}-reasoning-test`,
            model,
            choices: [{ message: { content: responseTextForRole(responseRoleId) } }]
          })
        };
      })
    })
  });
  const result = await router.generate(responseRoleId, {
    lane: 'reasoner',
    prompt: `Reasoning intent ${reasoningIntent}`,
    reasoningIntent
  });
  return { result, calls, store };
}

const openRouterReasoning = await captureReasoningBody({
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openai/gpt-5.5',
  reasoningIntent: 'medium'
});
assertEqual(openRouterReasoning.result.ok, true, 'OpenRouter-style reasoning route succeeds');
assertDeepEqual(
  openRouterReasoning.calls[0].body.reasoning,
  { effort: 'medium', exclude: true },
  'OpenRouter-style endpoints receive medium reasoning effort'
);
assertEqual(openRouterReasoning.result.diagnostics.reasoningIntent, 'medium', 'diagnostics record normalized reasoning intent');
assertEqual(openRouterReasoning.result.diagnostics.reasoningDialect, 'openrouter', 'diagnostics record OpenRouter reasoning dialect');
assertEqual(openRouterReasoning.result.diagnostics.reasoningApplied, true, 'diagnostics record applied reasoning fields');

const openAiReasoning = await captureReasoningBody({
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  reasoningIntent: 'high'
});
assertDeepEqual(
  openAiReasoning.calls[0].body.reasoning,
  { effort: 'high', exclude: true },
  'OpenAI-style endpoints receive high reasoning effort'
);
assertEqual(openAiReasoning.result.diagnostics.reasoningDialect, 'openai', 'diagnostics record OpenAI reasoning dialect');

const glmReasoning = await captureReasoningBody({
  baseUrl: 'https://api.z.ai/api/paas/v4',
  model: 'glm-5.2',
  reasoningIntent: 'high'
});
assertDeepEqual(glmReasoning.calls[0].body.thinking, { type: 'enabled' }, 'GLM endpoints enable thinking mode');
assertEqual(glmReasoning.calls[0].body.reasoning_effort, 'max', 'GLM high intent maps to maximum reasoning effort');
assertEqual(glmReasoning.result.diagnostics.reasoningDialect, 'z-ai-glm', 'diagnostics record GLM reasoning dialect');

const minimaxMediumReasoning = await captureReasoningBody({
  baseUrl: 'https://api.minimax.io/v1',
  model: 'MiniMax-M3',
  reasoningIntent: 'medium'
});
assertEqual(minimaxMediumReasoning.calls[0].body.thinking, 'adaptive', 'MiniMax medium intent uses adaptive thinking');
assertEqual(minimaxMediumReasoning.result.diagnostics.reasoningDialect, 'minimax-m3', 'diagnostics record MiniMax reasoning dialect');

const minimaxHighReasoning = await captureReasoningBody({
  baseUrl: 'https://api.minimax.io/v1',
  model: 'MiniMax-M3',
  reasoningIntent: 'high'
});
assertEqual(minimaxHighReasoning.calls[0].body.thinking, 'enabled', 'MiniMax high intent enables reasoning');

const deepSeekReasoning = await captureReasoningBody({
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-reasoner',
  reasoningIntent: 'high'
});
assert(!Object.prototype.hasOwnProperty.call(deepSeekReasoning.calls[0].body, 'reasoning'), 'DeepSeek reasoner does not receive unsupported reasoning object');
assert(!Object.prototype.hasOwnProperty.call(deepSeekReasoning.calls[0].body, 'thinking'), 'DeepSeek reasoner does not receive unsupported thinking field');
assert(!Object.prototype.hasOwnProperty.call(deepSeekReasoning.calls[0].body, 'reasoning_effort'), 'DeepSeek reasoner does not receive unsupported reasoning_effort field');
assertEqual(deepSeekReasoning.result.diagnostics.reasoningDialect, 'deepseek-reasoner', 'diagnostics record DeepSeek no-op reasoning dialect');
assertEqual(deepSeekReasoning.result.diagnostics.reasoningApplied, false, 'diagnostics record DeepSeek reasoning intent as not field-applied');

const unknownReasoning = await captureReasoningBody({
  baseUrl: 'https://unknown-reasoning.test/v1',
  model: 'custom-reasoner',
  reasoningIntent: 'high'
});
assert(!Object.prototype.hasOwnProperty.call(unknownReasoning.calls[0].body, 'reasoning'), 'unknown endpoints omit speculative reasoning object');
assert(!Object.prototype.hasOwnProperty.call(unknownReasoning.calls[0].body, 'thinking'), 'unknown endpoints omit speculative thinking field');
assert(!Object.prototype.hasOwnProperty.call(unknownReasoning.calls[0].body, 'reasoning_effort'), 'unknown endpoints omit speculative reasoning_effort field');
assertEqual(unknownReasoning.result.diagnostics.reasoningDialect, 'none', 'diagnostics record no dialect for unknown endpoint');
assertEqual(unknownReasoning.result.diagnostics.reasoningApplied, false, 'diagnostics record unknown endpoint as not field-applied');

const downgradeCalls = [];
const downgradedReasoning = await captureReasoningBody({
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openai/gpt-5.5',
  reasoningIntent: 'high',
  fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    downgradeCalls.push({ url, options, body });
    if (downgradeCalls.length === 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'Unrecognized request argument supplied: reasoning' } })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'downgraded-reasoning-test',
        model: 'openai/gpt-5.5',
        choices: [{ message: { content: responseTextForRole('reasonerComposer') } }]
      })
    };
  }
});
assertEqual(downgradeCalls.length, 2, 'known reasoning dialect retries once without unsupported reasoning fields');
assertDeepEqual(downgradeCalls[0].body.reasoning, { effort: 'high', exclude: true }, 'first downgrade attempt sends requested reasoning fields');
assert(!Object.prototype.hasOwnProperty.call(downgradeCalls[1].body, 'reasoning'), 'downgrade retry removes unsupported reasoning object');
assertEqual(downgradedReasoning.result.ok, true, 'downgraded reasoning retry succeeds');
assertEqual(downgradedReasoning.result.diagnostics.reasoningDowngraded, true, 'diagnostics record reasoning downgrade');

const invalidUrlStore = createStore();
invalidUrlStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'session-key',
  openAICompatible: { baseUrl: 'not a url', model: 'utility-model' }
});
let invalidUrlFetches = 0;
const invalidUrlResult = await createGenerationRouter({
  client: createProviderClient({
    settingsStore: invalidUrlStore,
    fetchImpl: async () => {
      invalidUrlFetches += 1;
      return { ok: true, json: async () => ({}) };
    }
  })
}).generate('utilityArbiter', { prompt: 'Invalid URL' });
assertEqual(invalidUrlResult.ok, false, 'invalid openai base url returns failure result');
assertEqual(invalidUrlResult.error.code, 'RECURSION_PROVIDER_CONFIG_INVALID', 'invalid base url exposes config error');
assertEqual(invalidUrlFetches, 0, 'invalid base url does not call fetch');

const invalidProtocolStore = createStore();
invalidProtocolStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'session-key',
  openAICompatible: { baseUrl: 'ftp://provider.test/v1', model: 'utility-model' }
});
let invalidProtocolFetches = 0;
const invalidProtocolResult = await createGenerationRouter({
  client: createProviderClient({
    settingsStore: invalidProtocolStore,
    fetchImpl: async () => {
      invalidProtocolFetches += 1;
      return { ok: true, json: async () => ({}) };
    }
  })
}).generate('utilityArbiter', { prompt: 'Invalid protocol' });
assertEqual(invalidProtocolResult.ok, false, 'invalid openai base protocol returns failure result');
assertEqual(invalidProtocolResult.error.code, 'RECURSION_PROVIDER_CONFIG_INVALID', 'invalid protocol exposes config error');
assertEqual(invalidProtocolFetches, 0, 'invalid protocol does not call fetch');

const badJsonStore = createStore();
badJsonStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'session-key',
  openAICompatible: { baseUrl: 'https://bad-json.test/v1', model: 'utility-model' }
});
const badJsonResult = await createGenerationRouter({
  client: createProviderClient({
    settingsStore: badJsonStore,
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('not provider json');
      }
    })
  })
}).generate('utilityArbiter', { prompt: 'Bad response JSON' });
assertEqual(badJsonResult.ok, false, 'bad provider response json returns failure result');
assertEqual(badJsonResult.error.code, 'RECURSION_PROVIDER_RESPONSE_JSON_INVALID', 'bad response json exposes stable code');

const authFailureStore = createStore();
authFailureStore.updateProvider('reasoner', {
  enabled: true,
  source: 'openai-compatible',
  apiKey: 'sk-live-secret',
  openAICompatible: { baseUrl: 'https://auth-failure.test/v1', model: 'reasoner-model' }
});
authFailureStore.updateProvider('reasoner', {
  resolvedProviderLabel: 'stale-provider',
  resolvedModelLabel: 'stale-model',
  lastTest: { status: 'pass', checkedAt: '2026-07-01T00:00:00.000Z' }
});
let authFailureFetches = 0;
const authFailureResult = await createGenerationRouter({
  client: createProviderClient({
    settingsStore: authFailureStore,
    fetchImpl: async () => {
      authFailureFetches += 1;
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Invalid sk-live-secret' } })
      };
    }
  })
}).generate('reasonerComposer', { prompt: 'Auth failure must mark health failed.' });
const authFailureReasoner = authFailureStore.get().providers.reasoner;
assertEqual(authFailureResult.ok, false, 'openai auth failure returns failure result');
assertEqual(authFailureResult.error.code, 'RECURSION_PROVIDER_AUTH_FAILED', 'openai auth failure exposes stable auth code');
assertEqual(authFailureFetches, 1, 'openai auth failure is not retried');
assertEqual(authFailureReasoner.lastTest.status, 'fail', 'openai auth failure marks lane test status failed');
assertEqual(authFailureReasoner.lastTest.compactError, 'OpenAI-compatible authentication failed.', 'openai auth failure records stable compact error');
assertEqual(authFailureReasoner.resolvedProviderLabel, '', 'openai auth failure clears stale provider label');
assertEqual(authFailureReasoner.resolvedModelLabel, '', 'openai auth failure clears stale model label');
assertEqual(authFailureReasoner.openAICompatible.sessionApiKeyPresent, false, 'openai auth failure clears invalid session key');
assertEqual(authFailureReasoner.openAICompatible.baseUrl, 'https://auth-failure.test/v1', 'openai auth failure preserves non-secret base URL');
assertEqual(authFailureReasoner.openAICompatible.model, 'reasoner-model', 'openai auth failure preserves non-secret model');
assertNoSecret(authFailureResult, 'openai auth failure result redacts session key');
assertNoSecret(authFailureReasoner, 'openai auth failure provider health redacts session key');

const forbiddenAuthStore = createStore();
forbiddenAuthStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'sk-live-secret',
  openAICompatible: { baseUrl: 'https://auth-forbidden.test/v1', model: 'utility-model' }
});
const forbiddenAuthResult = await createGenerationRouter({
  client: createProviderClient({
    settingsStore: forbiddenAuthStore,
    fetchImpl: async () => ({ ok: false, status: 403 })
  })
}).generate('utilityArbiter', { prompt: 'Forbidden auth failure.' });
assertEqual(forbiddenAuthResult.ok, false, 'openai forbidden auth failure returns failure result');
assertEqual(forbiddenAuthResult.error.code, 'RECURSION_PROVIDER_AUTH_FAILED', 'openai 403 auth failure exposes stable auth code');
assertEqual(forbiddenAuthStore.get().providers.utility.lastTest.status, 'fail', 'openai 403 auth failure marks lane unhealthy');

async function openAiProviderFailure(payload, prompt = 'OpenAI provider failure') {
  const marker = 'RAW_PROVIDER_NORMALIZER_MARKER';
  const activity = createActivityReporter();
  const journal = [];
  const store = createStore();
  store.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'session-key',
    openAICompatible: { baseUrl: 'https://normalizer.test/v1', model: 'normalizer-model' }
  });
  const router = createGenerationRouter({
    client: createProviderClient({
      settingsStore: store,
      fetchImpl: async () => ({
        ok: true,
        json: async () => payload(marker)
      })
    }),
    activity,
    journal: { append: (entry) => journal.push(entry) }
  });
  const result = await router.generate('utilityArbiter', { prompt });
  assertNoProviderMarker(result, marker, `${prompt} result does not expose raw provider text`);
  assertNoProviderMarker(activity.history(), marker, `${prompt} activity does not expose raw provider text`);
  assertNoProviderMarker(journal, marker, `${prompt} journal does not expose raw provider text`);
  return { result, activity, journal };
}

const tokenLimitFailure = await openAiProviderFailure((marker) => ({
  model: 'normalizer-model',
  choices: [{
    finish_reason: 'length',
    message: { content: `{"schema":"${marker}` }
  }]
}), 'Token limit response');
assertEqual(tokenLimitFailure.result.ok, false, 'token-limit provider response returns failure result');
assertEqual(tokenLimitFailure.result.error.code, 'RECURSION_PROVIDER_TOKEN_LIMIT', 'token-limit response exposes stable code');
assertEqual(tokenLimitFailure.result.diagnostics.status, 'provider-failed', 'token-limit response is a provider failure, not a JSON parse failure');

const reasoningOnlyFailure = await openAiProviderFailure((marker) => ({
  model: 'normalizer-model',
  choices: [{
    finish_reason: 'stop',
    message: {
      content: '',
      reasoning_content: `private reasoning ${marker}`
    }
  }]
}), 'Reasoning-only response');
assertEqual(reasoningOnlyFailure.result.ok, false, 'reasoning-only provider response returns failure result');
assertEqual(reasoningOnlyFailure.result.error.code, 'RECURSION_PROVIDER_REASONING_ONLY', 'reasoning-only response exposes stable code');

const emptyVisibleFailure = await openAiProviderFailure(() => ({
  model: 'normalizer-model',
  choices: [{ finish_reason: 'stop', message: { content: '   ' } }]
}), 'Empty visible response');
assertEqual(emptyVisibleFailure.result.ok, false, 'empty visible provider response returns failure result');
assertEqual(emptyVisibleFailure.result.error.code, 'RECURSION_PROVIDER_EMPTY_RESPONSE', 'empty visible response exposes stable code');

const redactionActivityEvents = [];
const redactionJournalEntries = [];
const redactionStore = createStore();
redactionStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'sk-live-secret',
  openAICompatible: { baseUrl: 'https://redaction.test/v1', model: 'redaction-model' }
});
const redactionRouter = createGenerationRouter({
  client: createProviderClient({
    settingsStore: redactionStore,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        model: 'redaction-model',
        choices: [{ message: { content: responseTextForRole('utilityArbiter') } }]
      })
    })
  }),
  activity: {
    start(event) {
      redactionActivityEvents.push(event);
      return { ...event, runId: 'activity-assigned-run' };
    },
    stage(event) {
      redactionActivityEvents.push(event);
      return event;
    },
    settle(event) {
      redactionActivityEvents.push(event);
      return event;
    }
  },
  journal: {
    append(entry) {
      redactionJournalEntries.push(entry);
    }
  }
});
const redacted = await redactionRouter.generate('utilityArbiter', { prompt: 'Do not log sk-live-secret', snapshotHash: 'single-snapshot-hash' }, { timeoutMs: 2345 });
assertEqual(redacted.ok, true, 'redaction route succeeds');
assertEqual(redacted.diagnostics.runId, 'activity-assigned-run', 'returned diagnostics use activity-assigned run id');
assertEqual(redacted.diagnostics.snapshotHash, 'single-snapshot-hash', 'single provider diagnostics record request snapshot hash');
assertEqual(redacted.diagnostics.timeoutMs, 2345, 'single provider diagnostics record effective timeout');
assertDeepEqual(
  redactionJournalEntries.map((entry) => entry.status),
  ['started', 'success'],
  'provider journal records started before completion'
);
assertEqual(redactionJournalEntries[0].roleId, 'utilityArbiter', 'started journal records role id');
assertEqual(redactionJournalEntries[0].lane, 'utility', 'started journal records lane');
assertEqual(redactionJournalEntries[0].runId, 'activity-assigned-run', 'started journal uses activity-assigned run id');
assertEqual(redactionJournalEntries[0].requestHash, redacted.diagnostics.requestHash, 'started journal records request hash');
assertEqual(redactionJournalEntries[0].snapshotHash, 'single-snapshot-hash', 'started journal records request snapshot hash');
assertEqual(redactionJournalEntries[0].timeoutMs, 2345, 'started journal records effective timeout');
assertEqual(redactionJournalEntries.at(-1).runId, 'activity-assigned-run', 'journal uses activity-assigned run id');
assertEqual(redactionJournalEntries.at(-1).snapshotHash, 'single-snapshot-hash', 'success journal records request snapshot hash');
assertEqual(redactionJournalEntries.at(-1).timeoutMs, 2345, 'success journal records effective timeout');
assertEqual(redactionActivityEvents.at(-1).runId, 'activity-assigned-run', 'settle activity uses activity-assigned run id');
assertNoSecret(redacted.diagnostics, 'diagnostics do not leak API keys');
assertNoSecret(redactionActivityEvents, 'activity events do not leak API keys');
assertNoSecret(redactionJournalEntries, 'journal entries do not leak API keys');
assert(!JSON.stringify(redactionJournalEntries).includes('Do not log'), 'journal does not include raw prompts');

let asyncOrderJournal = [];
const asyncOrderRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          return { text: responseTextForRole('utilityArbiter') };
        }
      }
    },
    settingsStore: createStore()
  }),
  journal: {
    async append(entry) {
      const snapshot = asyncOrderJournal.slice();
      await new Promise((resolve) => setTimeout(resolve, entry.status === 'started' ? 10 : 0));
      asyncOrderJournal = [...snapshot, entry];
    }
  }
});
const asyncOrder = await asyncOrderRouter.generate('utilityArbiter', { prompt: 'Async journal ordering.' });
assertEqual(asyncOrder.ok, true, 'async journal ordering route succeeds');
await new Promise((resolve) => setTimeout(resolve, 20));
assertDeepEqual(
  asyncOrderJournal.map((entry) => entry.status),
  ['started', 'success'],
  'async provider journal preserves started before completion without lost writes'
);

const failurePrompt = 'Provider should not echo this prompt';
const failureRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          const error = new Error(`provider echoed ${failurePrompt} and sk-live-secret`);
          error.code = 'RECURSION_HOST_ECHO';
          error.retryable = false;
          throw error;
        }
      }
    },
    settingsStore: createStore()
  })
});
const failedRedaction = await failureRouter.generate('utilityArbiter', { prompt: failurePrompt });
assertEqual(failedRedaction.ok, false, 'provider failure returns structured result');
assertNoSecret(failedRedaction, 'provider failure result redacts secret-like text');
assert(!JSON.stringify(failedRedaction).includes(failurePrompt), 'provider failure result redacts echoed prompt');

const messageLeakMarker = 'MESSAGE_PROMPT_LEAK_42';
const messageFailureActivity = [];
const messageFailureJournal = [];
const messageFailureRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          const error = new Error(`provider echoed ${messageLeakMarker}`);
          error.code = 'RECURSION_MESSAGE_ECHO';
          error.retryable = false;
          throw error;
        }
      }
    },
    settingsStore: createStore()
  }),
  activity: {
    stage(event) {
      messageFailureActivity.push(event);
    },
    settle(event) {
      messageFailureActivity.push(event);
    }
  },
  journal: {
    append(entry) {
      messageFailureJournal.push(entry);
    }
  }
});
const messageFailure = await messageFailureRouter.generate('utilityArbiter', {
  messages: [{ role: 'user', content: messageLeakMarker }]
});
assertEqual(messageFailure.ok, false, 'message failure returns structured result');
assert(!JSON.stringify(messageFailure).includes(messageLeakMarker), 'message failure result redacts echoed message content');
assert(!JSON.stringify(messageFailureActivity).includes(messageLeakMarker), 'message failure activity redacts echoed message content');
assert(!JSON.stringify(messageFailureJournal).includes(messageLeakMarker), 'message failure journal redacts echoed message content');

const messageCodeLeakMarker = 'MESSAGE_CODE_LEAK_99';
const messageCodeActivity = [];
const messageCodeJournal = [];
const messageCodeRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          const error = new Error('provider failed with coded marker');
          error.code = `RECURSION_${messageCodeLeakMarker}`;
          error.retryable = false;
          throw error;
        }
      }
    },
    settingsStore: createStore()
  }),
  activity: {
    settle(event) {
      messageCodeActivity.push(event);
    }
  },
  journal: {
    append(entry) {
      messageCodeJournal.push(entry);
    }
  }
});
const messageCodeFailure = await messageCodeRouter.generate('utilityArbiter', {
  messages: [{ role: 'user', content: messageCodeLeakMarker }]
});
assertEqual(messageCodeFailure.ok, false, 'message-code failure returns structured result');
assert(!JSON.stringify(messageCodeFailure).includes(messageCodeLeakMarker), 'message-code failure result redacts echoed code content');
assert(!JSON.stringify(messageCodeActivity).includes(messageCodeLeakMarker), 'message-code failure activity redacts echoed code content');
assert(!JSON.stringify(messageCodeJournal).includes(messageCodeLeakMarker), 'message-code failure journal redacts echoed code content');

let timeoutAttempts = 0;
let timeoutSignalAborted = false;
const timeoutRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate(request) {
          timeoutAttempts += 1;
          request.signal?.addEventListener('abort', () => {
            timeoutSignalAborted = true;
          });
          return new Promise(() => {});
        }
      }
    },
    settingsStore: createStore()
  }),
  timeoutMs: 5
});
const timedOut = await timeoutRouter.generate('utilityArbiter', { prompt: 'Never resolves' });
assertEqual(timedOut.ok, false, 'timeout returns failure result');
assertEqual(timedOut.error.code, 'RECURSION_PROVIDER_TIMEOUT', 'timeout exposes stable code');
assertEqual(timeoutAttempts, 2, 'timeout retries once before returning failure');
assertEqual(timedOut.diagnostics.retryCount, 1, 'failed timeout retry records retry count');
assertEqual(timeoutSignalAborted, true, 'timeout aborts in-flight provider signal');

let retryableTimeoutAttempts = 0;
const retryableTimeoutRouter = createGenerationRouter({
  client: {
    async generate(request) {
      retryableTimeoutAttempts += 1;
      if (retryableTimeoutAttempts === 1) {
        request.signal?.addEventListener('abort', () => {});
        return new Promise(() => {});
      }
      return { text: responseTextForRole('utilityArbiter') };
    }
  },
  timeoutMs: 5
});
const retryableTimeout = await retryableTimeoutRouter.generate('utilityArbiter', { prompt: 'Retry timeout once' });
assertEqual(retryableTimeout.ok, true, 'router timeout retries once while current');
assertEqual(retryableTimeoutAttempts, 2, 'router timeout makes one retry attempt');
assertEqual(retryableTimeout.diagnostics.retryCount, 1, 'router timeout retry records retry count');

console.log('[pass] providers');
