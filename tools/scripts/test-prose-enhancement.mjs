import {
  BANNED_AI_SLOP_LIST,
  PROSE_ENHANCER_SCHEMA,
  buildProseEnhancementRequest,
  dialogueSpans,
  proseEnhancementKey,
  proseInterventionReasons,
  validateProseEnhancementResult
} from '../../src/prose-enhancement.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const sourceText = [
  'Mara felt it like a punch to the chest. "I felt it like a punch to the chest," she said.',
  'She was angry. She walked across the room.'
].join('\n');

const request = buildProseEnhancementRequest({
  text: sourceText,
  contextMessages: [
    { role: 'user', sender: 'Will', text: 'What happens next?' },
    { role: 'assistant', sender: 'Mara', text: sourceText }
  ],
  cardContext: [
    { family: 'Scene Constraints', text: 'Keep the action grounded and practical.' },
    { family: 'Social Subtext', text: 'Mara hides concern behind motion.' }
  ],
  storyForm: { tense: 'past', pov: 'third-person-limited' },
  contextMessageLimit: 13
});

assertEqual(PROSE_ENHANCER_SCHEMA, 'recursion.proseEnhancer.v1', 'prose enhancer schema is stable');
assert(request.prompt.includes('<text_to_transform>'), 'prose enhancement prompt marks transform text');
assert(request.prompt.includes('Do not change any dialogue. Not a single word.'), 'prompt carries Recast dialogue protection');
assert(request.prompt.includes('You may rewrite non-dialogue prose freely'), 'prompt allows freer non-dialogue prose rewriting');
assert(request.prompt.includes('The dialogue-protection rule has one explicit exception'), 'prompt names banned-list dialogue exception');
assert(request.prompt.includes('## Core banned AI slop and clichés'), 'prompt includes the full banned AI slop list heading');
assert(request.prompt.includes('* felt it like a physical blow'), 'prompt includes the first banned-list bullet intact');
assert(request.prompt.includes('* controlled chaos'), 'prompt includes the final banned-list bullet intact');
assert(request.prompt.includes('<recursion_card_context>'), 'prose prompt includes card context section');
assert(request.prompt.includes('Mara hides concern behind motion.'), 'prose prompt includes safe card context text');
assert(request.prompt.includes(sourceText), 'prompt includes source text');
assert(request.prompt.includes('Minimum edit ratio: 10%'), 'prose prompt states minimum edit ratio');
assert(request.prompt.includes('Target edit ratio: 10-20%'), 'prose prompt states target edit ratio band');
assert(request.prompt.includes('Soft maximum edit ratio: 30%'), 'prose prompt states soft maximum edit ratio');
assert(
  buildProseEnhancementRequest({ text: 'O\'Neill said, "We come back with authorization and a plan."' }).prompt.includes('authorization and a plan'),
  'prose prompt preserves ordinary story use of authorization'
);
assertEqual(request.responseSchema, PROSE_ENHANCER_SCHEMA, 'request carries response schema');
assertEqual(request.responseLength, 4096, 'request uses bounded response length');
assert(BANNED_AI_SLOP_LIST.includes('## Core banned AI slop and clichés'), 'exported banned list keeps heading intact');
assert(BANNED_AI_SLOP_LIST.includes('* controlled chaos'), 'exported banned list keeps final bullet intact');
assertDeepEqual(
  proseInterventionReasons(sourceText),
  ['banned-phrase'],
  'banned phrase requires prose intervention'
);

const dialogue = dialogueSpans('He nodded. "Do not change this." Then he left.');
assertEqual(dialogue.length, 1, 'dialogue spans detects quoted dialogue');
assertEqual(dialogue[0].text, '"Do not change this."', 'dialogue span includes quote delimiters');
const singleQuotedDialogue = dialogueSpans("He nodded. 'Do not change this.' Then he left.");
assertEqual(singleQuotedDialogue.length, 1, 'dialogue spans detects single-quoted dialogue');
assertEqual(singleQuotedDialogue[0].text, "'Do not change this.'", 'single-quoted dialogue span includes quote delimiters');
assertEqual(dialogueSpans("Mara's hand didn't move. The door's latch held.").length, 0, 'dialogue spans ignores prose apostrophes');

assertEqual(
  proseEnhancementKey({ chatKey: 'chat-a', messageId: 4, swipeId: 0, originalHash: 'abc' }),
  'chat-a::4::0::abc',
  'prose enhancement duplicate key is stable'
);

const accepted = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: 'Mara staggered, steadied herself on the table, and crossed the room. "I felt it like a punch to the chest," she said.\nHer anger narrowed into motion.'
}, { originalText: sourceText });
assertEqual(accepted.ok, true, 'validator accepts prose-only edits with exact dialogue intact');

const rejectedNoopBannedPhrase = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: sourceText
}, { originalText: sourceText });
assertEqual(rejectedNoopBannedPhrase.ok, false, 'prose no-op is rejected when banned slop is detected');
assertEqual(
  rejectedNoopBannedPhrase.error.code,
  'RECURSION_PROSE_NOOP_WITH_DETECTED_SLOP',
  'prose no-op rejection uses stable code'
);

const cleanProseNoop = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: 'Mara crossed the room. "Keep the door shut," she said.'
}, { originalText: 'Mara crossed the room. "Keep the door shut," she said.' });
assertEqual(cleanProseNoop.ok, true, 'prose no-op remains valid when no deterministic slop is detected');
assertEqual(cleanProseNoop.editRatio, 0, 'prose validation reports no-op edit ratio without rejecting it');

const dialogueOnlySlopNoop = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: 'Mara kept her hand on the latch. "Do not get the wrong idea, this is purely tactical."'
}, { originalText: 'Mara kept her hand on the latch. "Do not get the wrong idea, this is purely tactical."' });
assertEqual(dialogueOnlySlopNoop.ok, true, 'prose no-op does not veto dialogue-only slop after Dialogue pass');

const acceptedDialogueSlopCleanup = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: 'Mara felt it like a punch to the chest. "It hit hard," she said.\nShe was angry. She walked across the room.'
}, { originalText: sourceText });
assertEqual(acceptedDialogueSlopCleanup.ok, true, 'validator allows dialogue edits limited to banned-list cleanup');

const acceptedApostropheProse = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: "Mara's hand stayed on the latch. She didn't move."
}, { originalText: 'Mara put her hand on the latch. She stayed still.' });
assertEqual(acceptedApostropheProse.ok, true, 'validator does not mistake prose apostrophes for changed dialogue');

const rejectedDialogueChange = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: 'Mara nodded. "I was fine," she said.'
}, { originalText: 'Mara nodded. "Keep the door shut," she said.' });
assertEqual(rejectedDialogueChange.ok, false, 'validator rejects ordinary dialogue changes');
assertEqual(rejectedDialogueChange.error.code, 'RECURSION_PROSE_DIALOGUE_CHANGED', 'dialogue rejection uses stable code');

const acceptedExpansion = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: [
    'Mara reeled, caught herself, and crossed the room with her hands clenched at her sides.',
    '"I felt it like a punch to the chest," she said.',
    'Her anger stayed in her shoulders and in the sharp set of her pace.'
  ].join('\n')
}, { originalText: sourceText });
assertEqual(acceptedExpansion.ok, true, 'validator allows freer non-dialogue expansion when dialogue is intact');

console.log('[pass] prose enhancement');
