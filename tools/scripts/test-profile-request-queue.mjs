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

// The queue owns real transports even when a caller has already aborted.
const bounded = createProfileRequestQueue();
assertEqual(typeof bounded.setConcurrency, 'function', 'profile limits can be configured');
bounded.setConcurrency('shared', 2);
const heldOne = deferred();
const heldTwo = deferred();
const activeController = new AbortController();
const dispatched = [];
const one = bounded.run('shared', () => heldOne.promise, {
  signal: activeController.signal,
  onDispatch: (timing) => dispatched.push(timing)
});
const two = bounded.run('shared', () => heldTwo.promise);
let thirdStarted = false;
const three = bounded.run('shared', async () => { thirdStarted = true; });
await tick();
assertEqual(bounded.stats('shared').active, 2, 'two transports overlap');
assertEqual(thirdStarted, false, 'third transport waits');
activeController.abort();
bounded.setConcurrency('shared', 1);
await tick();
assertEqual(bounded.stats('shared').active, 2, 'abort does not free an unsettled transport');
heldOne.resolve();
await one;
await tick();
assertEqual(thirdStarted, false, 'lower limit waits for remaining transport');
heldTwo.resolve();
await Promise.all([two, three]);
assertEqual(thirdStarted, true, 'pending transport starts after ownership releases');
assertEqual(dispatched.length, 1, 'one dispatch timing per request');
assertEqual(dispatched[0].concurrency, 2, 'timing records effective dispatch concurrency');
assertEqual(Number.isFinite(dispatched[0].queueWaitMs), true, 'queue time is measured');

let clock = 100;
let nextTimer = 0;
const timers = new Map();
const cooling = createProfileRequestQueue({
  now: () => clock,
  setTimer: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
  clearTimer: (id) => timers.delete(id)
});
assertEqual(typeof cooling.cooldown, 'function', 'rate limits can cool a profile');
cooling.cooldown('limited', 500);
let cooledCallStarted = false;
const cooledCall = cooling.run('limited', async () => { cooledCallStarted = true; });
await tick();
assertEqual(cooledCallStarted, false, 'cooldown survives an initially empty queue');
assertEqual(cooling.stats('limited').cooldownRemainingMs, 500, 'remaining cooldown is visible');
clock = 600;
for (const callback of [...timers.values()]) callback();
await cooledCall;
assertEqual(cooledCallStarted, true, 'cooldown expiry releases the pending call');

const probeShared = createProfileRequestQueue({concurrency: 3});
const probeRelease = deferred();
const probeWork = [
  probeShared.run('profile', () => probeRelease.promise, {concurrencyLimit: () => 2}),
  probeShared.run('profile', () => probeRelease.promise, {concurrencyLimit: () => 2})
];
let ordinaryStarted = false;
const ordinary = probeShared.run('profile', async () => { ordinaryStarted = true; }, {concurrencyLimit: () => 1});
await tick();
assertEqual(ordinaryStarted, false, 'probe override cannot raise ordinary request concurrency');
probeRelease.resolve();
await Promise.all([...probeWork, ordinary]);

{
  let time = 0;
  const pendingTimers = new Map();
  let timerId = 0;
  const limited = createProfileRequestQueue({
    now: () => time,
    setTimer: (callback) => { pendingTimers.set(++timerId, callback); return timerId; },
    clearTimer: (id) => pendingTimers.delete(id)
  });
  assertEqual(typeof limited.rateLimited, 'function', 'profile queue coordinates rate-limit backoff');
  assertEqual(limited.rateLimited('shared', 1000), 2000, 'first capacity failure uses a two-second floor');
  time = 2000;
  for (const [id, callback] of [...pendingTimers]) { pendingTimers.delete(id); callback(); }
  assertEqual(limited.rateLimited('shared', 1000), 4000, 'failure history survives empty-queue cleanup');
  const order = [];
  const one = limited.run('shared', async () => { order.push('one'); });
  const stop = new AbortController();
  const two = limited.run('shared', async () => { order.push('two'); }, { signal: stop.signal }).catch(e => e);
  await limited.run('other', async () => { order.push('other'); });
  stop.abort();
  assertEqual((await two).code, 'RECURSION_PROVIDER_ABORTED', 'Stop removes queued work during cooldown');
  assertDeepEqual(order, ['other'], 'shared requests wait without blocking other profiles');
  time = 6000;
  for (const [id, callback] of [...pendingTimers]) { pendingTimers.delete(id); callback(); }
  await one;
  assertDeepEqual(order, ['other', 'one'], 'only uncancelled work resumes after cooldown');
  assertEqual(limited.rateLimited('shared', 120000), 120000, 'provider cooldown longer than a minute is honored');
  time += 120000;
  for (const [id, callback] of [...pendingTimers]) { pendingTimers.delete(id); callback(); }
  await limited.run('shared', async () => 'recovered');
  assertEqual(limited.rateLimited('shared', 0), 2000, 'successful transport resets backoff');
}

console.log('[pass] profile request queue');
