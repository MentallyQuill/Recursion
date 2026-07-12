import {
  buildFusedCardBundleRequest,
  cardsFromFusedProviderResult,
  cardsFromProviderResult
} from '../../cards.mjs';
import { runStandardCardPipeline } from './standard.mjs';

function defaultSafeText(value, limit = 200) {
  return String(value ?? '').trim().slice(0, limit);
}

function mergeDiagnostics(...groups) {
  return [...new Set(groups.flatMap((group) => Array.isArray(group) ? group : []).filter(Boolean))];
}

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

export function repairRequestsForFusedResult(parsed, allRequests, safeText = defaultSafeText) {
  const accepted = new Set(Array.isArray(parsed.acceptedFamilies)
    ? parsed.acceptedFamilies
    : parsed.cards.map((card) => card.family));
  const damaged = new Set([
    ...(Array.isArray(parsed.invalidFamilies) ? parsed.invalidFamilies : []),
    ...(Array.isArray(parsed.missingFamilies) ? parsed.missingFamilies : []),
    ...(Array.isArray(parsed.omissions)
      ? parsed.omissions.map((entry) => safeText(entry.family || '', 120)).filter(Boolean)
      : [])
  ]);
  return allRequests.filter((request) => {
    const family = safeText(request.metadata?.family || '', 120);
    return family && !accepted.has(family) && damaged.has(family);
  });
}

export async function runFusedCardPipeline({
  plan,
  snapshot,
  settings,
  generationRouter,
  requests = [],
  requestContext,
  sourceContext = {},
  applyFusedRequest,
  stageRuntimeActivity,
  signal,
  isCurrent,
  safeText = defaultSafeText,
  runId
} = {}) {
  const empty = { cards: [], diagnostics: [] };
  if (!generationRouter) return empty;
  const standardFallback = (diagnostics = []) => runStandardCardPipeline({
    plan,
    snapshot,
    settings,
    generationRouter,
    requests,
    sourceContext,
    stageRuntimeActivity,
    signal,
    isCurrent,
    diagnostics,
    runId
  });

  const fusedBaseRequest = requestContext ? buildFusedCardBundleRequest(plan, requestContext) : null;
  if (!fusedBaseRequest) return standardFallback();
  if (typeof generationRouter.generate !== 'function') return standardFallback();

  const fusedDiagnostics = [];
  const fusedRequest = typeof applyFusedRequest === 'function'
    ? applyFusedRequest(fusedBaseRequest, settings)
    : fusedBaseRequest;
  stageRuntimeActivity?.({
    runId,
    phase: 'fusedCardBundleRunning',
    label: 'Generating fused card bundle...',
    cardCounts: { requested: fusedRequest.requestedCards.length },
    providerLane: fusedRequest.lane,
    chips: ['Fused', String(fusedRequest.requestedCards.length), fusedRequest.lane === 'reasoner' ? 'Reasoner' : 'Utility']
  });

  try {
    const current = typeof isCurrent === 'function' ? isCurrent : () => true;
    const requestWithSignal = signal ? { ...fusedRequest, signal } : fusedRequest;
    const result = await generationRouter.generate('fusedCardBundle', requestWithSignal, {
      runId,
      signal,
      isCurrent: current
    });
    const parsed = cardsFromFusedProviderResult(result, {
      ...sourceContext,
      expectedSnapshotHash: fusedRequest.snapshotHash,
      requestedCards: fusedRequest.requestedCards,
      providerLane: fusedRequest.lane
    });
    fusedDiagnostics.push(...parsed.diagnostics);
    if (parsed.omissions.length) {
      fusedDiagnostics.push(...parsed.omissions.map((entry) => `fused-omitted:${safeText(entry.family || entry.role || 'unknown', 80)}`));
    }
    if (parsed.cards.length > 0) {
      const repairRequests = repairRequestsForFusedResult(parsed, requests, safeText);
      let repairedCards = [];
      if (repairRequests.length) {
        fusedDiagnostics.push('fused-partial-repair-standard');
        fusedDiagnostics.push(...repairRequests.map((request) => `fused-repair:${safeText(request.metadata?.family || request.roleId || 'unknown', 80)}`));
        const signalRepairRequests = signal
          ? repairRequests.map((request) => ({ ...request, signal }))
          : repairRequests;
        const repairOptions = { runId, signal, isCurrent: current };
        const usedRepairBatch = typeof generationRouter.batch === 'function';
        const repairResults = usedRepairBatch
          ? await generationRouter.batch(signalRepairRequests, repairOptions)
          : [];
        if (!usedRepairBatch) {
          for (const request of signalRepairRequests) {
            if (signal?.aborted === true || current() === false) break;
            try {
              repairResults.push(await generationRouter.generate(request.roleId, request, repairOptions));
            } catch {
              if (signal?.aborted === true || current() === false) break;
              repairResults.push({ ok: false });
            }
          }
        }
        repairedCards = repairResults.flatMap((repairResult, index) => cardsFromProviderResult(repairResult, {
          ...sourceContext,
          expectedSnapshotHash: repairRequests[index]?.snapshotHash,
          expectedRole: repairRequests[index]?.metadata?.role,
          expectedFamily: repairRequests[index]?.metadata?.family,
          sourceCardIds: repairRequests[index]?.metadata?.sourceCardIds || [],
          sourceCards: repairRequests[index]?.metadata?.sourceCards || []
        }).map((card) => ({
          ...card,
          providerLane: repairResult?.lane || repairRequests[index]?.lane || 'utility',
          providerRole: repairRequests[index]?.roleId || card.providerRole || '',
          fusedRepair: true,
          providerProgressSource: 'fused-repair'
        })));
      }
      const retryCount = progressRetryCount(result?.diagnostics?.retryCount);
      return {
        cards: [
          ...parsed.cards.map((card) => ({
            ...card,
            providerLane: result?.lane || fusedRequest.lane || 'utility',
            ...(retryCount ? {
              providerRetryCount: retryCount,
              providerProgressReason: providerCardRetryReason(retryCount, true)
            } : {})
          })),
          ...repairedCards
        ],
        diagnostics: mergeDiagnostics(['fused-bundle-used'], fusedDiagnostics)
      };
    }
    fusedDiagnostics.push('fused-fallback-standard');
  } catch {
    fusedDiagnostics.push('fused-bundle-provider-failed', 'fused-fallback-standard');
  }

  return standardFallback(fusedDiagnostics);
}
