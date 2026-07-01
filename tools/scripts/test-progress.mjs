import { createHeroPixelBlocks, createProgressRunModel } from '../../src/progress.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const unsafeProgress = createProgressRunModel({
  progressRun: {
    runId: 'progress-secret-run',
    title: 'Generating',
    subtitle: 'authorization: raw-progress-auth-token',
    steps: [
      {
        id: 'unsafe-explicit-step',
        label: 'headers.authorization=raw-progress-header-token',
        state: 'running',
        children: [
          {
            id: 'unsafe-child',
            label: 'cookie=raw-progress-cookie; sessionId=raw-progress-session; credentials=raw-progress-creds',
            state: 'running'
          }
        ]
      }
    ]
  }
});
const unsafeSerialized = JSON.stringify(unsafeProgress);
for (const value of [
  'raw-progress-auth-token',
  'raw-progress-header-token',
  'raw-progress-cookie',
  'raw-progress-session',
  'raw-progress-creds',
  'authorization',
  'sessionId',
  'credentials'
]) {
  assert(!unsafeSerialized.includes(value), `progress model redacts ${value}`);
}
assertEqual(unsafeProgress.subtitle, '', 'unsafe progress subtitle is omitted');
assertEqual(unsafeProgress.steps[0].label, 'Step 1', 'unsafe progress label falls back');
assertEqual(unsafeProgress.steps[0].children[0].label, 'Item 1', 'unsafe child progress label falls back');

const safeProgress = createProgressRunModel({
  progressRun: {
    runId: 'progress-safe-run',
    title: 'Generating',
    subtitle: '2 model calls running',
    steps: [
      {
        id: 'safe-story-step',
        label: 'Checking token: a brass coin',
        state: 'running',
        providerLane: 'utility'
      }
    ]
  }
});
assertEqual(safeProgress.subtitle, '2 model calls running', 'safe progress subtitle survives');
assertEqual(safeProgress.steps[0].label, 'Checking token: a brass coin', 'safe story token text survives');
const blocks = createHeroPixelBlocks(safeProgress);
assertEqual(blocks[0].label, 'Checking token: a brass coin', 'hero blocks inherit safe labels');

console.log('[pass] progress');
