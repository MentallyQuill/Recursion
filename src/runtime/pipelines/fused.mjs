import {
  buildFusedCardBundleRequest,
  cardsFromFusedProviderResult
} from '../../cards.mjs';
import { runSegmentedCardPipeline } from './segmented.mjs';

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
  const segmentedFallback = (diagnostics = []) => runSegmentedCardPipeline({
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
  if (!fusedBaseRequest) return segmentedFallback();
  if (typeof generationRouter.generate !== 'function') return segmentedFallback();

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
    const requestWithSignal = signal ? { ...fusedRequest, signal } : fusedRequest;
    const result = await generationRouter.generate('fusedCardBundle', requestWithSignal, {
      runId,
      signal
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
      const retryCount = progressRetryCount(result?.diagnostics?.retryCount);
      return {
        cards: parsed.cards.map((card) => ({
          ...card,
          providerLane: result?.lane || fusedRequest.lane || 'utility',
          ...(retryCount ? {
            providerRetryCount: retryCount,
            providerProgressReason: providerCardRetryReason(retryCount, true)
          } : {})
        })),
        diagnostics: mergeDiagnostics(['fused-bundle-used'], fusedDiagnostics)
      };
    }
    fusedDiagnostics.push('fused-fallback-segmented');
  } catch {
    fusedDiagnostics.push('fused-bundle-provider-failed', 'fused-fallback-segmented');
  }

  return segmentedFallback(fusedDiagnostics);
}
