import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(here)
  .filter((name) => /^test-.*\.mjs$/.test(name) && name !== 'test-harness.mjs')
  .sort();

if (scripts.length === 0) {
  throw new Error('No test scripts discovered.');
}

for (const script of scripts) {
  const started = Date.now();
  await import(pathToFileURL(join(here, script)).href);
  console.log(`[pass] ${script} ${Date.now() - started}ms`);
}
console.log(`[pass] ${scripts.length} test scripts`);
