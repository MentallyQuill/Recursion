import { readFileSync } from 'node:fs';
import { assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

const module = await import('./prove-live-pipelines.mjs');
const scriptText = readFileSync(new URL('./prove-live-pipelines.mjs', import.meta.url), 'utf8');

assertEqual(typeof module.selectPipeline, 'function', 'selectPipeline is exported for focused harness tests');
assertEqual(typeof module.selectInjectionSettings, 'function', 'selectInjectionSettings is exported for focused harness tests');
assertDeepEqual(
  module.inspectPacketInjectionMetadata({
    injectedBlocks: [
      { promptKey: 'recursion.guidance', placement: 'in_chat', depth: 4, role: 'system' },
      { promptKey: 'recursion.cardEvidence', placement: 'in_chat', depth: 4, role: 'system' },
      { promptKey: 'recursion.guardrails', placement: 'in_chat', depth: 4, role: 'system' }
    ]
  }, { placement: 'in_chat', depth: 4, role: 'system' }),
  {
    source: 'validated-packet',
    placement: 'in_chat',
    expectedPosition: 1,
    expectedDepth: 4,
    expectedRole: 0,
    blocks: [
      { key: 'recursion.guidance', present: true, placement: 'in_chat', position: 1, depth: 4, role: 0, valid: true },
      { key: 'recursion.cardEvidence', present: true, placement: 'in_chat', position: 1, depth: 4, role: 0, valid: true },
      { key: 'recursion.guardrails', present: true, placement: 'in_chat', position: 1, depth: 4, role: 0, valid: true }
    ],
    complete: true
  },
  'packet injection evidence preserves selected placement, numeric position, depth, and System role'
);
assertDeepEqual(
  module.parseArgs([
    '--live',
    '--pipelines', 'standard,rapid,fused',
    '--placements', 'in_prompt,in_chat',
    '--depth', '4'
  ]),
  {
    live: true,
    pipelines: ['standard', 'rapid', 'fused'],
    placements: ['in_prompt', 'in_chat'],
    depth: 4,
    role: 'system'
  },
  'live pipeline proof parses the complete placement matrix and configured depth'
);
await assertRejects(
  async () => module.parseArgs(['--placement', 'somewhere_else']),
  /Unknown placement/,
  'live pipeline proof rejects unsupported injection placements'
);
assertDeepEqual(
  module.inspectStoredRecursionPrompts({
    'recursion.guidance': { value: 'Guidance:\nUse evidence.', position: 0, depth: 4, role: 0 },
    'recursion.cardEvidence': { value: 'Card evidence:\n- Keep facts.', position: 0, depth: 4, role: 0 },
    'recursion.guardrails': { value: 'Guardrails:\n- Honor facts.', position: 0, depth: 4, role: 0 }
  }, { placement: 'in_prompt', depth: 4, role: 'system' }),
  {
    placement: 'in_prompt',
    expectedPosition: 0,
    expectedDepth: 4,
    expectedRole: 0,
    blocks: [
      { key: 'recursion.guidance', present: true, position: 0, depth: 4, role: 0, valid: true },
      { key: 'recursion.cardEvidence', present: true, position: 0, depth: 4, role: 0, valid: true },
      { key: 'recursion.guardrails', present: true, position: 0, depth: 4, role: 0, valid: true }
    ],
    complete: true
  },
  'In Prompt evidence requires all Recursion blocks at position zero with configured System role and depth'
);
assertEqual(
  module.inspectStoredRecursionPrompts({
    'recursion.guidance': { value: 'Guidance.', position: 0, depth: 1, role: 0 }
  }, { placement: 'in_chat', depth: 4, role: 'system' }).complete,
  false,
  'In Chat evidence rejects In Prompt position and incorrect depth'
);
assertEqual(
  scriptText.includes("proofMessageFor('rapid warm primer'"),
  false,
  'Rapid proof must not send a Rapid foreground turn before the warm deck exists'
);

{
  const calls = [];
  const pipelineButton = {
    async click() {
      calls.push('pipeline-click');
    }
  };
  const rapidChoice = {
    async click() {
      calls.push('rapid-choice-click');
    }
  };
  const page = {
    async evaluate(fn) {
      calls.push('evaluate-close-viewer');
      const fakeDocument = {
        querySelector(selector) {
          if (selector === '[data-recursion-viewer]') {
            return {
              open: true,
              hidden: false,
              close() {
                calls.push('viewer-close');
              }
            };
          }
          return null;
        }
      };
      const originalDocument = globalThis.document;
      globalThis.document = fakeDocument;
      try {
        return fn();
      } finally {
        if (originalDocument === undefined) {
          delete globalThis.document;
        } else {
          globalThis.document = originalDocument;
        }
      }
    },
    locator(selector) {
      if (selector === '[data-recursion-pipeline-button]') return { first: () => pipelineButton };
      if (selector.includes('data-recursion-pipeline-choice="rapid"')) return { first: () => rapidChoice };
      throw new Error(`Unexpected locator: ${selector}`);
    },
    async waitForFunction() {
      calls.push('wait-for-function');
    }
  };

  await module.selectPipeline(page, 'rapid', 1000);

  assertEqual(calls[0], 'evaluate-close-viewer', 'selectPipeline closes an open viewer before clicking Pipeline');
  assertEqual(calls[1], 'viewer-close', 'open viewer close method is invoked before Pipeline click');
  assertEqual(calls[2], 'pipeline-click', 'Pipeline click happens after viewer cleanup');
}

console.log('[pass] live pipeline proof');
