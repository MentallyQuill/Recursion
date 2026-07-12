import { cardsFromProviderResult } from '../../cards.mjs';

function progressRetryCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(99, Math.floor(count));
}

function providerCardRetryReason(retryCount, batched = false) {
  const count = progressRetryCount(retryCount);
  if (!count) return '';
  const countText = count === 1 ? 'once' : `${count} times`;
  return batched
    ? `Provider card batch retried ${countText} before this card completed.`
    : `Provider card call retried ${countText} before this card completed.`;
}

function normalizeDiagnostics(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

export async function runStandardCardPipeline({
  plan,
  snapshot,
  settings,
  generationRouter,
  requests = [],
  sourceContext = {},
  stageRuntimeActivity,
  signal,
  isCurrent,
  diagnostics = [],
  runId
} = {}) {
  const baseDiagnostics = normalizeDiagnostics(diagnostics);
  if (!generationRouter) return { cards: [], diagnostics: baseDiagnostics };

  if (!requests.length) {
    if (typeof generationRouter.generatePlanCards === 'function') {
      const result = await generationRouter.generatePlanCards({ plan, snapshot, settings, signal, runId });
      return {
        cards: Array.isArray(result?.cards) ? result.cards : [],
        diagnostics: normalizeDiagnostics([...baseDiagnostics, ...(Array.isArray(result?.diagnostics) ? result.diagnostics : [])])
      };
    }
    return { cards: [], diagnostics: baseDiagnostics };
  }
  if (typeof generationRouter.batch !== 'function' && typeof generationRouter.generate !== 'function') {
    return { cards: [], diagnostics: baseDiagnostics };
  }

  const lanes = new Set(requests.map((request) => request.lane));
  const batchLane = lanes.size === 1 && lanes.has('reasoner') ? 'reasoner' : 'utility';
  stageRuntimeActivity?.({
    runId,
    phase: 'cardBatchRunning',
    label: 'Generating scene cards...',
    cardCounts: { requested: requests.length },
    providerLane: batchLane,
    chips: [
      'Cards',
      String(requests.length),
      ...(lanes.has('utility') && lanes.has('reasoner') ? ['Utility', 'Reasoner'] : [batchLane === 'reasoner' ? 'Reasoner' : 'Utility'])
    ]
  });

  try {
    const signalRequests = signal
      ? requests.map((request) => ({ ...request, signal }))
      : requests;
    const current = typeof isCurrent === 'function' ? isCurrent : () => true;
    const options = { runId, signal, isCurrent: current };
    const usedBatch = typeof generationRouter.batch === 'function';
    const results = usedBatch
      ? await generationRouter.batch(signalRequests, options)
      : [];
    if (!usedBatch) {
      for (const request of signalRequests) {
        if (signal?.aborted === true || current() === false) break;
        try {
          results.push(await generationRouter.generate(request.roleId, request, options));
        } catch {
          if (signal?.aborted === true || current() === false) break;
          results.push({ ok: false });
        }
      }
    }
    const cards = results.flatMap((result, index) => cardsFromProviderResult(result, {
      ...sourceContext,
      expectedSnapshotHash: requests[index]?.snapshotHash,
      expectedRole: requests[index]?.metadata?.role,
      expectedFamily: requests[index]?.metadata?.family,
      sourceCardIds: requests[index]?.metadata?.sourceCardIds || [],
      sourceCards: requests[index]?.metadata?.sourceCards || []
    }).map((card) => {
      const retryCount = progressRetryCount(result?.diagnostics?.retryCount);
      return {
        ...card,
        providerLane: result?.lane || requests[index]?.lane || 'utility',
        ...(retryCount ? {
          providerRetryCount: retryCount,
          providerProgressReason: providerCardRetryReason(retryCount, usedBatch)
        } : {})
      };
    }));
    return {
      cards,
      diagnostics: baseDiagnostics
    };
  } catch {
    return {
      cards: [],
      diagnostics: baseDiagnostics
    };
  }
}
