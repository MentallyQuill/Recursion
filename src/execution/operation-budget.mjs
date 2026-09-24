function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

export function normalizeOperationBudget(value = {}, defaults = {}) {
  const source = value || {};
  return {
    windowId: String(source.windowId || defaults.windowId || 'initial').slice(0, 160),
    recoveryLimit: bounded(source.recoveryLimit ?? defaults.recoveryLimit, 1, 0, 100),
    recoveryUsed: bounded(source.recoveryUsed, 0, 0, 100),
    providerCooldowns: Object.fromEntries(Object.entries(source.providerCooldowns || {})
      .filter(([key, until]) => /^[a-f0-9]{64}$/.test(key) && Number.isFinite(until))
      .slice(0, 40).map(([key, until]) => [key, Math.max(0, until)])),
    reservationIds: [...new Set((Array.isArray(source.reservationIds) ? source.reservationIds : [])
      .filter((id) => typeof id === 'string').map((id) => id.slice(0, 240)))].slice(0, 300),
    elapsedActiveMs: bounded(source.elapsedActiveMs, 0, 0, Number.MAX_SAFE_INTEGER),
    activeSince: Number.isFinite(source.activeSince) ? source.activeSince : null,
    deadlineMs: bounded(source.deadlineMs ?? defaults.deadlineMs, 300000, 60000, 1800000)
  };
}

export function remainingExecutionMs(value, now = Date.now()) {
  const budget = normalizeOperationBudget(value);
  return Math.max(0, budget.deadlineMs - budget.elapsedActiveMs
    - (budget.activeSince === null ? 0 : Math.max(0, now - budget.activeSince)));
}

// Call under the scheduler's durable mutation lock, before dispatching any recovery.
export function reserveRecoveryCall(value, reservationId, { cost = 1, now = Date.now() } = {}) {
  const budget = normalizeOperationBudget(value);
  const id = String(reservationId).slice(0, 240);
  if (budget.reservationIds.includes(id)) return { ok: true, budget };
  if (remainingExecutionMs(budget, now) <= 0) return { ok: false, code: 'RECURSION_OPERATION_DEADLINE', budget };
  const charge = cost === 0 ? 0 : 1;
  if (budget.recoveryUsed + charge > budget.recoveryLimit || budget.reservationIds.length >= 300) {
    return { ok: false, code: 'RECURSION_RECOVERY_BUDGET_EXHAUSTED', budget };
  }
  return { ok: true, budget: { ...budget, recoveryUsed: budget.recoveryUsed + charge,
    reservationIds: [...budget.reservationIds, id] } };
}

export function settleOperationClock(value, running, now = Date.now()) {
  const budget = normalizeOperationBudget(value);
  return { ...budget,
    elapsedActiveMs: budget.elapsedActiveMs + (budget.activeSince === null ? 0 : Math.max(0, now - budget.activeSince)),
    activeSince: running ? now : null };
}
