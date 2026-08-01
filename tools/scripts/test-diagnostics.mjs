import {
  buildDiagnosticsPayload,
  summarizeExecutionForDiagnostics
} from '../../src/runtime/diagnostics.mjs';
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
    queuedReprocess: {
      schema: 'recursion.queuedReprocess.v2',
      chatKey: 'chat-safe',
      phase: 'preprocess',
      turnKeyHash: 'turn-safe-hash',
      queuedAt: '2026-08-01T12:00:00.000Z',
      mode: 'stage',
      stageIds: ['preprocess.arbiter'],
      artifactBody: 'CANARY_QUEUED_ARTIFACT_BODY'
    },
    turnScope: {
      turnKeyHash: 'turn-safe-hash',
      sourceBandHash: 'band-safe-hash',
      sourceBandLimit: 12,
      sourceBandMessageCount: 9,
      sourceWindowFirstMesId: '14',
      sourceWindowLastMesId: '22',
      generationClassification: 'same-turn-swipe',
      operationId: 'operation-safe-id',
      reuseCount: 1,
      invalidationCount: 0,
      diagnosticCodes: ['queued-reprocess-canceled-edited-band'],
      sourceBand: [{ textHash: 'CANARY_SOURCE_TEXT_HASH', text: 'CANARY_SOURCE_TEXT' }]
    },
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
      schema: 'recursion.preparedGeneration.v2',
      version: 2,
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
        turnKeyHash: 'turn-safe-hash',
        sourceBandHash: 'band-safe-hash',
        originatingUserMessageId: '22',
        packetId: 'packet-safe-id',
        handId: 'hand-safe-id',
        contractHash: 'contract-safe-hash',
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
assertEqual(payload.runtime.turnScope.turnKeyHash, 'turn-safe-hash', 'turn diagnostics keep the bounded turn key');
assertEqual(payload.runtime.turnScope.sourceBandMessageCount, 9, 'turn diagnostics keep the bounded source count');
assertEqual(payload.runtime.turnScope.generationClassification, 'same-turn-swipe', 'turn diagnostics keep the generation classification');
assert(payload.runtime.turnScope.diagnosticCodes.includes('same-turn-swipe'), 'turn diagnostics emit the stable swipe classification code');
assert(payload.runtime.turnScope.diagnosticCodes.includes('queued-reprocess-canceled-edited-band'), 'turn diagnostics keep the bounded queue-cancel reason');
assertEqual(payload.runtime.queuedReprocess.turnKeyHash, 'turn-safe-hash', 'queued diagnostics keep the bound turn hash');
assertEqual(payload.runtime.queuedReprocess.stageIds[0], 'preprocess.arbiter', 'queued diagnostics keep bounded stage ids');
assert(payload.runtime.queuedReprocess.diagnosticCodes.includes('stage-reprocess-queued'), 'queued diagnostics emit a stable queue code');
assert(!serialized.includes('CANARY_SOURCE_TEXT'), 'turn diagnostics never export the source-band array or text hashes');
assert(!serialized.includes('CANARY_QUEUED_ARTIFACT_BODY'), 'queued diagnostics omit artifact bodies');

const executionSummary = summarizeExecutionForDiagnostics({
  operationId: 'operation-safe-id',
  phase: 'postprocess',
  state: 'paused',
  pauseReason: 'user-stop',
  staleChangedFields: ['sourceRevisionHash'],
  stageRecords: {
    'postprocess.unified.rewrite': {
      stageId: 'postprocess.unified.rewrite',
      state: 'failed',
      startedAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:12.000Z',
      attempts: { total: 2 },
      failure: {
        failureClass: 'provider',
        message: 'CANARY_DRAFT_BODY'
      },
      summary: {
        guidance: 'CANARY_GUIDANCE_BODY'
      },
      checkpoint: {
        outputHash: 'artifact-safe-hash',
        artifactRef: {
          artifactBytes: 321,
          body: 'CANARY_PACKET_BODY'
        }
      }
    }
  }
});
const serializedExecution = JSON.stringify(executionSummary);
assertEqual(executionSummary.operationId, 'operation-safe-id', 'execution diagnostics keep operation id');
assertEqual(executionSummary.operationPhase, 'postprocess', 'execution diagnostics keep operation phase');
assertEqual(executionSummary.operationState, 'paused', 'execution diagnostics keep operation state');
assertEqual(executionSummary.stages[0].attemptCount, 2, 'execution diagnostics keep attempt count');
assertEqual(executionSummary.stages[0].elapsedMs, 12000, 'execution diagnostics derive bounded elapsed time');
assertEqual(executionSummary.stages[0].artifactBytes, 321, 'execution diagnostics keep artifact byte count');
assert(serializedExecution.includes('operation-paused:user-stop'), 'execution diagnostics emit stable pause code');
assert(!serializedExecution.includes('CANARY_'), 'execution diagnostics omit all artifact bodies');

const excerptPayload = buildDiagnosticsPayload({
  view: { lastPacket: { promptText: 'visible excerpt' } },
  includeExcerpts: true,
  createdAt: '2026-07-04T00:00:00.000Z'
});
assert(JSON.stringify(excerptPayload).includes('visible excerpt'), 'explicit excerpts include last packet data');

console.log('[pass] diagnostics');
