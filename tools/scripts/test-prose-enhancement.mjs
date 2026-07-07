import {
  BANNED_AI_SLOP_LIST,
  PROSE_ENHANCER_SCHEMA,
  buildProseEnhancementRequest,
  dialogueSpans,
  proseEnhancementKey,
  validateProseEnhancementResult
} from '../../src/prose-enhancement.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const sourceText = [
  'Mara felt it like a punch to the chest. "I felt it like a punch to the chest," she said.',
  'She was angry. She walked across the room.'
].join('\n');

const request = buildProseEnhancementRequest({
  text: sourceText,
  contextMessages: [
    { role: 'user', text: 'What happens next?' },
    { role: 'assistant', text: sourceText }
  ],
  storyForm: { tense: 'past', pov: 'third-person-limited' },
  contextMessageLimit: 13
});

assertEqual(PROSE_ENHANCER_SCHEMA, 'recursion.proseEnhancer.v1', 'prose enhancer schema is stable');
assert(request.prompt.includes('<text_to_transform>'), 'prose enhancement prompt marks transform text');
assert(request.prompt.includes('Do not change any dialogue. Not a single word.'), 'prompt carries Recast dialogue protection');
assert(request.prompt.includes('The dialogue-protection rule has one explicit exception'), 'prompt names banned-list dialogue exception');
assert(request.prompt.includes('## Core banned AI slop and clichés'), 'prompt includes the full banned AI slop list heading');
assert(request.prompt.includes('* felt it like a physical blow'), 'prompt includes the first banned-list bullet intact');
assert(request.prompt.includes('* controlled chaos'), 'prompt includes the final banned-list bullet intact');
assert(request.prompt.includes(sourceText), 'prompt includes source text');
assertEqual(request.responseSchema, PROSE_ENHANCER_SCHEMA, 'request carries response schema');
assertEqual(request.responseLength, 4096, 'request uses bounded response length');
assert(BANNED_AI_SLOP_LIST.includes('## Core banned AI slop and clichés'), 'exported banned list keeps heading intact');
assert(BANNED_AI_SLOP_LIST.includes('* controlled chaos'), 'exported banned list keeps final bullet intact');

const dialogue = dialogueSpans('He nodded. "Do not change this." Then he left.');
assertEqual(dialogue.length, 1, 'dialogue spans detects quoted dialogue');
assertEqual(dialogue[0].text, '"Do not change this."', 'dialogue span includes quote delimiters');

assertEqual(
  proseEnhancementKey({ chatKey: 'chat-a', messageId: 4, swipeId: 0, originalHash: 'abc' }),
  'chat-a::4::0::abc',
  'prose enhancement duplicate key is stable'
);

const accepted = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: 'Mara staggered. "I felt it like a punch to the chest," she said.\nShe crossed the room.'
}, { originalText: sourceText });
assertEqual(accepted.ok, true, 'validator accepts prose-only edits with exact dialogue intact');

const acceptedDialogueSlopCleanup = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: 'Mara felt it like a punch to the chest. "It hit hard," she said.\nShe was angry. She walked across the room.'
}, { originalText: sourceText });
assertEqual(acceptedDialogueSlopCleanup.ok, true, 'validator allows dialogue edits limited to banned-list cleanup');

const rejectedDialogueChange = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: 'Mara nodded. "I was fine," she said.'
}, { originalText: 'Mara nodded. "Keep the door shut," she said.' });
assertEqual(rejectedDialogueChange.ok, false, 'validator rejects ordinary dialogue changes');
assertEqual(rejectedDialogueChange.error.code, 'RECURSION_PROSE_DIALOGUE_CHANGED', 'dialogue rejection uses stable code');

const rejectedExpansion = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: `${sourceText}\nA new stranger entered with a lantern.`
}, { originalText: sourceText });
assertEqual(rejectedExpansion.ok, false, 'validator rejects large new-detail expansion');

console.log('[pass] prose enhancement');
