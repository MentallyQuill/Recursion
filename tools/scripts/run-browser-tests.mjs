import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = [
  'test-ui-post-process-review-browser.mjs',
  'test-live-harness.mjs',
  'test-live-pipeline-proof.mjs',
  'test-live-resilience-matrix.mjs'
];

for (const script of scripts) {
  const started = Date.now();
  await import(pathToFileURL(join(here, script)).href);
  console.log(`[pass] ${script} ${Date.now() - started}ms`);
}
console.log(`[pass] ${scripts.length} Playwright-dependent test scripts`);
