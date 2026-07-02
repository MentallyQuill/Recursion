import {
  FOOTPRINT_SECTION_BUDGETS,
  FOCUS_BOOSTED_FAMILIES,
  influencePolicyForSettings,
  runPolicyForEffectivePlan,
  summarizeBehaviorPolicyForDiagnostics
} from '../../src/settings-policy.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const defaultPolicy = influencePolicyForSettings({});
assertEqual(defaultPolicy.strength.level, 'balanced', 'default policy uses balanced strength');
assertEqual(defaultPolicy.focus.level, 'balanced', 'default policy uses balanced focus');
assertEqual(defaultPolicy.footprint.level, 'normal', 'default policy uses normal footprint');
assertDeepEqual(defaultPolicy.cardBudget, { minCards: 3, normalCards: 6, maxCards: 10 }, 'default policy exposes derived card budget range');
assertDeepEqual(defaultPolicy.focus.boostedFamilies, [], 'balanced focus has no boosted families');
assertDeepEqual(defaultPolicy.footprint.sectionBudgets, FOOTPRINT_SECTION_BUDGETS.normal, 'normal footprint exposes normal budgets');

const strongPolicy = influencePolicyForSettings({
  strength: 'strong',
  focus: 'character',
  promptFootprint: 'compact',
  reasoningLevel: 'low',
  injection: { placement: 'in_chat', role: 'assistant', depth: 7 }
});
assertEqual(strongPolicy.strength.refreshPressure, 'high', 'strong increases refresh pressure');
assertEqual(strongPolicy.strength.composerAssertiveness, 'firm', 'strong uses firm composer assertiveness');
assertEqual(strongPolicy.footprint.level, 'compact', 'strong does not change stored footprint');
assertEqual(strongPolicy.reasoningLevel, 'low', 'strong does not change reasoning level');
assertEqual(strongPolicy.injection.depth, 7, 'strong does not change injection depth');
assert(strongPolicy.strength.arbiterLine.includes('Do not increase footprint size'), 'strong arbiter line preserves footprint ownership');
assertDeepEqual(
  influencePolicyForSettings({ minCards: 4, maxCards: 13 }).cardBudget,
  { minCards: 4, normalCards: 8, maxCards: 13 },
  'policy derives normal card budget from min/max average'
);

assertDeepEqual(
  influencePolicyForSettings({ focus: 'character' }).focus.boostedFamilies,
  ['Active Cast', 'Character Motivation', 'Relationship', 'Social Subtext', 'Knowledge'],
  'character focus boosts expected families'
);
assertDeepEqual(
  influencePolicyForSettings({ focus: 'constraints' }).focus.boostedFamilies,
  ['Scene Constraints', 'Items', 'Consequences', 'Scene Frame', 'Knowledge'],
  'constraints focus boosts expected families'
);
assertDeepEqual(
  influencePolicyForSettings({ focus: 'scene' }).focus.boostedFamilies,
  ['Scene Frame', 'Environment', 'Items', 'Active Cast'],
  'scene focus boosts expected families'
);
assert(!Object.prototype.hasOwnProperty.call(FOCUS_BOOSTED_FAMILIES, 'pr' + 'ose'), 'removed craft focus has no policy');
assert(!Object.prototype.hasOwnProperty.call(FOCUS_BOOSTED_FAMILIES, 'continuity'), 'removed continuity focus has no policy');
assertDeepEqual(
  influencePolicyForSettings({ focus: 'plot' }).focus.boostedFamilies,
  FOCUS_BOOSTED_FAMILIES.plot,
  'plot focus boosts expected families'
);

const richPolicy = influencePolicyForSettings({ promptFootprint: 'rich' });
assertEqual(richPolicy.footprint.detailPressure, 'rich', 'rich footprint targets more detail');
assertDeepEqual(richPolicy.footprint.sectionBudgets, FOOTPRINT_SECTION_BUDGETS.rich, 'rich footprint exposes rich budgets');

const compactPolicy = influencePolicyForSettings({ promptFootprint: 'compact' });
assertEqual(compactPolicy.footprint.detailPressure, 'compact', 'compact footprint targets terse detail');
assertDeepEqual(compactPolicy.footprint.sectionBudgets, FOOTPRINT_SECTION_BUDGETS.compact, 'compact footprint exposes compact budgets');

const compactStoredRichEffective = runPolicyForEffectivePlan({
  promptFootprint: 'compact',
  focus: 'scene',
  strength: 'strong'
}, {
  promptFootprint: 'rich',
  diagnostics: ['footprint-risk-override'],
  budgets: { targetBriefTokens: 900, maxCards: 9 }
});
assertEqual(compactStoredRichEffective.footprint.level, 'compact', 'run policy preserves stored footprint');
assertEqual(compactStoredRichEffective.footprint.effectiveLevel, 'rich', 'run policy records effective footprint');
assertDeepEqual(compactStoredRichEffective.footprint.sectionBudgets, FOOTPRINT_SECTION_BUDGETS.rich, 'run policy uses effective rich section budgets');
assertDeepEqual(compactStoredRichEffective.cardBudget, { minCards: 3, normalCards: 6, maxCards: 10 }, 'run policy keeps card budget separate from effective footprint');
assert(compactStoredRichEffective.footprint.composerLine.includes('Rich'), 'run policy composer line uses effective rich footprint');
assertEqual(compactStoredRichEffective.footprint.footprintOverrideReason, 'footprint-risk-override', 'run policy preserves footprint override reason');
const effectiveDiagnostics = summarizeBehaviorPolicyForDiagnostics(compactStoredRichEffective, {
  selectedFamilies: ['Scene Frame']
});
assertEqual(effectiveDiagnostics.storedFootprint, 'compact', 'diagnostics preserve stored footprint');
assertEqual(effectiveDiagnostics.effectiveFootprint, 'rich', 'diagnostics expose effective footprint');
assertEqual(effectiveDiagnostics.footprintOverrideReason, 'footprint-risk-override', 'diagnostics expose footprint override reason');

assertEqual(
  influencePolicyForSettings({ strength: 'secret-strong', focus: 'mindread', promptFootprint: 'huge' }).strength.level,
  'balanced',
  'invalid strength falls back safely'
);
assertEqual(
  influencePolicyForSettings({ strength: 'secret-strong', focus: 'mindread', promptFootprint: 'huge' }).focus.level,
  'balanced',
  'invalid focus falls back safely'
);
assertEqual(
  influencePolicyForSettings({ strength: 'secret-strong', focus: 'mindread', promptFootprint: 'huge' }).footprint.level,
  'normal',
  'invalid footprint falls back safely'
);

const diagnostics = summarizeBehaviorPolicyForDiagnostics(influencePolicyForSettings({
  strength: 'strong',
  focus: 'character',
  promptFootprint: 'normal'
}), {
  effectiveFootprint: 'rich',
  footprintOverrideReason: 'high-scene-constraint-risk',
  selectedFamilies: ['Active Cast', 'Scene Constraints', 'Character Motivation'],
  planShaping: ['strong-refresh-pressure', 'focus-family-ordering']
});
assertDeepEqual(diagnostics.boostedFamilies, FOCUS_BOOSTED_FAMILIES.character, 'diagnostics expose boosted families');
assertEqual(diagnostics.selectedBoostedCards, 2, 'diagnostics count selected boosted families');
assertEqual(diagnostics.storedFootprint, 'normal', 'diagnostics expose stored footprint');
assertEqual(diagnostics.effectiveFootprint, 'rich', 'diagnostics expose effective footprint');
assert(!JSON.stringify(diagnostics).includes('secret'), 'diagnostics stay sanitized');

console.log('[pass] settings-policy');
