import {
  DIALOGUE_ENHANCER_SCHEMA,
  buildDialogueEnhancementRequest,
  validateDialogueEnhancementResult
} from '../../src/dialogue-enhancement.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const original = [
  'Mara set the cup down. "So that is what we are calling it now?"',
  'She smiled softly. "What do you want to do next?"'
].join('\n');

const request = buildDialogueEnhancementRequest({
  text: original,
  contextMessages: [
    { role: 'user', text: '"I did not say it was safe."' },
    { role: 'assistant', text: original }
  ],
  contextMessageLimit: 2,
  storyForm: { tense: 'past', pov: 'third-person-limited' },
  characterContext: {
    name: 'Mara',
    description: 'A guarded field medic who gives orders instead of reassurance.',
    exampleDialogue: ['"Sit down before you fall over."', '"We can argue after."']
  },
  cardContext: [
    { family: 'Social Subtext', text: 'Mara hides concern behind practical commands.' }
  ]
});

assertEqual(DIALOGUE_ENHANCER_SCHEMA, 'recursion.dialogueEnhancer.v1', 'dialogue enhancer schema is stable');
assert(request.prompt.includes('Echoing and parroting'), 'prompt names echoing priority');
assert(request.prompt.includes('Forced questions and fake agency'), 'prompt names fake agency priority');
assert(request.prompt.includes('Over-technical dialogue'), 'prompt names unsupported smart jargon priority');
assert(request.prompt.includes('Tsundere tropes'), 'prompt names defensive trope priority');
assert(request.prompt.includes('Attraction cliches'), 'prompt names attraction cliche priority');
assert(request.prompt.includes('What does the character want right now?'), 'prompt includes subtext reasoning ladder');
assert(request.prompt.includes('<text_to_transform>'), 'prompt marks transform text');
assert(request.prompt.includes('Mara hides concern behind practical commands.'), 'prompt includes safe card context');
assertEqual(request.responseSchema, DIALOGUE_ENHANCER_SCHEMA, 'request carries response schema');
assertEqual(request.machineJson, true, 'request requires machine JSON');
assertEqual(request.contextMessages.length, 2, 'request respects bounded context');

const accepted = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: [
    'Mara set the cup down. "Call it whatever lets you sleep."',
    'She smiled softly. "Sit down before you fall over. We can argue after."'
  ].join('\n')
}, { originalText: original });
assertEqual(accepted.ok, true, 'validator accepts dialogue repair with stable narration shell');

const rejectedNarrationDrift = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: [
    'Mara hurled the cup into the wall. "Call it whatever lets you sleep."',
    'She crossed the room and locked the door. "Sit down before you fall over."'
  ].join('\n')
}, { originalText: original });
assertEqual(rejectedNarrationDrift.ok, false, 'validator rejects changed scene events outside dialogue-adjacent repair');
assertEqual(rejectedNarrationDrift.error.code, 'RECURSION_DIALOGUE_NARRATION_CHANGED', 'narration drift uses stable error code');

const rejectedSchema = validateDialogueEnhancementResult({
  schema: 'recursion.proseEnhancer.v1',
  text: original
}, { originalText: original });
assertEqual(rejectedSchema.ok, false, 'validator rejects wrong schema');

console.log('[pass] dialogue enhancement');
