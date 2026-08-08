import { createProfileRequestQueue } from '../../src/providers/profile-request-queue.mjs';
import { assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const queue = createProfileRequestQueue();
const releaseFirst = deferred();
let active = 0;
let peak = 0;
const order = [];
const first = queue.run('profile-a', async () => {
  order.push('first-start');
  active += 1;
  peak = Math.max(peak, active);
  await releaseFirst.promise;
  active -= 1;
  order.push('first-end');
  return 'first';
});
const second = queue.run('profile-a', async () => {
  order.push('second-start');
  active += 1;
  peak = Math.max(peak, active);
  active -= 1;
  order.push('second-end');
  return 'second';
});
await tick();
assertEqual(peak, 1, 'same profile never exceeds one active request');
assertEqual(queue.stats('profile-a').pending, 1, 'second request waits in FIFO');
releaseFirst.resolve();
assertDeepEqual(await Promise.all([first, second]), ['first', 'second'], 'FIFO results resolve');
assertDeepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end'], 'FIFO task order is preserved');

const releaseA = deferred();
const releaseB = deferred();
active = 0;
peak = 0;
const differentA = queue.run('profile-a', async () => {
  active += 1;
  peak = Math.max(peak, active);
  await releaseA.promise;
  active -= 1;
});
const differentB = queue.run('profile-b', async () => {
  active += 1;
  peak = Math.max(peak, active);
  await releaseB.promise;
  active -= 1;
});
await tick();
assertEqual(peak, 2, 'different profiles may run independently');
releaseA.resolve();
releaseB.resolve();
await Promise.all([differentA, differentB]);

const releaseBlocking = deferred();
let abortedTaskCalls = 0;
const blocking = queue.run('profile-c', () => releaseBlocking.promise);
const controller = new AbortController();
const aborted = queue.run('profile-c', async () => {
  abortedTaskCalls += 1;
}, { signal: controller.signal }).catch((error) => error);
await tick();
controller.abort();
const abortedError = await aborted;
assertEqual(abortedError.code, 'RECURSION_PROVIDER_ABORTED', 'queued abort has stable code');
assertEqual(abortedTaskCalls, 0, 'aborted queued task never starts');
releaseBlocking.resolve();
await blocking;

const releaseClear = deferred();
const activeClear = queue.run('profile-d', () => releaseClear.promise);
const pendingClear = queue.run('profile-d', async () => 'never').catch((error) => error);
await tick();
assertEqual(queue.clear('profile-d', 'test clear'), 1, 'clear rejects pending entries');
assertEqual((await pendingClear).code, 'RECURSION_PROVIDER_ABORTED', 'cleared entry has abort code');
releaseClear.resolve();
await activeClear;

console.log('[pass] profile request queue');
