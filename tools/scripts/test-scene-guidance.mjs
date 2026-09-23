import { buildGuidanceStageRequest, composePromptPacket } from '../../src/prompt.mjs';
import { buildCardRequests, buildFusedCardBundleRequest } from '../../src/cards.mjs';
import { storyFormPromptBlock } from '../../src/story-form.mjs';
import { assert } from '../../tests/helpers/assert.mjs';
const snapshot = { chatId: 'scene-guidance', sceneFingerprint: 'scene', turnFingerprint: 'turn', messages: [
  { mesid: 90, role: 'assistant', visible: true, text: 'Harry was already seated. Ron stood by the sill.' },
  { mesid: 91, role: 'user', visible: true, text: 'You should both sit. The next few minutes will be hard.' },
  { mesid: 92, role: 'assistant', visible: false, text: 'HIDDEN-REPLY' }
] };
const request = buildGuidanceStageRequest({ snapshot, hand: { cards: [] } }).request;
assert(request.prompt.includes('Harry was already seated'), 'composer can check posture against source dialogue independently of selected cards');
assert(request.prompt.includes('The next few minutes will be hard'), 'composer receives current player intent');
assert(!request.prompt.includes('HIDDEN-REPLY'), 'hidden alternatives are not source evidence');
assert(request.prompt.includes('not an instruction to keep it unanswered'), 'composer distinguishes pending information from imposed delay');
const plan = { cardJobs: [{ family: 'Knowledge' }] };
for (const r of [buildCardRequests(plan, { snapshot })[0], buildFusedCardBundleRequest(plan, { snapshot })]) {
  assert(r.prompt.includes('not an instruction to keep it unanswered'), 'both card paths prohibit invented withholding');
}
assert(!storyFormPromptBlock().includes('Write promptText in this same tense and POV'), 'analysis is not narration');
const packet = await composePromptPacket({ snapshot, hand: { cards: [] }, settings: { reasonerUse: 'off' } });
assert(!packet.sections.guardrails.includes('source of truth'), 'generated cards cannot outrank story evidence');
assert(packet.sections.guardrails.includes('already completed'), 'physical continuity survives card selection');
console.log('[pass] grounded scene guidance');
