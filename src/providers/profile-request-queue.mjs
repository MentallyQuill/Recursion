function abortError(reason = 'Provider request was aborted before it started.') {
  const error = new Error(reason);
  error.name = 'AbortError';
  error.code = 'RECURSION_PROVIDER_ABORTED';
  error.retryable = false;
  return error;
}

export function createProfileRequestQueue({ concurrency = 1 } = {}) {
  const limit = Math.max(1, Math.trunc(Number(concurrency) || 1));
  const states = new Map();

  function stateFor(profileId) {
    const key = String(profileId || '').trim();
    if (!key) throw new TypeError('Profile queue requires profileId.');
    if (!states.has(key)) states.set(key, { active: 0, pending: [] });
    return [key, states.get(key)];
  }

  function cleanup(key, state) {
    if (state.active === 0 && state.pending.length === 0) states.delete(key);
  }

  function drain(key) {
    const state = states.get(key);
    if (!state) return;
    while (state.active < limit && state.pending.length > 0) {
      const entry = state.pending.shift();
      if (entry.signal?.aborted) {
        entry.detachAbort?.();
        entry.reject(abortError());
        cleanup(key, state);
        continue;
      }
      state.active += 1;
      entry.started = true;
      entry.detachAbort?.();
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          state.active -= 1;
          cleanup(key, state);
          if (states.has(key)) drain(key);
        });
    }
  }

  function run(profileId, task, { signal = null } = {}) {
    if (typeof task !== 'function') throw new TypeError('Profile queue requires task.');
    const [key, state] = stateFor(profileId);
    if (signal?.aborted) {
      cleanup(key, state);
      return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
      const entry = { task, signal, resolve, reject, detachAbort: null, started: false };
      if (signal) {
        const onAbort = () => {
          if (entry.started) return;
          const index = state.pending.indexOf(entry);
          if (index < 0) return;
          state.pending.splice(index, 1);
          entry.detachAbort?.();
          reject(abortError());
          cleanup(key, state);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }
      state.pending.push(entry);
      drain(key);
    });
  }

  function stats(profileId) {
    const state = states.get(String(profileId || '').trim());
    return Object.freeze({
      active: state?.active || 0,
      pending: state?.pending.length || 0,
      concurrency: limit
    });
  }

  function clear(profileId, reason = 'Provider queue was cleared.') {
    const key = String(profileId || '').trim();
    const state = states.get(key);
    if (!state) return 0;
    const entries = state.pending.splice(0);
    for (const entry of entries) {
      entry.detachAbort?.();
      entry.reject(abortError(reason));
    }
    cleanup(key, state);
    return entries.length;
  }

  return Object.freeze({ run, stats, clear });
}
