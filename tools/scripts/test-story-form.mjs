import {
  STORY_FORM_SCHEMA,
  UNKNOWN_STORY_FORM,
  arbiterStoryFormContractLine,
  normalizeStoryForm,
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
