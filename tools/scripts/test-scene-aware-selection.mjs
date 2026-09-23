import { strict as assert } from 'node:assert';
import { limitCardJobsForHandBudget, normalizeCard, selectHand } from '../../src/cards.mjs';

const scenes = [
  { name: 'identity revelation', proposed: ['Knowledge', 'Character Motivation', 'Relationship', 'Scene Frame', 'Scene Constraints', 'Active Cast'], want: ['Knowledge', 'Character Motivation', 'Relationship'] },
  { name: 'blocked escape', proposed: ['Environment', 'Items', 'Consequences', 'Scene Frame', 'Scene Constraints', 'Active Cast'], want: ['Environment', 'Items', 'Consequences'] }
];
for (const scene of scenes) {
  const result = limitCardJobsForHandBudget(scene.proposed.map(family => ({ family, reason: scene.name })), { maxCards: 6, reservedCardSlots: 3 });
  assert.deepEqual(result.cardJobs.map(job => job.family), scene.want, `${scene.name}: scene relevance must survive budgeting`);
  const cards = scene.proposed.slice().reverse().map(family => normalizeCard({ family, promptText: 'Keep established evidence.', status: 'active' }));
  const hand = selectHand(cards, { maxCards: 3, selectionOrder: scene.proposed });
  assert.deepEqual(hand.cards.map(card => card.family), scene.want, `${scene.name}: final hand must preserve Arbiter order even if generation completes in reverse order`);
}
const required = limitCardJobsForHandBudget([{ family: 'Knowledge' }, { family: 'Environment' }], { maxCards: 1, reservedCardSlots: 3, forcedFamilies: ['Environment'] });
assert.deepEqual(required.cardJobs.map(job => job.family), ['Environment'], 'mandatory generated family survives exhausted discretionary capacity');
console.log('[pass] scene-aware card selection');
