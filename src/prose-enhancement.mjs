import { compact, hashJson, truncate } from './core.mjs';

export const PROSE_ENHANCER_SCHEMA = 'recursion.proseEnhancer.v1';

const MAX_CONTEXT_TEXT = 12000;
const MAX_TARGET_TEXT = 12000;
const SECRET_PATTERN = /(raw[-_\s]*prompt|rawPrompt|provider[-_\s]*response|hidden[-_\s]*reasoning|api[-_\s]*key|authorization|bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]+)/ig;

export const BANNED_AI_SLOP_LIST = String.raw`## Core banned AI slop and clichés

### Physical-impact metaphors

* felt it like a physical blow
* hit like a physical blow
* struck like a physical blow
* landed like a blow
* hit like a fist to the chest
* hit like ice water
* hit like a punch to the gut
* the words struck him
* the words landed
* the realization crashed over them
* the truth slammed into them
* the weight of his words settled
* the words hung in the air
* the silence settled over them
* the moment settled between them

### Breath, throat, chest, and heartbeat loops

* a breath she didn't know she was holding
* breath hitched
* breath caught
* drew in a breath
* let out a breath
* exhaled slowly
* inhaled sharply
* released a shaky breath
* swallowed thickly
* throat tightened
* chest tightened
* heart raced
* pulse quickened
* heart skipped a beat
* a shiver ran down her spine
* a jolt ran through him
* goosebumps rose on her skin
* caught her breath
* couldn't breathe
* forgot how to breathe

### Generic tension atmosphere

* time seemed to stop
* the tension was palpable
* the air grew thick
* the air crackled
* electricity crackled between them
* the silence spoke volumes
* a silence that spoke louder than words
* the world fell away
* everything else faded
* the room seemed smaller
* the moment stretched
* the moment hung suspended
* an unspoken understanding passed between them
* something shifted between them
* neither of them moved
* neither of them spoke
* for a long moment
* for what felt like forever

### Face, eyes, gaze, jaw

* eyes widened
* pupils dilated
* gaze softened
* gaze darkened
* gaze flickered
* gaze dropped
* searched their face for
* looked at him, really looked at him
* studied his face
* jaw clenched
* jaw tightened
* jaw set
* jaw worked
* jaw opened and closed
* lips parted
* lips twitched
* mouth opened, then closed
* brows furrowed
* expression unreadable
* something unreadable crossed his face
* eyes flashed with something

### Voice and delivery clichés

* voice dropped
* voice caught
* voice softened
* voice barely above a whisper
* voice turned low
* voice was rough
* voice was thick with emotion
* murmured
* whispered
* purred
* growled
* said softly
* said quietly
* said gently
* said, too casually
* the words came out before she could stop them
* before he could think better of it
* despite himself
* couldn't help but

### Micro-gesture loops

* fingers brushed
* fingers ghosted over
* traced lazy circles
* traced patterns on skin
* hand hovered
* hand lingered
* lingered a bit too long
* leaned against the doorframe
* leaned in close
* tilted his head
* cocked his head
* tucked a strand of hair behind her ear
* reached out, then stopped
* froze
* stiffened
* flinched
* knuckles whitened
* dug crescent moons into his palms
* nails bit into his palm
* lip caught between teeth
* bit her lip hard enough to draw blood
* heels clicked
* collarbones drew attention

### False-profundity sentence structures

* not just X, but Y
* not X. Not Y. Just Z.
* no words. No movement. Only X.
* for the first time
* and somehow, that was enough
* something almost like a laugh
* something not quite a smile
* a sound somewhere between X and Y
* the kind of X that Y
* as if X itself had Y
* as though the universe had narrowed to this
* a key turning in a lock
* a lock he didn't know existed
* a truth he wasn't ready to name
* an answer to a question she hadn't asked
* the weight of everything unsaid
* unspoken promise
* unspoken question
* unspoken challenge
* unspoken permission

### Emotional abstraction filler

* a mix of
* a mixture of
* a hint of
* a flicker of
* a flash of
* a trace of
* a spark of
* a pang of
* a wave of
* a rush of
* a surge of
* a storm of
* a cocktail of
* something like
* something close to
* something almost
* something unreadable
* something primal
* something ancient
* something dangerous
* something vulnerable
* something raw

### Forced romance / attraction clichés

* he was a man starved and she was a feast
* hungry gaze
* predatory gaze
* possessive growl
* feral need
* primal need
* ruin you
* ruin you for anyone else
* you're mine
* mark you
* claim you
* devour you
* worship you
* make you forget your own name
* kiss-swollen lips
* kissed hard enough to bruise
* bruising kiss
* dangerous game
* playing with fire
* you're going to be the death of me
* you menace
* be gentle
* I've never done anything like this before
* last chance to back out
* tell me what you want
* once I start, I won't stop

### Forced question endings and fake agency

* what do you say?
* what do you want?
* what now?
* your move
* the choice is yours
* do you want to X, or Y?
* are you going to X, or will you Y?
* will you X, or will you Y?
* or something else entirely
* what brings you here?
* what do you do for fun?
* what are your hobbies?
* what makes you tick?
* would you prefer this, or that?
* shall we continue?
* where do we go from here?

### Echoing and parroting

* repeats the user's exact phrase as a question
* restates the user's action before responding
* "So that's what we're calling it now?"
* "You really just said X."
* "You're either very X or very Y. Probably both."
* "No one ever X before."
* "Let's not get ahead of ourselves."
* "Just because you X, don't think Y."
* "Try not to X too much."
* "Don't X too hard."
* "You're enjoying this, aren't you?"
* "You have no idea what you're doing to me."

### Scene-setting slop

* dust motes
* golden light
* warm light
* dimly lit room
* neon glow
* scent of ozone
* ozone in the air
* metallic tang
* coppery tang
* smell of rain
* scent uniquely hers
* something distinctly him
* something distinctly you
* masculine scent
* feminine scent
* the city hummed outside
* somewhere, a dog barked
* somewhere, X happened
* outside, X; inside, Y
* the sun dipped below the horizon
* sunset arrived suddenly
* the room felt charged
* shadows danced

### Tsundere / defensive deflection slop

* it's not like I care
* don't get the wrong idea
* purely for research
* purely for educational purposes
* this is just tactical
* tactical retreat
* strategic maneuver
* adequate
* acceptable
* hmph
* idiot
* don't think this means anything
* I'm only doing this because
* you're impossible
* you're insufferable
* you're annoying, you know that?
* I hate that you're right

### Over-technical or out-of-character diction

* structural integrity
* assessing variables
* recalibrating
* hypothesis
* data point
* optimal
* inefficient
* adequate
* acceptable
* statistically
* biologically
* physiologically
* strategically
* tactically
* non-negotiable
* utterly
* completely
* quiet and efficient
* clinical precision
* predatory grace
* controlled chaos`;

function safeText(value, limit = MAX_CONTEXT_TEXT) {
  return truncate(compact(String(value ?? '').replace(SECRET_PATTERN, '[redacted]')), limit);
}

function contextLine(message = {}) {
  const role = ['assistant', 'user', 'system'].includes(String(message.role || '').toLowerCase())
    ? String(message.role).toLowerCase()
    : 'assistant';
  return `${role}: ${safeText(message.text ?? message.mes ?? message.content, 1200)}`;
}

export function buildProseEnhancementRequest({
  text = '',
  contextMessages = [],
  contextMessageLimit = 13,
  storyForm = null
} = {}) {
  const targetText = truncate(String(text ?? '').replace(SECRET_PATTERN, '[redacted]'), MAX_TARGET_TEXT);
  const limit = Math.max(0, Math.min(35, Math.round(Number(contextMessageLimit) || 0)));
  const sceneContext = (Array.isArray(contextMessages) ? contextMessages : []).slice(-limit).map(contextLine).join('\n');
  const storyFormLine = storyForm && typeof storyForm === 'object'
    ? `Story form: ${safeText(JSON.stringify(storyForm), 600)}`
    : 'Story form: infer from source text.';
  const prompt = [
    'You are a prose editor. Your only job is to improve how <text_to_transform> reads without changing what it says.',
    'Rules:',
    '- Do not change any dialogue. Not a single word.',
    '- Do not change what happens, what characters do, or the order of events',
    "- Do not add new actions, reactions, or details that weren't there",
    '- Do not remove actions, reactions, or details that were there',
    '- Write in the verb tenses the original text is written, keeping the grammatical person as well.',
    '- Prioritize avoiding repetition of descriptive words by changing the phrase or removing it altogether',
    '',
    'What you may change:',
    '- Sentence length variation, break up monotonous rhythm, mix short and long',
    '- Eliminate repeated sentence structures, especially consecutive sentences starting the same way',
    '- Convert telling to showing, remove emotion labels and replace with physical behavior or action',
    '- Cut filler phrases that carry no meaning',
    '- Tighten overly wordy constructions without losing meaning',
    '- Favor flowing sentences connected by conjunctions over short stopped ones',
    "- Remove any unnecessary 'waiting' at the end of the dialog, if that wait is already clear by the text or cannot be implemented naturally with something else, then remove it",
    '',
    'The dialogue-protection rule has one explicit exception: if exact dialogue contains banned AI slop from the list below, remove or neutralize that banned pattern with the smallest possible wording change. Do not otherwise rewrite dialogue.',
    'Do not replace one banned pattern with a neighboring cliché. If a phrase is empty atmosphere or filler, cut it rather than swapping in a synonym.',
    'Do not rename existing characters or add new names to avoid a cliché.',
    '',
    BANNED_AI_SLOP_LIST,
    '',
    'Use the scene context only to match the established prose tone and style of the exchange. Do not drift from the register already set.',
    storyFormLine,
    '<scene_context>',
    sceneContext,
    '</scene_context>',
    '<text_to_transform>',
    targetText,
    '</text_to_transform>',
    '',
    `Return strict JSON only: {"schema":"${PROSE_ENHANCER_SCHEMA}","text":"rewritten text"}. No explanations, no notes, no commentary.`
  ].join('\n');
  return {
    prompt,
    responseSchema: PROSE_ENHANCER_SCHEMA,
    responseLength: 4096,
    reasoningCategory: 'prose-enhancement',
    reasoningIntent: 'minimal',
    machineJson: true,
    contextMessages: (Array.isArray(contextMessages) ? contextMessages : []).slice(-limit)
  };
}

export function dialogueSpans(text = '') {
  const source = String(text ?? '');
  const spans = [];
  const pattern = /"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|“[^”\n]*(?:”|$)|‘[^’\n]*(?:’|$)/g;
  let match;
  while ((match = pattern.exec(source))) {
    spans.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return spans;
}

export function proseEnhancementKey({ chatKey = '', messageId = '', swipeId = 0, originalHash = '' } = {}) {
  return [chatKey, messageId, swipeId, originalHash].map((value) => String(value ?? '')).join('::');
}

function bannedPhrases() {
  return BANNED_AI_SLOP_LIST
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('* '))
    .map((line) => line.slice(2).replace(/^"|"$/g, '').toLowerCase())
    .filter(Boolean);
}

const BANNED_PHRASES = bannedPhrases();

function containsBannedPhrase(text = '') {
  const normalized = String(text ?? '').toLowerCase();
  if (/\b(felt|hit|struck|landed)\s+(?:it\s+)?like\b/.test(normalized)) return true;
  if (/\blike\s+(a\s+)?(physical\s+)?(blow|punch|fist|ice water)\b/.test(normalized)) return true;
  return BANNED_PHRASES.some((phrase) => {
    if (!phrase || /\bX\b/.test(phrase)) return false;
    return normalized.includes(phrase);
  });
}

function validationError(code, message) {
  return { ok: false, error: { code, message } };
}

export function validateProseEnhancementResult(result = {}, { originalText = '' } = {}) {
  const data = result && typeof result === 'object' ? result : {};
  if (data.schema !== PROSE_ENHANCER_SCHEMA) {
    return validationError('RECURSION_PROSE_SCHEMA_MISMATCH', 'Prose enhancement returned the wrong schema.');
  }
  const text = String(data.text ?? '');
  if (!text.trim()) return validationError('RECURSION_PROSE_EMPTY', 'Prose enhancement returned empty text.');
  if (text.length > MAX_TARGET_TEXT || text.length > String(originalText ?? '').length * 1.05 + 20) {
    return validationError('RECURSION_PROSE_EXPANDED', 'Prose enhancement expanded the message too much.');
  }
  const originalDialogue = dialogueSpans(originalText);
  const nextDialogue = dialogueSpans(text);
  if (originalDialogue.length !== nextDialogue.length) {
    return validationError('RECURSION_PROSE_DIALOGUE_CHANGED', 'Prose enhancement changed dialogue structure.');
  }
  for (let index = 0; index < originalDialogue.length; index += 1) {
    if (originalDialogue[index].text === nextDialogue[index].text) continue;
    if (containsBannedPhrase(originalDialogue[index].text)) continue;
    return validationError('RECURSION_PROSE_DIALOGUE_CHANGED', 'Prose enhancement changed dialogue.');
  }
  if (hashJson(text) === hashJson(String(originalText ?? ''))) {
    return { ok: true, text, unchanged: true };
  }
  return { ok: true, text };
}
