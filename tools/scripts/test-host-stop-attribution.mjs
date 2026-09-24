import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

const repository = createStorageRepository({ storage: createMemoryStorageAdapter() });
await repository.appendJournal('Stops', {
  event: 'host.generation_stopped', severity: 'warn', summary: 'Host generation stopped.',
  details: { recursionRequested: false, source: 'host-event', reason: '', payloadKeys: [] }
});
const journal = await repository.loadRunJournal('Stops');
const stop = journal.entries[0];
assertEqual(stop.details.failure, undefined, 'a host stop with no cause is not an invented internal failure');
assertEqual(stop.details.reason, 'host-stop-cause-unavailable', 'unknown host stop cause is explicit');
for (const details of [
  { recursionRequested: true },
  { recursionRequested: false, reason: 'user-stopped' },
  { error: { code: 'RECURSION_PROVIDER_AUTH_FAILED', message: 'Authentication failed.' } }
]) {
  const entry = await repository.appendJournal('Stops', {
    event: 'host.generation_stopped', severity: 'warn', summary: 'Stopped.', details
  });
  if (details.error) assertEqual(entry.details.failure.code, details.error.code, 'actual failure survives host stop');
  else {
    assertEqual(entry.details.failure, undefined, 'known cancellation does not invent an internal failure');
    assertEqual(entry.details.reason, details.reason || 'recursion-requested-stop', 'observed stop reason survives');
  }
}
console.log('[pass] host stop attribution');
