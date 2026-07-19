import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertVisualBaseline,
  assertVisualBaselineBuffer
} from './lib/visual-regression.mjs';
import { runWithRetainedTrace } from './lib/trace-lifecycle.mjs';

const proofPath = resolve('tools', 'scripts', 'prove-post-process-cards-ui.mjs');
assert.equal(existsSync(proofPath), true, 'Post-process UI proof script exists');

const result = spawnSync(process.execPath, [proofPath, '--dry-run'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: {
    ...process.env,
    SILLYTAVERN_BASE_URL: '',
    RECURSION_SILLYTAVERN_USER: '',
    RECURSION_SILLYTAVERN_PASSWORD: ''
  }
});
assert.equal(result.status, 0, `dry-run exits cleanly: ${result.stderr || result.stdout}`);
const report = JSON.parse(result.stdout);

assert.equal(report.schema, 'recursion.postProcessUiProof.v1', 'dry-run uses the UI proof schema');
assert.equal(report.status, 'dry-run-pass', 'dry-run passes without a live host');
assert.equal(report.generationEnabled, false, 'UI proof is explicitly no-generation');
assert.deepEqual(report.viewports, ['desktop', 'compact'], 'both approved viewports are enumerated');

const states = [
  'starter-off',
  'starter-unified',
  'starter-progressive',
  'custom-deck',
  'card-editor',
  'category-disabled',
  'delete-confirm'
];
const expectedKeys = report.viewports.flatMap((viewport) => states.map((state) => `${viewport}-${state}`));
assert.deepEqual(report.cases.map((entry) => entry.key), expectedKeys, 'all 14 viewport/state cases are enumerated in stable order');
assert(report.cases.every((entry) => entry.interaction === 'planned'
  && entry.accessibility === 'planned'
  && entry.layout === 'planned'), 'dry-run enumerates interaction, accessibility, and layout proof');

assert.deepEqual(report.safetyGates, [
  'dedicated-user',
  'authenticate',
  'installed-copy',
  'served-copy',
  'browser-navigation'
], 'safety gates are declared in required execution order');
assert.deepEqual(report.artifactPolicy, {
  screenshots: true,
  traces: true,
  rawPromptText: false,
  generation: false
}, 'dry-run declares the no-generation binary artifact policy');

const requiredSelectors = [
  'data-recursion-pre-process-cards-button',
  'data-recursion-post-process-cards-button',
  'data-recursion-post-process-panel',
  'data-recursion-post-process-enabled',
  'data-recursion-post-process-deck-select',
  'data-recursion-post-process-deck-duplicate',
  'data-recursion-post-process-deck-new',
  'data-recursion-post-process-deck-edit',
  'data-recursion-post-process-deck-delete',
  'data-recursion-post-process-apply-as-swipe',
  'data-recursion-post-process-apply-replace',
  'data-recursion-post-process-flow-unified',
  'data-recursion-post-process-flow-progressive',
  'data-recursion-post-process-category',
  'data-recursion-post-process-category-toggle',
  'data-recursion-post-process-category-drag-handle',
  'data-recursion-post-process-card',
  'data-recursion-post-process-card-toggle',
  'data-recursion-post-process-card-drag-handle',
  'data-recursion-post-process-card-editor',
  'data-recursion-post-process-card-prompt',
  'data-recursion-post-process-progress'
];
assert.deepEqual(report.requiredSelectors, requiredSelectors, 'stable selector contract is complete');

const source = readFileSync(proofPath, 'utf8');
assert(!source.includes('data-recursion-enhancements-'), 'proof does not retain obsolete Enhancement selectors');
for (const forbidden of ['generateRaw(', 'generateQuietPrompt(', '.generate(', 'sendMessage(']) {
  assert(!source.includes(forbidden), `no-generation UI proof omits ${forbidden}`);
}
assert(source.includes('[data-recursion-visual-volatile]'), 'proof uses the approved volatile visual mask');
assert(source.includes('deviceScaleFactor: 1'), 'proof pins CSS-pixel scale');
assert(source.includes("reducedMotion: 'reduce'"), 'proof contains a reduced-motion accessibility case');
assert(source.includes("page.locator('.recursion-bar')"), 'visual surface includes the fixed Recursion bar rather than relying on its parent box');
assert(source.includes('data-recursion-visual-backing'), 'visual proof installs a stable backing behind the complete Recursion surface');
assert(source.includes('context.addInitScript(installVisualBacking)'), 'stable visual backing is reinstalled on every navigation and reload');
assert(source.includes('root.before(backing)'), 'visual backing shares the Recursion host stacking context');
assert(source.includes("zIndex: '9999'"), 'visual backing remains immediately behind the z-index 10000 Recursion root');
assert(source.includes('previousListScrollTop'), 'layout proof preserves the visual state before checking the final scrollable row');
assert(source.includes('node.scrollTop = scrollTop'), 'layout proof restores the inner list scroll before capture');
assert(source.includes('async function assertSharedPanelGeometry'), 'proof compares Pre-process and Post-process shared panel geometry');
assert(source.includes("measureSharedCardPanel(page, '[data-recursion-cards-panel]')"), 'proof measures the Pre-process shared panel');
assert(source.includes("measureSharedCardPanel(page, '[data-recursion-post-process-panel]')"), 'proof measures the Post-process shared panel');
assert(source.includes("'deckSelector', 'list', 'category', 'categoryHead', 'card', 'cardMain'"), 'proof compares shared deck selector and card-main bounds');
assert(source.includes('Category disclosure inset differs between Pre-process and Post-process.'), 'proof compares shared category disclosure placement');
assert(source.includes('Card eye right margin differs between Pre-process and Post-process.'), 'proof enforces the same right-aligned card eye inset');
assert(source.includes('Read-only Card rows rendered an empty action rail.'), 'proof rejects empty read-only action rails');
assert(source.includes('A shared Card list is not the primary scroll surface.'), 'proof enforces shared list overflow behavior');
assert(source.includes('A shared Card list does not reserve a stable scrollbar gutter.'), 'proof enforces stable shared list scrollbar geometry');
assert(source.includes('Starter Post-process Deck header did not use the shared count-only summary.'), 'proof enforces the shared count-only starter header');
assert(source.includes('read-only structure through disabled authoring controls'), 'proof checks read-only state through disabled authoring controls');
const captureCaseSource = source.match(/async function captureCase[\s\S]*?\n\}/)?.[0] || '';
assert.equal((captureCaseSource.match(/\.screenshot\(/g) || []).length, 1, 'each visual case captures exactly one PNG');
assert(captureCaseSource.includes('writeFileSync(artifactPath, actual)'), 'the exact captured PNG buffer is retained as the artifact');
assert(captureCaseSource.includes('assertVisualBaselineBuffer(actual'), 'the retained PNG buffer is the buffer compared to the baseline');
assert(captureCaseSource.includes('actualSha256'), 'the report records the retained PNG buffer hash');
assert(source.includes('Post-process Cards must be Off before the proof mutates its setting.'), 'proof asserts the default Off state before mutating it');
assert(source.includes('Replace mode did not persist after reload.'), 'proof semantically asserts Replace after reload');
assert(source.includes('Progressive flow did not persist after reload.'), 'proof semantically asserts Progressive after reload');
assert(source.includes('Category order did not persist after reload.'), 'proof asserts the complete persisted category order');
assert(source.includes('Card order did not persist after reload.'), 'proof asserts the complete persisted card order');
assert(source.includes("openPostProcess(page, { keyboardKey: 'Enter' })"), 'interaction matrix opens the panel with Enter');
assert(source.includes("openPostProcess(page, { keyboardKey: 'Space' })"), 'interaction matrix opens the panel with Space');
assert(source.includes('Dragging a category row body reordered the deck.'), 'interaction matrix includes the category-body negative drag');
assert(source.includes('Dragging a card row body reordered the deck.'), 'interaction matrix includes the card-body negative drag');
assert(
  source.includes('await bestEffortDisablePostProcess(page).catch(() => {})'),
  'each viewport disables Post-process through the visible UI on success or failure without masking the primary error'
);

const temporary = mkdtempSync(join(tmpdir(), 'recursion-post-process-visual-'));
try {
  const forcedFailureTrace = join(temporary, 'forced-early-failure-trace.zip');
  const traceEvents = [];
  const tracedContext = {
    tracing: {
      async start() { traceEvents.push('start'); },
      async stop({ path }) {
        traceEvents.push('stop');
        writeFileSync(path, 'retained trace after failure');
      }
    },
    async close() { traceEvents.push('close'); }
  };
  await assert.rejects(
    () => runWithRetainedTrace(tracedContext, forcedFailureTrace, async () => {
      throw new Error('forced early viewport failure');
    }),
    /forced early viewport failure/,
    'forced early viewport failures remain failures'
  );
  assert.equal(existsSync(forcedFailureTrace), true, 'forced early viewport failure retains its trace');
  assert.deepEqual(traceEvents, ['start', 'stop', 'close'], 'trace stop and context close run after early failure');

  const baseline = join(temporary, 'baseline.png');
  const pngA = Buffer.alloc(32);
  pngA.writeUInt32BE(12, 16);
  pngA.writeUInt32BE(8, 20);
  const pngB = Buffer.from(pngA);
  pngB[31] = 1;
  writeFileSync(baseline, pngA);
  const retained = join(temporary, 'retained.png');
  writeFileSync(retained, pngA);
  const comparedBuffer = assertVisualBaselineBuffer(pngA, baseline);
  const retainedHash = createHash('sha256').update(readFileSync(retained)).digest('hex');
  assert.equal(comparedBuffer.actualSha256, retainedHash, 'retained bytes hash equals the compared buffer hash');
  const reportCase = { actualSha256: comparedBuffer.actualSha256 };
  assert.equal(reportCase.actualSha256, retainedHash, 'reported actualSha256 equals the retained bytes hash');
  assert.equal(comparedBuffer.baseline, 'match', 'equal retained and baseline buffers report match');
  assert.throws(
    () => assertVisualBaselineBuffer(pngB, baseline),
    /Visual baseline changed/,
    'a strict retained-buffer mismatch cannot report match'
  );
  const locator = {
    locator() { return this; },
    async screenshot() { return pngB; }
  };
  await assert.rejects(
    () => assertVisualBaseline(locator, baseline),
    /Visual baseline changed/,
    'pixel/hash drift is a hard visual failure'
  );

  const pngWrongSize = Buffer.from(pngA);
  pngWrongSize.writeUInt32BE(13, 16);
  const dimensionLocator = {
    locator() { return this; },
    async screenshot() { return pngWrongSize; }
  };
  await assert.rejects(
    () => assertVisualBaseline(dimensionLocator, baseline),
    /Visual baseline dimensions changed/,
    'dimension drift is a hard visual failure'
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log('[pass] Post-process Playwright dry-run, safety, selector, artifact, and visual contracts');
