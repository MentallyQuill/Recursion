import { readFileSync } from 'node:fs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

const module = await import('./prove-live-pipelines.mjs');
const scriptText = readFileSync(new URL('./prove-live-pipelines.mjs', import.meta.url), 'utf8');

assertEqual(typeof module.selectPipeline, 'function', 'selectPipeline is exported for focused harness tests');
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
