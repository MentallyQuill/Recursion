import {
  buildRapidTurnDeltaPrompt,
  chooseRapidHedgeWinner,
  normalizeRapidTurnDelta
} from '../../rapid-pipeline.mjs';

function defaultSafeText(value, limit = 200) {
  return String(value ?? '').trim().slice(0, limit);
}

async function generateRapidForeground({
  generationRouter,
  roleId,
  request,
  options = {},
  hedgeDelayMs,
  safeText = defaultSafeText
}) {
  const hedgeDelay = Number(hedgeDelayMs);
  if (!Number.isFinite(hedgeDelay) || hedgeDelay < 0 || typeof setTimeout !== 'function') {
    return generationRouter.generate(roleId, { ...request, rapidHedgeSource: 'primary' }, options);
  }
  const started = Date.now();
  const call = async (source) => {
    try {
      const result = await generationRouter.generate(roleId, { ...request, rapidHedgeSource: source }, options);
      return { source, result, settledAtMs: Date.now() - started };
    } catch (error) {
      return {
        source,
        result: { ok: false, error: { message: safeText(error?.message || error, 240) } },
        settledAtMs: Date.now() - started
      };
    }
  };
  const primary = call('primary');
  const backup = new Promise((resolve) => {
    setTimeout(() => resolve(call('backup')), Math.max(0, Math.round(hedgeDelay)));
  }).then((entry) => entry);
  const first = await Promise.race([primary, backup]);
  if (first?.result?.ok === true) return {
    ...first.result,
    diagnostics: {
      ...(first.result.diagnostics || {}),
      rapidHedgeWinner: first.source
    }
  };
  const second = await (first?.source === 'primary' ? backup : primary);
  const winner = chooseRapidHedgeWinner([first, second]);
  if (winner?.result?.ok === true) return {
    ...winner.result,
    diagnostics: {
      ...(winner.result.diagnostics || {}),
      rapidHedgeWinner: winner.source
    }
  };
  return first?.result || second?.result || { ok: false, error: { message: 'Rapid provider calls failed.' } };
}

export async function warmRapidPipeline({
  reason,
  snapshot,
  settings,
  providerClient,
  storage,
  progress,
  signal,
  journal,
  execute
} = {}) {
  if (typeof execute === 'function') return execute();
  const result = await providerClient.generateRapidWarmDeck({
    reason,
    snapshot,
    settings,
    signal,
    onProgress: progress
  });
  await storage?.saveRapidWarm?.(result);
  journal?.({ event: 'rapid-warm-complete', reason, cardCount: result?.cards?.length || 0 });
  return result;
}

export async function runRapidForegroundPipeline({
  snapshot,
  settings,
  warmDeck,
  providerClient,
  progress,
  signal,
  journal,
  generationRouter,
  hedgeDelayMs,
  runId,
  snapshotHash,
  baseSourceRevisionHash,
  turnSourceRevisionHash,
  pendingUserMessage,
  rapid,
  selectedWarmCards = [],
  storyForm,
  stageRuntimeActivity,
  settleRuntimeActivity,
  isCurrent,
  safeText = defaultSafeText
} = {}) {
  if (providerClient?.generateRapidTurnDelta) {
    const result = await providerClient.generateRapidTurnDelta({
      snapshot,
      settings,
      warmDeck,
      signal,
      onProgress: progress
    });
    journal?.({ event: 'rapid-foreground-complete', cardCount: result?.cards?.length || 0 });
    return result;
  }

  stageRuntimeActivity?.({
    runId,
    phase: 'rapidDeltaRunning',
    label: 'Rapid selecting turn guidance...',
    chips: ['Rapid', 'Warm']
  });
  const providerResult = await generateRapidForeground({
    generationRouter,
    roleId: 'rapidTurnDelta',
    request: {
      lane: 'utility',
      runId,
      signal,
      snapshotHash,
      baseSourceRevisionHash,
      turnSourceRevisionHash,
      prompt: buildRapidTurnDeltaPrompt({
        snapshotHash,
        baseSourceRevisionHash,
        turnSourceRevisionHash,
        userMessage: pendingUserMessage?.text || '',
        warmArtifact: rapid,
        warmGuidance: rapid?.guidance,
        storyForm,
        selectedCards: selectedWarmCards.map((card) => ({
          id: card.id,
          family: card.family,
          promptText: card.promptText,
          emphasis: card.emphasis,
          detailProfile: card.detailProfile,
          evidenceRefs: card.evidenceRefs
        }))
      })
    },
    options: { runId, signal, isCurrent },
    hedgeDelayMs,
    safeText
  });
  if (!providerResult?.ok) {
    settleRuntimeActivity?.({
      runId,
      outcome: 'warning',
      label: 'Rapid provider output was unavailable; using Standard.',
      chips: ['Rapid']
    });
    return { ok: false, escalateToStandard: true, diagnostics: ['rapid-escalated-standard:provider-unavailable'] };
  }
  let normalized;
  try {
    normalized = normalizeRapidTurnDelta(providerResult.data, {
      snapshotHash,
      baseSourceRevisionHash,
      turnSourceRevisionHash,
      allowedCardIds: selectedWarmCards.map((card) => card.id)
    });
  } catch {
    return {
      ok: false,
      escalateToStandard: true,
      diagnostics: ['rapid-escalated-standard:invalid-provider-output']
    };
  }
  if (normalized.escalateToStandard || normalized.mandatoryMissingCards.length) {
    const mandatoryGapDiagnostics = normalized.mandatoryMissingCards
      .slice(0, 3)
      .map((entry) => `rapid-mandatory-gap:${safeText(entry.family || entry.role || 'unknown', 80)}`);
    return {
      ok: false,
      escalateToStandard: true,
      diagnostics: [
        'rapid-escalated-standard:mandatory-gap',
        ...mandatoryGapDiagnostics
      ]
    };
  }
  const hasPromptText = safeText(rapid?.guidance?.text || '', 2000)
    && (
      safeText(normalized.turnGuidanceText || '', 2000)
      || (Array.isArray(normalized.packetInstructions) && normalized.packetInstructions.length)
    );
  if (!hasPromptText) {
    settleRuntimeActivity?.({
      runId,
      outcome: 'warning',
      label: 'Rapid provider output was empty; using Standard.',
      chips: ['Rapid']
    });
    return { ok: false, escalateToStandard: true, diagnostics: ['rapid-escalated-standard:empty-provider-guidance'] };
  }
  journal?.({ event: 'rapid-foreground-complete', cardCount: selectedWarmCards.length });
  return { ok: true, providerResult, normalized };
}
