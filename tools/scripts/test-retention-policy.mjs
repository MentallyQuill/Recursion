import {
  DEFAULT_RETENTION_SETTINGS,
  normalizeRetentionSettings,
  selectBoundedSourceWindow
} from '../../src/retention-policy.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const defaults = normalizeRetentionSettings({});
assertDeepEqual(defaults, DEFAULT_RETENTION_SETTINGS, 'blank retention uses defaults');

const clamped = normalizeRetentionSettings({
  sourceWindowMessages: 9999,
  sourceWindowCharacters: -5,
  providerVisibleMessages: 1,
  sceneCachesPerChat: 9,
  sceneCachesTotal: 4,
  sourceVariantsPerScene: 99,
  runJournalEntries: 9999
});

assertEqual(clamped.sourceWindowMessages, 200, 'sourceWindowMessages clamps high');
assertEqual(clamped.sourceWindowCharacters, 24000, 'invalid sourceWindowCharacters falls back');
assertEqual(clamped.providerVisibleMessages, 4, 'providerVisibleMessages clamps low');
assertEqual(clamped.sceneCachesPerChat, 9, 'sceneCachesPerChat keeps valid value');
assertEqual(clamped.sceneCachesTotal, 9, 'sceneCachesTotal rises to per-chat cap');
assertEqual(clamped.sourceVariantsPerScene, 8, 'sourceVariantsPerScene clamps high');
assertEqual(clamped.runJournalEntries, 500, 'runJournalEntries clamps high');

const rawMessages = Array.from({ length: 16 }, (_, index) => ({
  mesid: index,
  is_user: index % 2 === 1,
  mes: `message-${index}`
}));
rawMessages[2].is_system = true;
rawMessages[6].hidden = true;

const bounded = selectBoundedSourceWindow(rawMessages, {
  sourceWindowMessages: 12,
  sourceWindowCharacters: 1000
});

assertDeepEqual(
  bounded.messages.map((message) => message.mesid),
  [3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  'bounded window keeps newest visible non-system messages in chronological order'
);
assertEqual(bounded.metadata.sourceWindowMessageCount, 12, 'metadata records retained message count');
assertEqual(bounded.metadata.sourceWindowTruncated, true, 'metadata marks truncated older messages');
assertEqual(bounded.metadata.sourceWindowLimitReason, 'message-cap', 'metadata records message cap reason');

const charBounded = selectBoundedSourceWindow([
  { mesid: 1, mes: 'old text block'.repeat(400) },
  { mesid: 2, mes: 'middle text block'.repeat(400) },
  { mesid: 3, mes: 'latest text block'.repeat(400) }
], {
  sourceWindowMessages: 10,
  sourceWindowCharacters: 6000
});

assertDeepEqual(
  charBounded.messages.map((message) => message.mesid),
  [3],
  'character budget keeps latest message when older message would exceed budget'
);
assertEqual(charBounded.metadata.sourceWindowLimitReason, 'character-budget', 'character cap reason recorded');
assert(charBounded.metadata.sourceWindowCharacterCount > 0, 'metadata records retained characters');

console.log('[pass] retention-policy');
