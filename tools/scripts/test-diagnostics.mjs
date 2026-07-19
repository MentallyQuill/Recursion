import { buildDiagnosticsPayload } from '../../src/runtime/diagnostics.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const payload = buildDiagnosticsPayload({
  createdAt: '2026-07-04T00:00:00.000Z',
  settings: {
    provider: { utility: { openAICompatible: { apiKey: 'sk-live-secret' } } },
    preProcessDecks: {
      version: 1,
      activeDeckId: 'custom',
      customDecks: {
        custom: {
          id: 'custom',
          name: 'Custom Deck',
          categories: {
            cat: { id: 'cat', name: 'Secrets', description: 'category description leak' }
          },
          categoryOrder: ['cat'],
          cardOrderByCategory: { cat: ['card'] },
          cards: {
            card: {
              id: 'card',
              categoryId: 'cat',
              name: 'Secret Card',
              description: 'card description leak',
              promptText: 'card prompt leak',
              enabled: true
            }
          }
        }
      }
    }
  },
  view: {
    activeRunId: 'run-1',
    hostGenerationActive: true,
    activity: { label: 'Working' },
    lastCacheDecision: {
      sequence: 7,
      decision: 'hit',
      kind: 'prepared-generation',
      reason: 'prepared-generation-exact-match',
      artifactHash: 'artifact-safe-hash',
      packetId: 'packet-safe-id',
      handId: 'hand-safe-id',
      providerCallsSkipped: ['utilityArbiter', 'standardCardCalls']
    },
    lastPreparedGeneration: {
      schema: 'recursion.preparedGeneration.v1',
      version: 1,
      artifactHash: 'artifact-safe-hash',
      preparedAt: '2026-07-04T00:00:00.000Z',
      packet: {
        packetVersion: 4,
        promptText: 'prepared packet transcript leak'
      },
      hand: {
        cards: [{ id: 'card-safe-id', promptText: 'prepared card prompt leak' }],
        omitted: []
      },
      basis: {
        sourceRevisionHash: 'source-safe-hash',
        sourceWindowContractHash: 'window-safe-hash',
        sourceWindowMessageHashes: ['message-safe-hash'],
        transcriptText: 'prepared basis transcript leak'
      },
      contract: {
        packetInputHash: 'input-safe-hash'
      }
    },
    lastPacket: {
      promptText: 'visible excerpt',
      diagnostics: { pipelineMode: 'fused', promptText: 'diagnostic excerpt leak' }
    }
  },
  cacheContracts: { settings: 'abc' },
  journal: {
    entries: [
      {
        id: 'entry-1',
        runId: 'run-1',
        event: 'provider',
        phase: 'done',
        severity: 'info',
        label: 'Provider done',
        details: { authorization: 'Bearer private-token', safe: 'visible' },
        rawPrompt: 'should not be copied by default mapping'
      }
    ]
  },
  includeExcerpts: false
});

const serialized = JSON.stringify(payload);
assertEqual(payload.schema, 'recursion.diagnostics.v1', 'diagnostics schema is versioned');
assertEqual(payload.excerpts, null, 'excerpts are omitted by default');
assert(!serialized.includes('visible excerpt'), 'default diagnostics omit raw excerpt text');
assert(!serialized.includes('diagnostic excerpt leak'), 'default diagnostics allowlist packet diagnostic fields');
assert(serialized.includes('fused'), 'default diagnostics keep safe packet pipeline diagnostics');
assert(!serialized.includes('sk-live-secret'), 'settings secrets are redacted');
assert(serialized.includes('Custom Deck'), 'card deck diagnostics keep safe deck name');
assert(serialized.includes('runnableCardCount'), 'card deck diagnostics include structural runnable count');
assert(!serialized.includes('category description leak'), 'card deck diagnostics omit category descriptions');
assert(!serialized.includes('card description leak'), 'card deck diagnostics omit card descriptions');
assert(!serialized.includes('card prompt leak'), 'card deck diagnostics omit card prompt text');
assert(!serialized.includes('Bearer private-token'), 'journal secrets are redacted');
assert(!serialized.includes('should not be copied'), 'raw prompt fields are not copied by default');
assert(serialized.includes('visible'), 'safe diagnostic details are preserved');
assertEqual(payload.runtime.cacheDecision.kind, 'prepared-generation', 'cache decision exports the prepared-generation kind');
assertEqual(payload.runtime.preparedGeneration.artifactHash, 'artifact-safe-hash', 'prepared generation exports its safe hash');
assertEqual(payload.runtime.preparedGeneration.hand.cardCount, 1, 'prepared generation exports structural hand counts');
assert(!serialized.includes('prepared packet transcript leak'), 'prepared generation diagnostics omit packet text');
assert(!serialized.includes('prepared card prompt leak'), 'prepared generation diagnostics omit card prompts');
assert(!serialized.includes('prepared basis transcript leak'), 'prepared generation diagnostics omit source text');

const excerptPayload = buildDiagnosticsPayload({
  view: { lastPacket: { promptText: 'visible excerpt' } },
  includeExcerpts: true,
  createdAt: '2026-07-04T00:00:00.000Z'
});
assert(JSON.stringify(excerptPayload).includes('visible excerpt'), 'explicit excerpts include last packet data');

console.log('[pass] diagnostics');
