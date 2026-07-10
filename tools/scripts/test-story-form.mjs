import {
  STORY_FORM_SCHEMA,
  STORY_FORM_OVERRIDE_OPTIONS,
  UNKNOWN_STORY_FORM,
  arbiterStoryFormContractLine,
  forcedStoryForm,
  heuristicPov,
  heuristicTense,
  normalizeStoryForm,
  normalizeStoryFormWithHeuristic,
  storyFormInstruction,
  storyFormPromptBlock
} from '../../src/story-form.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const valid = normalizeStoryForm({
  schema: STORY_FORM_SCHEMA,
  tense: 'past',
  pov: 'third-person-limited',
  confidence: 'high',
  evidenceRefs: ['message:42', 'raw-secret'],
  reason: 'Latest assistant narration uses past tense third person.'
});

assertEqual(valid.schema, STORY_FORM_SCHEMA, 'valid story form keeps schema');
assertEqual(valid.tense, 'past', 'valid story form keeps tense');
assertEqual(valid.pov, 'third-person-limited', 'valid story form keeps pov');
assertEqual(valid.confidence, 'high', 'valid story form keeps confidence');
assertDeepEqual(valid.evidenceRefs, ['message:42'], 'story form keeps only safe message refs');
assertEqual(valid.reason, 'Latest assistant narration uses past tense third person.', 'story form keeps safe reason');

const invalid = normalizeStoryForm({
  schema: 'wrong',
  tense: 'future',
  pov: 'camera',
  confidence: 'certain',
  evidenceRefs: ['message:2'],
  reason: 'bad values'
});

assertEqual(invalid.schema, STORY_FORM_SCHEMA, 'invalid story form still returns current schema');
assertEqual(invalid.tense, 'unknown', 'invalid tense falls back');
assertEqual(invalid.pov, 'unknown', 'invalid pov falls back');
assertEqual(invalid.confidence, 'low', 'invalid confidence falls back');
assertDeepEqual(invalid.evidenceRefs, [], 'invalid schema drops evidence refs');
assert(invalid.reason.includes('story form unavailable'), 'invalid schema uses safe fallback reason');

assertDeepEqual(normalizeStoryForm(null), UNKNOWN_STORY_FORM, 'null story form returns unknown constant shape');
assert(storyFormInstruction(valid).includes('past tense, third-person-limited POV'), 'instruction names target form');
assert(storyFormInstruction(UNKNOWN_STORY_FORM).includes("active chat's established story form"), 'unknown instruction stays conservative');
assert(storyFormPromptBlock(valid).includes('Target tense: past.'), 'prompt block includes tense');
assert(storyFormPromptBlock(valid).includes('Target POV: third-person-limited.'), 'prompt block includes pov');
assert(storyFormPromptBlock(valid).includes('Do not switch to first person'), 'prompt block forbids drift');
assert(arbiterStoryFormContractLine().includes('latest visible assistant narration first'), 'Arbiter contract names assistant-first source rule');
assert(arbiterStoryFormContractLine().includes(STORY_FORM_SCHEMA), 'Arbiter contract names schema');

assert(STORY_FORM_OVERRIDE_OPTIONS.includes('present-third-limited'), 'override options include present third limited');
assert(STORY_FORM_OVERRIDE_OPTIONS.includes('past-mixed'), 'override options include past mixed POV');
assert(STORY_FORM_OVERRIDE_OPTIONS.includes('present-mixed'), 'override options include present mixed POV');
assertEqual(heuristicTense('Mara walked to the door, looked back, and said nothing.'), 'past', 'heuristic detects past tense narration');
assertEqual(heuristicPov('Mara looked back. She held the key because her hand shook and she hated the lock.'), 'third-person-limited', 'heuristic detects third-person narration');
assertEqual(
  heuristicPov('You cross the room and touch the lock. She watches from the doorway and thinks the sound came too soon. You hear the key turn. Her hand tightens around the lamp.'),
  'mixed',
  'heuristic detects present mixed POV across narrative segments'
);
assertEqual(
  heuristicPov('I crossed the room and remembered the old oath. She watched from the doorway and feared the lock. I knew the key would turn. Her hand tightened around the lamp.'),
  'mixed',
  'heuristic detects past mixed POV across narrative segments'
);
assertEqual(
  heuristicPov('"I saw you," Mara said. "You saw me too." She crossed the room. Her hand shook as she opened the door.'),
  'third-person-limited',
  'dialogue pronouns do not create mixed POV'
);

const forced = forcedStoryForm('present-third-limited');
assertEqual(forced.tense, 'present', 'forced story form sets tense');
assertEqual(forced.pov, 'third-person-limited', 'forced story form sets pov');
assertEqual(forced.confidence, 'high', 'forced story form is high confidence');
assertEqual(forcedStoryForm('auto'), null, 'auto override does not force story form');

const forcedPastMixed = forcedStoryForm('past-mixed');
assertEqual(forcedPastMixed.tense, 'past', 'past mixed override sets tense');
assertEqual(forcedPastMixed.pov, 'mixed', 'past mixed override sets pov');
assertEqual(forcedPastMixed.reason, 'User forced past tense, mixed POV.', 'past mixed override explains forced form');
const forcedPresentMixed = forcedStoryForm('present-mixed');
assertEqual(forcedPresentMixed.tense, 'present', 'present mixed override sets tense');
assertEqual(forcedPresentMixed.pov, 'mixed', 'present mixed override sets pov');
assertEqual(forcedPresentMixed.reason, 'User forced present tense, mixed POV.', 'present mixed override explains forced form');
assert(storyFormInstruction(forcedPresentMixed).includes('present tense, mixed POV'), 'mixed instruction names target form');
assert(storyFormPromptBlock(forcedPresentMixed).includes('Preserve the established mixed POV pattern'), 'mixed prompt block preserves hybrid pattern');
assert(storyFormPromptBlock(forcedPresentMixed).includes('Do not collapse'), 'mixed prompt block prevents single-POV collapse');
assert(arbiterStoryFormContractLine().includes('intentional alternation between narrative viewpoint families'), 'Arbiter contract defines mixed POV');
assert(arbiterStoryFormContractLine().includes('Do not infer mixed POV from dialogue pronouns'), 'Arbiter contract rejects dialogue false positives');
assert(arbiterStoryFormContractLine().includes('present+mixed or past+mixed'), 'Arbiter contract keeps tense separate from mixed POV');

const corrected = normalizeStoryFormWithHeuristic({
  schema: STORY_FORM_SCHEMA,
  tense: 'present',
  pov: 'first-person',
  confidence: 'high',
  evidenceRefs: ['message:7'],
  reason: 'Arbiter followed the pending user message.'
}, UNKNOWN_STORY_FORM, 'Mara walked to the door. She looked back and held the key. Her hand shook.');
assertEqual(corrected.tense, 'unknown', 'heuristic conflict clears incorrect tense');
assertEqual(corrected.pov, 'unknown', 'heuristic conflict clears incorrect pov');
assertEqual(corrected.confidence, 'low', 'heuristic conflict lowers confidence');

const mixedCorrected = normalizeStoryFormWithHeuristic({
  schema: STORY_FORM_SCHEMA,
  tense: 'present',
  pov: 'second-person',
  confidence: 'high',
  evidenceRefs: ['message:10'],
  reason: 'Arbiter saw second person.'
}, UNKNOWN_STORY_FORM, 'You cross the room and touch the lock. She watches from the doorway and thinks the sound came too soon. You hear the key turn. Her hand tightens around the lamp.');
assertEqual(mixedCorrected.tense, 'present', 'mixed POV cross-check preserves stable tense');
assertEqual(mixedCorrected.pov, 'mixed', 'heuristic can normalize high-confidence single POV to mixed when mixed evidence is strong');
assertEqual(mixedCorrected.confidence, 'medium', 'mixed POV cross-check keeps usable confidence');
