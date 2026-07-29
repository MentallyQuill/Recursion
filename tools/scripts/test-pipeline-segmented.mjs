import { createSegmentedCardStages } from '../../src/runtime/preprocess-graph.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const requests = [];
const generated = [];
const stages = createSegmentedCardStages({
  selectedCards: ['character', 'setting'],
  createCardRequest(card) {
    requests.push(card);
    return { family: card };
  },
  validateCard(card, { selectedCard }) {
    return card?.family === selectedCard
      ? { ok: true, value: card }
      : { ok: false, error: { code: 'invalid-card' } };
  },
  async generateCard(request) {
    generated.push(request.family);
    return { family: request.family };
  }
});

assertDeepEqual(stages.map(({ id }) => id), [
  'preprocess.cards.segmented.character',
  'preprocess.cards.segmented.setting'
], 'Segmented creates one stable stage per selected card');
assert(stages.every((stage) => stage.executable), 'Segmented card stages own their actions');
assert(
  stages.every((stage) => stage.dependencies.includes('preprocess.arbiter')),
  'Segmented card stages share the Arbiter dependency'
);
assert(
  stages.every((stage) => stage.failurePolicy === 'continue'),
  'Segmented sibling failure does not discard successful card work'
);

for (const stage of stages) {
  const request = await stage.buildRequest({}, {
    'preprocess.arbiter': { artifact: { selectedCards: ['character', 'setting'] } }
  });
  const artifact = await stage.run({ request, dependencies: {} });
  const validation = await stage.validate(artifact, {});
  assertEqual(validation.ok, true, `${stage.id} validates its generated card`);
}

assertDeepEqual(requests, ['character', 'setting'], 'Segmented builds each narrow card request independently');
assertDeepEqual(generated, ['character', 'setting'], 'Segmented runs one provider action per card');

console.log('segmented pipeline tests passed');
