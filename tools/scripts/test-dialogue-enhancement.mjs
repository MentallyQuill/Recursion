import {
  DIALOGUE_ENHANCER_SCHEMA,
  buildDialogueEnhancementRequest,
  dialogueInterventionReasons,
  dialogueSuspicionReasons,
  validateDialogueEnhancementResult
} from '../../src/dialogue-enhancement.mjs';
import {
  enhancementContextFromSnapshot,
  speakerLabel
} from '../../src/enhancement-context.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

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
assert(request.prompt.includes('If any intervention-required pattern appears, do not return the original text unchanged.'), 'dialogue prompt explicitly forbids no-op when slop is detected');
assert(request.prompt.includes('Minimum edit ratio: 10%'), 'dialogue prompt states minimum edit ratio');
assert(request.prompt.includes('Target edit ratio: 10-20%'), 'dialogue prompt states target edit ratio band');
assert(request.prompt.includes('Soft maximum edit ratio: 30%'), 'dialogue prompt states soft maximum edit ratio');
assert(!request.prompt.includes('returning it unchanged is allowed'), 'dialogue prompt no longer allows clean no-op');
assert(request.prompt.includes('Always produce the best dialogue-focused revision candidate'), 'dialogue prompt requires a candidate');
assert(request.prompt.includes('Allowed dialogue edit levers'), 'dialogue prompt explains safe revision levers');
assert(request.prompt.includes('"changePlan"'), 'dialogue prompt requests optional change diagnostics');
assert(
  buildDialogueEnhancementRequest({ text: '"We come back with authorization and a plan."' }).prompt.includes('authorization and a plan'),
  'dialogue prompt preserves ordinary story use of authorization'
);

assertEqual(
  speakerLabel({ role: 'assistant', sender: 'Carter' }),
  'assistant(Carter)',
  'speaker label includes assistant sender name'
);

const enhancementContext = enhancementContextFromSnapshot({
  snapshot: {
    messages: [
      { role: 'assistant', sender: 'O\'Neill', text: 'O\'Neill folded his arms. "Carter?"', visible: true },
      { role: 'assistant', sender: 'Carter', text: 'Carter did not look up. "Working on it, sir."', visible: true },
      { role: 'user', sender: 'Will', text: 'Will waits.', visible: true }
    ]
  },
  hand: {
    cards: [
      { family: 'Active Cast', promptText: 'O\'Neill presses with dry understatement. Carter answers with technical brevity.' },
      { family: 'Social Subtext', promptText: 'SG-1 remains wary of Will but keeps the exchange professional.' },
      { family: 'Possessions & Items', promptText: 'Coffee mug on the table.' }
    ]
  },
  activeText: 'O\'Neill glanced over. "What do you want to do next?"',
  activeSender: 'SG-1',
  contextMessageLimit: 2
});

assertEqual(enhancementContext.contextMessages.length, 2, 'enhancement context respects context message limit');
assertEqual(enhancementContext.characterContext.name, 'SG-1', 'active sender becomes character context name');
assert(
  enhancementContext.characterContext.exampleDialogue.includes('"Working on it, sir."'),
  'recent dialogue examples are extracted from context messages'
);
assert(
  enhancementContext.cardContext.some((card) => card.family === 'Active Cast'),
  'enhancement card context keeps Active Cast'
);
assert(
  !enhancementContext.cardContext.some((card) => card.family === 'Possessions & Items'),
  'enhancement card context excludes low-voice item cards'
);

assertDeepEqual(
  dialogueInterventionReasons('Mara set the cup down. "What do you want to do next?"'),
  ['forced-question'],
  'forced agency question requires dialogue intervention'
);

const accepted = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: [
    'Mara set the cup down. "Call it whatever lets you sleep."',
    'She smiled softly. "Sit down before you fall over. We can argue after."'
  ].join('\n')
}, { originalText: original });
assertEqual(accepted.ok, true, 'validator accepts dialogue repair with stable narration shell');

const rejectedNoopForcedQuestion = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: 'Mara set the cup down. "What do you want to do next?"'
}, { originalText: 'Mara set the cup down. "What do you want to do next?"' });
assertEqual(rejectedNoopForcedQuestion.ok, false, 'dialogue no-op is rejected when forced-question slop is detected');
assertEqual(
  rejectedNoopForcedQuestion.error.code,
  'RECURSION_DIALOGUE_NOOP_WITH_DETECTED_SLOP',
  'dialogue no-op rejection uses stable code'
);

const cleanNoop = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: 'Mara set the cup down. "Sit down before you fall over."'
}, { originalText: 'Mara set the cup down. "Sit down before you fall over."' });
assertEqual(cleanNoop.ok, true, 'dialogue no-op remains valid when no deterministic slop is detected');
assertEqual(cleanNoop.editRatio, 0, 'dialogue validation reports no-op edit ratio without rejecting it');
assertEqual(cleanNoop.dialogueEditRatio, 0, 'dialogue validation reports no-op dialogue edit ratio without rejecting it');

const dialogueOnlyChange = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: 'Mara stayed beside the door. "Sit. We can argue after."'
}, { originalText: 'Mara stayed beside the door. "Sit down before you fall over."' });
assertEqual(dialogueOnlyChange.ok, true, 'dialogue validator accepts dialogue-only revision');
assert(dialogueOnlyChange.dialogueEditRatio > dialogueOnlyChange.editRatio, 'dialogue ratio is not diluted by narration');

assertDeepEqual(
  dialogueInterventionReasons('"Once I start, I won\'t stop."'),
  ['romance-cliche'],
  'strong romance cliche requires no-op intervention'
);
assertDeepEqual(
  dialogueSuspicionReasons('"Tell me what you want."'),
  ['generic-romance-heat'],
  'soft romance line is suspicion, not a hard ban'
);

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
