function abortError(reason = 'Provider request was aborted before it started.') {
  const error = new Error(reason);
  error.name = 'AbortError';
  error.code = 'RECURSION_PROVIDER_ABORTED';
  error.retryable = false;
  return error;
}

export function createProfileRequestQueue({ concurrency = 1, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const normalizeLimit = (value) => Math.min(3, Math.max(1, Math.trunc(Number(value) || 1)));
  const defaultLimit = normalizeLimit(concurrency);
  const limits = new Map();
  const states = new Map();

  function stateFor(profileId) {
    const key = String(profileId || '').trim();
    if (!key) throw new TypeError('Profile queue requires profileId.');
    if (!states.has(key)) states.set(key, { active: 0, peak: 0, pending: [], cooldownUntil: 0, timer: null });
    return [key, states.get(key)];
  }

  function cleanup(key, state) {
    if (state.active === 0 && state.pending.length === 0 && state.cooldownUntil <= now()) {
      if (state.timer !== null) clearTimer(state.timer);
      states.delete(key);
    }
  }

  function drain(key) {
    const state = states.get(key);
    if (!state) return;
    const waitMs = state.cooldownUntil - now();
    if (waitMs > 0) {
      if (state.timer === null) state.timer = setTimer(() => {
        state.timer = null;
        drain(key);
        cleanup(key, state);
      }, waitMs);
      return;
    }
    while (state.active < (limits.get(key) || defaultLimit) && state.pending.length > 0) {
      const first = state.pending[0];
      const requestLimit = typeof first.concurrencyLimit === 'function'
        ? normalizeLimit(first.concurrencyLimit()) : (limits.get(key) || defaultLimit);
      if (state.active >= requestLimit && !first.signal?.aborted) break;
      const entry = state.pending.shift();
      if (entry.signal?.aborted) {
        entry.detachAbort?.();
        entry.reject(abortError());
        cleanup(key, state);
        continue;
      }
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      entry.started = true;
      entry.detachAbort?.();
      Promise.resolve()
        .then(() => {
          if (entry.signal?.aborted) throw abortError();
          const dispatchedAt = now();
          try {
            entry.onDispatch?.({
              queuedAt: entry.queuedAt,
              dispatchedAt,
              queueWaitMs: Math.max(0, dispatchedAt - entry.queuedAt),
              active: state.active,
              concurrency: Math.min(requestLimit, limits.get(key) || defaultLimit)
            });
          } catch { /* Diagnostic observers cannot prevent dispatch. */ }
          return entry.task();
        })
        .then(entry.resolve, entry.reject)
        .finally(() => {
          state.active -= 1;
          cleanup(key, state);
          if (states.has(key)) drain(key);
        });
    }
  }

  function run(profileId, task, { signal = null, onDispatch = null, concurrencyLimit = null } = {}) {
    if (typeof task !== 'function') throw new TypeError('Profile queue requires task.');
    const [key, state] = stateFor(profileId);
    if (signal?.aborted) {
      cleanup(key, state);
      return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
      const entry = { task, signal, onDispatch, concurrencyLimit, queuedAt: now(), resolve, reject, detachAbort: null, started: false };
      if (signal) {
        const onAbort = () => {
          if (entry.started) return;
          const index = state.pending.indexOf(entry);
          if (index < 0) return;
          state.pending.splice(index, 1);
          entry.detachAbort?.();
          reject(abortError());
          cleanup(key, state);
          if (states.has(key)) drain(key);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }
      state.pending.push(entry);
      drain(key);
    });
  }

  function stats(profileId) {
    const key = String(profileId || '').trim();
    const state = states.get(key);
    return Object.freeze({
      active: state?.active || 0,
      pending: state?.pending.length || 0,
      concurrency: limits.get(key) || defaultLimit,
      peakConcurrency: state?.peak || 0,
      cooldownRemainingMs: Math.max(0, (state?.cooldownUntil || 0) - now())
    });
  }

  function setConcurrency(profileId, concurrency) {
    const key = String(profileId || '').trim();
    if (!key) throw new TypeError('Profile queue requires profileId.');
    const limit = normalizeLimit(concurrency);
    limits.set(key, limit);
    drain(key);
    return limit;
  }

  function cooldown(profileId, milliseconds) {
    const [key, state] = stateFor(profileId);
    const duration = Math.min(60000, Math.max(0, Number(milliseconds) || 0));
    state.cooldownUntil = Math.max(state.cooldownUntil, now() + duration);
    if (state.timer !== null) clearTimer(state.timer);
    state.timer = null;
    drain(key);
    cleanup(key, state);
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

  return Object.freeze({ run, stats, clear, setConcurrency, cooldown });
}
