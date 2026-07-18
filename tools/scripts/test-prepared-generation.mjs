import { cloneJson, hashJson } from '../../src/core.mjs';
import { composePromptPacket } from '../../src/prompt.mjs';
import {
  PREPARED_GENERATION_VERSION,
  compareGenerationBasis,
  createPreparedGenerationArtifact,
  preparedGenerationIntegrityIsValid,
  summarizePreparedGenerationArtifact,
  validatePreparedGenerationArtifact
} from '../../src/runtime/prepared-generation.mjs';
import { assert, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

function baseHand() {
  return {
    handId: 'prepared-hand-1',
    cards: [{
      id: 'prepared-card-1',
      family: 'Scene Frame',
      promptText: 'PREPARED_PACKET_CANARY: preserve the immediate scene boundary.',
      tokenEstimate: 12,
      evidenceRefs: ['message:1']
    }],
    omitted: [{
      cardId: 'prepared-card-omitted',
      family: 'Open Threads',
      reason: 'token-budget',
      tokenEstimate: 8
    }]
  };
}

async function basePacket() {
  const snapshot = {
    chatId: 'prepared-chat',
    sceneFingerprint: 'prepared-scene',
    turnFingerprint: 'prepared-turn'
  };
  return composePromptPacket({
    runId: 'prepared-generation-test',
    hand: baseHand(),
    snapshot,
    settings: { promptFootprint: 'normal', reasonerUse: 'off' },
    precomposedGuidance: {
      schema: 'recursion.guidanceComposer.v1',
      snapshotHash: hashJson(snapshot),
      guidanceText: 'PREPARED_GUIDANCE_CANARY: write only the next response.',
      sourceCardIds: ['prepared-card-1'],
      guardrailCardIds: [],
      omittedCardIds: [],
      diagnostics: ['prepared-test']
    }
  });
}

function sourceIdentity(mesid, textHash, overrides = {}) {
  return { mesid, role: 'user', textHash, ...overrides };
}

function baseBasis(overrides = {}) {
  return {
    chatKey: 'prepared-chat',
    sceneKey: 'prepared-scene-key',
    sceneFingerprint: 'prepared-scene',
    latestMesId: 42,
    sourceRevisionHash: 'source-revision-1',
    sourceWindow: [
      sourceIdentity(40, 'hash-40'),
      sourceIdentity(41, 'hash-41', { swipeId: 1, swipeCount: 2, activeSwipeTextHash: 'swipe-hash-41' }),
      sourceIdentity(42, 'hash-42')
    ],
    sourceWindowContractHash: 'window-contract-1',
    ...overrides
  };
}

function baseContract(overrides = {}) {
  return {
    preparedGenerationVersion: PREPARED_GENERATION_VERSION,
    promptPacketVersion: 3,
    runtimeCacheContractVersion: 1,
    promptContractHash: 'prompt-contract-1',
    providerContractHash: 'provider-contract-1',
    cardCatalogHash: 'catalog-1',
    activeDeckRevisionHash: 'deck-1',
    cardEligibilityHash: 'eligibility-1',
    packetInputHash: 'packet-input-1',
    ...overrides
  };
}

function rehashArtifact(artifact) {
  const { artifactHash, ...body } = artifact;
  return { ...body, artifactHash: hashJson(body) };
}

const packet = await basePacket();
const hand = baseHand();
const basis = baseBasis();
const contract = baseContract();
const artifact = createPreparedGenerationArtifact({ packet, hand, basis, contract });

assertEqual(artifact.schema, 'recursion.preparedGeneration.v1', 'artifact uses the V1 schema');
assertEqual(artifact.version, PREPARED_GENERATION_VERSION, 'artifact uses the V1 version');
assert(typeof artifact.preparedAt === 'string' && artifact.preparedAt.length > 0, 'artifact records preparation time');
assert(preparedGenerationIntegrityIsValid(artifact), 'fresh artifact integrity is valid');

for (const [name, mutate] of [
  ['packet', (value) => { value.packet.sections.guidance = 'tampered packet'; }],
  ['hand', (value) => { value.hand.cards[0].promptText = 'tampered hand'; }],
  ['basis', (value) => { value.basis.sourceWindow[0].textHash = 'tampered basis'; }],
  ['contract', (value) => { value.contract.packetInputHash = 'tampered contract'; }],
  ['preparedAt', (value) => { value.preparedAt = '2000-01-01T00:00:00.000Z'; }]
]) {
  const tampered = cloneJson(artifact);
  mutate(tampered);
  assert(!preparedGenerationIntegrityIsValid(tampered), `${name} tampering invalidates integrity`);
}

await assertRejects(
  () => Promise.resolve(createPreparedGenerationArtifact({
    packet: { ...packet, packetVersion: 999 },
    hand,
    basis,
    contract
  })),
  /packetVersion/,
  'invalid prompt packets are rejected during artifact creation'
);
await assertRejects(
  () => Promise.resolve(createPreparedGenerationArtifact({
    packet,
    hand: { cards: [] },
    basis,
    contract
  })),
  /hand is invalid/,
  'hands without omitted arrays are rejected during artifact creation'
);

for (const [field, invalidValue] of [
  ['chatKey', ''],
  ['sceneKey', ''],
  ['sceneFingerprint', ''],
  ['sourceRevisionHash', ''],
  ['sourceWindowContractHash', ''],
  ['latestMesId', Number.NaN]
]) {
  await assertRejects(
    () => Promise.resolve(createPreparedGenerationArtifact({
      packet,
      hand,
      basis: baseBasis({ [field]: invalidValue }),
      contract
    })),
    /basis is invalid/,
    `artifact creation rejects malformed basis ${field}`
  );
}

for (const [name, sourceWindow] of [
  ['missing mesid', [{ role: 'user', textHash: 'hash' }]],
  ['invalid role', [sourceIdentity(40, 'hash', { role: 'tool' })]],
  ['empty text hash', [sourceIdentity(40, '')]],
  ['invalid swipe id', [sourceIdentity(40, 'hash', { swipeId: Number.NaN })]],
  ['invalid swipe count', [sourceIdentity(40, 'hash', { swipeCount: Number.POSITIVE_INFINITY })]],
  ['empty active swipe hash', [sourceIdentity(40, 'hash', { activeSwipeTextHash: '' })]]
]) {
  await assertRejects(
    () => Promise.resolve(createPreparedGenerationArtifact({
      packet,
      hand,
      basis: baseBasis({ sourceWindow }),
      contract
    })),
    /basis is invalid/,
    `artifact creation rejects source identity with ${name}`
  );
}

for (const [field, invalidValue] of [
  ['preparedGenerationVersion', undefined],
  ['promptPacketVersion', Number.NaN],
  ['runtimeCacheContractVersion', Number.NaN],
  ['promptContractHash', ''],
  ['providerContractHash', ''],
  ['cardCatalogHash', ''],
  ['activeDeckRevisionHash', ''],
  ['cardEligibilityHash', ''],
  ['packetInputHash', '']
]) {
  await assertRejects(
    () => Promise.resolve(createPreparedGenerationArtifact({
      packet,
      hand,
      basis,
      contract: baseContract({ [field]: invalidValue })
    })),
    /contract is invalid/,
    `artifact creation rejects malformed contract ${field}`
  );
}

for (const [name, mutate] of [
  ['missing source revision hash', (value) => { delete value.basis.sourceRevisionHash; }],
  ['malformed source role', (value) => { value.basis.sourceWindow[0].role = 'tool'; }],
  ['missing packet input hash', (value) => { delete value.contract.packetInputHash; }],
  ['empty prompt contract hash', (value) => { value.contract.promptContractHash = ''; }]
]) {
  const malformed = cloneJson(artifact);
  mutate(malformed);
  assert(
    !preparedGenerationIntegrityIsValid(rehashArtifact(malformed)),
    `integrity rejects ${name} even when its hash is recomputed`
  );
}

const exact = compareGenerationBasis(basis, cloneJson(basis));
assertEqual(exact.matches, true, 'identical bases match');
assertEqual(exact.mode, 'exact', 'identical bases use exact mode');
assertEqual(exact.reason, 'basis-exact', 'identical bases use exact reason');

const suffixBasis = baseBasis({
  sourceRevisionHash: 'source-revision-after-host-bounding',
  sourceWindow: basis.sourceWindow.slice(1)
});
const boundedSuffix = compareGenerationBasis(basis, suffixBasis, { allowBoundedSuffix: true });
assertEqual(boundedSuffix.matches, true, 'shorter observable suffix matches when enabled');
assertEqual(boundedSuffix.mode, 'bounded-suffix', 'shorter observable suffix reports bounded mode');
assertEqual(boundedSuffix.reason, 'basis-observable-suffix', 'shorter observable suffix reports bounded reason');
assertEqual(compareGenerationBasis(basis, suffixBasis).reason, 'basis-window-mismatch', 'suffix matching is disabled by default');

const equalLengthChanged = baseBasis({
  sourceRevisionHash: 'source-revision-after-edit',
  sourceWindow: [...basis.sourceWindow.slice(0, 2), sourceIdentity(42, 'changed-hash')]
});
assertEqual(compareGenerationBasis(basis, equalLengthChanged, { allowBoundedSuffix: true }).reason, 'basis-window-mismatch', 'equal-length changed input cannot use suffix matching');
assertEqual(compareGenerationBasis(basis, baseBasis({ sourceWindow: [] })).reason, 'basis-window-empty', 'empty current windows miss');
assertEqual(compareGenerationBasis(baseBasis({ sourceWindow: [] }), basis).reason, 'basis-window-empty', 'empty expected windows miss');
assertEqual(compareGenerationBasis(basis, baseBasis({ chatKey: 'other-chat' })).reason, 'basis-metadata-mismatch', 'metadata differences miss');
for (const [name, invalidBasis] of [
  ['missing source revision hash', baseBasis({ sourceRevisionHash: '' })],
  ['malformed source identity', baseBasis({ sourceWindow: [{ mesid: 40, role: 'tool', textHash: 'hash-40' }] })]
]) {
  assertEqual(
    compareGenerationBasis(basis, invalidBasis, { allowBoundedSuffix: true }).matches,
    false,
    `${name} never produces an exact or suffix hit`
  );
}

for (const [name, current] of [
  ['observable edit', baseBasis({ sourceRevisionHash: 'edited', sourceWindow: [basis.sourceWindow[0], { ...basis.sourceWindow[1], textHash: 'edited' }, basis.sourceWindow[2]] })],
  ['observable insertion', baseBasis({ sourceRevisionHash: 'inserted', sourceWindow: [basis.sourceWindow[0], sourceIdentity(401, 'inserted'), basis.sourceWindow[1], basis.sourceWindow[2]] })],
  ['non-prefix deletion', baseBasis({ sourceRevisionHash: 'deleted', sourceWindow: [basis.sourceWindow[0], basis.sourceWindow[2]] })],
  ['swipe identity change', baseBasis({ sourceRevisionHash: 'swiped', sourceWindow: [basis.sourceWindow[0], { ...basis.sourceWindow[1], swipeId: 2 }, basis.sourceWindow[2]] })]
]) {
  assertEqual(compareGenerationBasis(basis, current, { allowBoundedSuffix: true }).reason, 'basis-window-mismatch', `${name} misses the basis`);
}

assertEqual(validatePreparedGenerationArtifact(artifact, { basis, packetInputHash: contract.packetInputHash, forceFresh: true }).reason, 'force-fresh', 'force fresh bypasses a valid artifact');
assertEqual(validatePreparedGenerationArtifact(null, { basis, packetInputHash: contract.packetInputHash }).reason, 'artifact-missing', 'missing artifact reports a miss');
assertEqual(validatePreparedGenerationArtifact({ ...artifact, artifactHash: 'invalid' }, { basis, packetInputHash: contract.packetInputHash }).reason, 'artifact-integrity', 'invalid artifact reports invalid integrity');
assertEqual(validatePreparedGenerationArtifact(artifact, { basis: equalLengthChanged, packetInputHash: contract.packetInputHash }).reason, 'generation-basis-mismatch', 'basis mismatch reports a miss');
assertEqual(validatePreparedGenerationArtifact(artifact, { basis, packetInputHash: 'other-input' }).reason, 'packet-input-mismatch', 'packet input mismatch reports a miss');
assertEqual(validatePreparedGenerationArtifact(artifact, { basis }).reason, 'packet-input-mismatch', 'absent packet input hash is rejected');
assertEqual(validatePreparedGenerationArtifact(artifact, { basis, packetInputHash: '' }).reason, 'packet-input-mismatch', 'empty packet input hash is rejected');

const exactHit = validatePreparedGenerationArtifact(artifact, { basis, packetInputHash: contract.packetInputHash });
assertEqual(exactHit.decision, 'hit', 'exact artifact basis is a hit');
assertEqual(exactHit.reason, 'prepared-generation-exact-match', 'exact artifact hit uses contract reason');
assertEqual(exactHit.basisMode, 'exact', 'exact artifact hit reports basis mode');

const suffixHit = validatePreparedGenerationArtifact(artifact, {
  basis: suffixBasis,
  packetInputHash: contract.packetInputHash,
  allowBoundedSuffix: true
});
assertEqual(suffixHit.decision, 'hit', 'bounded suffix basis is a hit when enabled');
assertEqual(suffixHit.basisMode, 'bounded-suffix', 'bounded suffix hit reports basis mode');

const summary = summarizePreparedGenerationArtifact({
  ...artifact,
  packet: {
    ...artifact.packet,
    packetId: 'PREPARED_PACKET_ID_CANARY',
    privateSecret: 'sk-prepared-secret',
    providerProfileId: 'PREPARED_PROFILE_ID_CANARY',
    providerResponse: 'PREPARED_PROVIDER_RESPONSE_CANARY',
    sections: { ...artifact.packet.sections, guidance: 'Bearer prepared-token PREPARED_PACKET_CANARY' }
  },
  hand: { ...artifact.hand, cards: [{ ...artifact.hand.cards[0], promptText: 'PREPARED_PACKET_CANARY sk-prepared-secret' }] },
  basis: {
    ...artifact.basis,
    chatKey: 'PREPARED_CHAT_KEY_CANARY',
    sceneKey: 'PREPARED_SCENE_KEY_CANARY',
    sourceText: 'PREPARED_TRANSCRIPT_CANARY'
  },
  contract: { ...artifact.contract, endpoint: 'https://prepared.example/v1', model: 'prepared-model', apiKey: 'sk-prepared-secret' }
});
const serializedSummary = JSON.stringify(summary);
for (const canary of [
  'PREPARED_PACKET_CANARY',
  'PREPARED_TRANSCRIPT_CANARY',
  'https://prepared.example/v1',
  'prepared-model',
  'sk-prepared-secret',
  'Bearer prepared-token',
  'PREPARED_PROFILE_ID_CANARY',
  'PREPARED_PROVIDER_RESPONSE_CANARY',
  'PREPARED_CHAT_KEY_CANARY',
  'PREPARED_SCENE_KEY_CANARY',
  'PREPARED_PACKET_ID_CANARY'
]) {
  assert(!serializedSummary.includes(canary), `safe summary excludes ${canary}`);
}
assertEqual(summary.schema, 'recursion.preparedGeneration.v1', 'safe summary retains schema identity');
assertEqual(summary.integrityValid, false, 'safe summary reports integrity without leaking body content');

console.log('prepared generation contract tests passed');
