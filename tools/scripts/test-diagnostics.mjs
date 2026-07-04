import { buildDiagnosticsPayload } from '../../src/runtime/diagnostics.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const payload = buildDiagnosticsPayload({
  createdAt: '2026-07-04T00:00:00.000Z',
  settings: { provider: { utility: { openAICompatible: { apiKey: 'sk-live-secret' } } } },
  view: {
    activeRunId: 'run-1',
    hostGenerationActive: true,
    activity: { label: 'Working' },
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
assert(!serialized.includes('Bearer private-token'), 'journal secrets are redacted');
assert(!serialized.includes('should not be copied'), 'raw prompt fields are not copied by default');
assert(serialized.includes('visible'), 'safe diagnostic details are preserved');

const excerptPayload = buildDiagnosticsPayload({
  view: { lastPacket: { promptText: 'visible excerpt' } },
  includeExcerpts: true,
  createdAt: '2026-07-04T00:00:00.000Z'
});
assert(JSON.stringify(excerptPayload).includes('visible excerpt'), 'explicit excerpts include last packet data');

console.log('[pass] diagnostics');
