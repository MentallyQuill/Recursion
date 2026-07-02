import {
  CARD_SCOPE_CATALOG,
  CARD_SCOPE_TOTAL_SUB_ITEMS,
  cardScopeCounts,
  cardScopeLabel,
  defaultCardScope,
  enabledSubItemsForFamily,
  familyState,
  filterCardJobsForScope,
  filterCardsForScope,
  normalizeCardScope,
  scopePayloadForArbiter,
  setFamilyEnabled,
  setSubItemEnabled
} from '../../src/card-scope.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const EXPECTED_SCOPE_CATALOG = Object.freeze([
  {
    family: 'Scene Frame',
    role: 'sceneFrameCard',
    subItems: ['locationSituation', 'immediateDirection', 'beatConstraint']
  },
  {
    family: 'Active Cast',
    role: 'activeCastCard',
    subItems: ['presentCharacters', 'visibleState', 'speakerRoles']
  },
  {
    family: 'Character Motivation',
    role: 'characterMotivationCard',
    subItems: ['visibleGoals', 'pressures', 'hesitationPosture']
  },
  {
    family: 'Relationship',
    role: 'dialogueRelationshipCard',
    subItems: ['tension', 'promisesConflicts', 'voiceConstraints']
  },
  {
    family: 'Social Subtext',
    role: 'socialSubtextCard',
    subItems: ['humorIrony', 'veiledPressure', 'invitationBoundary', 'statusFace']
  },
  {
    family: 'Scene Constraints',
    role: 'sceneConstraintsCard',
    subItems: ['hardLimits', 'spatialConstraints', 'timelineOrder']
  },
  {
    family: 'Knowledge',
    role: 'knowledgeSecretsCard',
    subItems: ['concealedFacts', 'knowsSuspects', 'revealBoundaries']
  },
  {
    family: 'Consequences',
    role: 'clocksConsequencesCard',
    subItems: ['deadlinesCountdowns', 'delayedConsequences', 'escalationTriggers']
  },
  {
    family: 'Environment',
    role: 'environmentAffordancesCard',
    subItems: ['spatialLayout', 'sensoryTexture', 'hazardsAffordances']
  },
  {
    family: 'Items',
    role: 'possessionsItemsCard',
    subItems: ['heldCarriedItems', 'itemLocationControl', 'itemAffordancesRisks']
  },
  {
    family: 'Open Threads',
    role: 'openThreadsCard',
    subItems: ['unresolvedQuestions', 'pendingActions', 'nearTermPressures']
  }
]);

assertEqual(CARD_SCOPE_CATALOG.length, 11, 'scope catalog mirrors audited V1 scene-reasoning families');
assertDeepEqual(
  CARD_SCOPE_CATALOG.map((family) => ({
    family: family.family,
    role: family.role,
    subItems: family.subItems.map((item) => item.key)
  })),
  EXPECTED_SCOPE_CATALOG,
  'scope catalog membership, roles, and sub-item order match audited V1 plan'
);
assert(CARD_SCOPE_CATALOG.every((family) => !family.family.includes('/')), 'card scope category labels are single-focus names without slashes');
assert(CARD_SCOPE_CATALOG.every((family) => family.subItems.length >= 2), 'each family has sub-items');
assertEqual(CARD_SCOPE_TOTAL_SUB_ITEMS, 34, 'scope catalog exposes audited V1 focus count');
assertEqual(
  CARD_SCOPE_TOTAL_SUB_ITEMS,
  CARD_SCOPE_CATALOG.reduce((sum, family) => sum + family.subItems.length, 0),
  'scope total matches catalog sub-items'
);
for (const family of CARD_SCOPE_CATALOG) {
  assert(
    typeof family.description === 'string' && family.description.length >= 24,
    `${family.family} family has useful description`
  );
  for (const item of family.subItems) {
    assert(
      typeof item.description === 'string' && item.description.length >= 40,
      `${family.family}/${item.key} has useful sub-item description`
    );
    assert(!/\bTBD\b|\bTODO\b/i.test(item.description), `${family.family}/${item.key} description is final copy`);
  }
}

const legacyCraftFamily = 'Pr' + 'ose';
const legacyRiskFamily = 'Continuity ' + 'Risk';
const serializedScopeCatalog = JSON.stringify(CARD_SCOPE_CATALOG);
for (const removed of [legacyCraftFamily, 'prose' + 'PacingCard', 'den' + 'sity', 'momentum', 'specificity' + 'Shape', legacyRiskFamily, 'continuity' + 'RiskCard', 'fragile' + 'Facts', 'present' + 'Participants']) {
  assert(!serializedScopeCatalog.includes(removed), `removed catalog item is absent: ${removed}`);
}

const scenePayload = scopePayloadForArbiter({ mode: 'auto', cardScope: defaultCardScope() })
  .availableCatalog.find((entry) => entry.family === 'Scene Frame');
assert(
  scenePayload.subItems.find((item) => item.key === 'beatConstraint').description.includes('avoid time skip'),
  'Arbiter catalog payload includes beat constraint description'
);

const all = defaultCardScope();
const allCounts = cardScopeCounts(all);
assertEqual(allCounts.selectedSubItems, allCounts.totalSubItems, 'defaults select every sub-item');
assertEqual(cardScopeLabel(all), 'Cards', 'all-selected label is Cards');
assertEqual(familyState(all, 'Scene Frame'), 'on', 'default family state is on');
assertDeepEqual(
  enabledSubItemsForFamily(all, 'Scene Frame'),
  ['locationSituation', 'immediateDirection', 'beatConstraint'],
  'enabled sub-items preserve catalog order'
);

const noScene = setFamilyEnabled(all, 'Scene Frame', false).scope;
assertEqual(noScene.families['Scene Frame'].enabled, false, 'family toggle off disables family');
assert(Object.values(noScene.families['Scene Frame'].subItems).every((value) => value === false), 'family off disables sub-items');
assertEqual(familyState(noScene, 'Scene Frame'), 'off', 'disabled family state is off');

const restoredScene = setFamilyEnabled(noScene, 'Scene Frame', true).scope;
assertEqual(restoredScene.families['Scene Frame'].enabled, true, 'family toggle on enables family');
assert(Object.values(restoredScene.families['Scene Frame'].subItems).every((value) => value === true), 'family on restores all sub-items');

const mixed = setSubItemEnabled(all, 'Scene Constraints', 'timelineOrder', false).scope;
assertEqual(mixed.families['Scene Constraints'].enabled, true, 'partial sub-item keeps family enabled');
assertEqual(familyState(mixed, 'Scene Constraints'), 'mixed', 'partial family state is mixed');
assertEqual(cardScopeCounts(mixed).selectedSubItems, allCounts.totalSubItems - 1, 'sub-item toggle changes count');
assertEqual(cardScopeLabel(mixed), `${allCounts.totalSubItems - 1}/${allCounts.totalSubItems}`, 'partial label is selected/total');

let oneLeft = all;
for (const family of CARD_SCOPE_CATALOG) {
  for (const item of family.subItems) {
    if (family.family === 'Open Threads' && item.key === 'pendingActions') continue;
    oneLeft = setSubItemEnabled(oneLeft, family.family, item.key, false).scope;
  }
}
const blocked = setSubItemEnabled(oneLeft, 'Open Threads', 'pendingActions', false);
assertEqual(blocked.blocked, true, 'final sub-item disable is blocked');
assertEqual(blocked.reason, 'zero-selection', 'zero-selection block reason is stable');
assertEqual(cardScopeCounts(blocked.scope).selectedSubItems, 1, 'zero-selection guard preserves last sub-item');

const removedNormalized = normalizeCardScope({
  families: {
    [legacyCraftFamily]: { enabled: true, subItems: { ['den' + 'sity']: true } },
    [legacyRiskFamily]: { enabled: true, subItems: { ['fragile' + 'Facts']: true } }
  }
});
assert(!removedNormalized.families[legacyCraftFamily], 'removed craft family is dropped');
assert(!removedNormalized.families[legacyRiskFamily], 'removed risk family is dropped');
assertEqual(removedNormalized.families['Scene Constraints'].enabled, true, 'new Scene Constraints defaults on after old scope is dropped');

const normalized = normalizeCardScope({
  families: {
    Unknown: { enabled: false, subItems: { nope: false } },
    'Scene Frame': { enabled: true, subItems: { locationSituation: false } }
  }
});
assert(!normalized.families.Unknown, 'unknown family is dropped');
assertEqual(normalized.families['Scene Frame'].subItems.locationSituation, false, 'known sub-item persists');
assertEqual(normalized.families['Scene Frame'].subItems.immediateDirection, true, 'missing sub-item defaults on');

const manualPayload = scopePayloadForArbiter({ mode: 'manual', cardScope: noScene });
assertEqual(manualPayload.strictWhitelist, true, 'Manual payload is strict');
assert(!manualPayload.allowedCatalog.some((entry) => entry.family === 'Scene Frame'), 'Manual payload omits disabled family');
assertEqual(manualPayload.autoExceptionFamilies.length, 0, 'Manual payload has no auto exception families');

const autoPayload = scopePayloadForArbiter({ mode: 'auto', cardScope: noScene });
assertEqual(autoPayload.strictWhitelist, false, 'Auto payload is focus');
assert(autoPayload.availableCatalog.some((entry) => entry.family === 'Scene Frame'), 'Auto payload keeps full catalog available');
assertDeepEqual(autoPayload.autoExceptionFamilies, CARD_SCOPE_CATALOG.map((entry) => entry.family), 'Auto payload exposes every family as eligible for high-relevance exceptions');

const manualJobs = filterCardJobsForScope([
  { family: 'Scene Frame', role: 'sceneFrameCard' },
  { family: 'Open Threads', role: 'openThreadsCard' }
], { mode: 'manual', cardScope: noScene });
assertDeepEqual(manualJobs.cardJobs.map((job) => job.family), ['Open Threads'], 'Manual drops disabled card jobs');
assertEqual(manualJobs.omitted.length, 1, 'Manual reports omitted job');
assertEqual(manualJobs.omitted[0].reason, 'manual-scope-omitted:Scene Frame', 'Manual omission reason is compact');

const autoJobs = filterCardJobsForScope([
  { family: 'Scene Frame', role: 'sceneFrameCard' },
  { family: 'Open Threads', role: 'openThreadsCard' }
], { mode: 'auto', cardScope: noScene });
assertDeepEqual(autoJobs.cardJobs.map((job) => job.family), ['Scene Frame', 'Open Threads'], 'Auto keeps disabled-focus card jobs available');

const manualCards = filterCardsForScope([
  { id: 'scene', family: 'Scene Frame', role: 'sceneFrameCard' },
  { id: 'thread', family: 'Open Threads', role: 'openThreadsCard' }
], { mode: 'manual', cardScope: noScene });
assertDeepEqual(manualCards.cards.map((card) => card.id), ['thread'], 'Manual drops disabled cards');
assertEqual(manualCards.omitted[0].reason, 'manual-scope-omitted:Scene Frame', 'Manual card omission reason is compact');

console.log('[pass] card-scope');
