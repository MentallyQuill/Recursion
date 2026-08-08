import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const browserDependentTests = new Set([
  'test-live-harness.mjs',
  'test-live-pipeline-proof.mjs'
]);
const discovered = readdirSync(here)
  .filter((name) => /^test-.*\.mjs$/.test(name) && name !== 'test-harness.mjs')
  .sort();
const scripts = discovered.filter((name) => !browserDependentTests.has(name));
const skipped = discovered.filter((name) => browserDependentTests.has(name));

if (scripts.length === 0) {
  throw new Error('No offline test scripts discovered.');
}

for (const script of skipped) {
  console.log(`[skip] ${script} requires Playwright; run npm run test:browser`);
}

for (const script of scripts) {
  const started = Date.now();
  await import(pathToFileURL(join(here, script)).href);
  console.log(`[pass] ${script} ${Date.now() - started}ms`);
}
console.log(`[pass] ${scripts.length} offline test scripts`);
