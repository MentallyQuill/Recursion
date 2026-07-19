import { hashJson, makeId, safeId as canonicalId } from './core.mjs';
import {
  getActivePostProcessDeck,
  orderedRunnablePostProcessCategories
} from './post-process-decks.mjs';
import {
  buildPostProcessGuidanceRequest,
  postProcessGuidanceRoute
} from './post-process-guidance.mjs';

const POST_PROCESS_WRITER_PACKET_SCHEMA = 'recursion.postProcessWriterPacket.v1';
const POST_PROCESS_WRITER_BOUNDARIES = Object.freeze([
  'Preserve unsupported material, continuity, user agency, consent, and established character voice.',
  'Apply only revisions supported by the frozen draft and selected Post-process cards.',
  'Do not continue beyond the supplied response or invent a new plot turn solely to satisfy a card.',
  'Return only the revised assistant response and never mention the editing process.'
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    for (const item of value) result.push(cloneValue(item, seen));
    return result;
  }
  const result = {};
  seen.set(value, result);
  for (const [key, child] of Object.entries(value)) {
    result[key] = cloneValue(child, seen);
  }
  return result;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function safeId(value, fallback = '') {
  const text = cleanText(value)
    .replace(/[^a-z0-9:_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return text || fallback;
}

function safeCode(value, fallback) {
  const normalized = cleanText(value).toUpperCase();
  if (/^RECURSION_[A-Z0-9_]{1,119}$/.test(normalized)) return normalized;
  const safeFallback = cleanText(fallback).toUpperCase();
  return /^RECURSION_[A-Z0-9_]{1,119}$/.test(safeFallback)
    ? safeFallback
    : 'RECURSION_POST_PROCESS_FAILED';
}

function normalizedApplyMode(value) {
  return value === 'replace' ? 'replace' : 'as-swipe';
}

function normalizedRewriteFlow(value) {
  return value === 'progressive' ? 'progressive' : 'unified';
}

function messageRole(message = {}) {
  const explicit = cleanText(message.role).toLowerCase();
  if (explicit) return explicit;
  if (message.is_user === true || message.isUser === true) return 'user';
  if (message.is_system === true || message.isSystem === true) return 'system';
  return 'assistant';
}

function messageText(message = {}) {
  return String(message.text ?? message.mes ?? message.content ?? '');
}

function messageId(message = {}, fallback = 0) {
  const candidate = Number(message.mesid ?? message.id ?? message.messageId);
  return Number.isFinite(candidate) ? candidate : fallback;
}

function latestMessageByRole(messages, role) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageRole(messages[index]) === role) return { message: messages[index], index };
  }
  return null;
}

function boundedSupportingContext(rawSnapshot, settings, assistantIndex) {
  if (isObject(rawSnapshot.supportingContext)) {
    return cloneValue(rawSnapshot.supportingContext);
  }
  const messages = Array.isArray(rawSnapshot.messages) ? rawSnapshot.messages : [];
  const prior = assistantIndex >= 0 ? messages.slice(0, assistantIndex) : messages;
  const requestedLimit = Number(settings?.postProcess?.contextMessages);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.min(35, Math.round(requestedLimit)))
    : 13;
  const bounded = limit > 0 ? prior.slice(-limit) : [];
  const latestUser = latestMessageByRole(prior, 'user')?.message;
  return {
    latestUserMessage: latestUser ? messageText(latestUser) : '',
    boundedPriorMessages: bounded.map((message, index) => ({
      messageId: messageId(message, index),
      role: messageRole(message),
      text: messageText(message)
    })),
    characterContext: cloneValue(rawSnapshot.characterContext ?? null),
    preProcessPromptPacket: cloneValue(rawSnapshot.preProcessPromptPacket ?? null),
    storyForm: cloneValue(rawSnapshot.storyForm ?? null)
  };
}

async function capturePostProcessSnapshot(rawSnapshot, settings, host) {
  const source = isObject(rawSnapshot) ? rawSnapshot : {};
  const messages = Array.isArray(source.messages) ? source.messages : [];
  let identity = null;
  const identityProvider = typeof host?.messages?.postProcessSourceIdentity === 'function'
    ? host.messages.postProcessSourceIdentity.bind(host.messages)
    : typeof host?.messages?.activeAssistantMessageIdentity === 'function'
      ? host.messages.activeAssistantMessageIdentity.bind(host.messages)
      : null;
  if (identityProvider) {
    try {
      identity = await identityProvider();
    } catch {
      identity = null;
    }
  }
  const latestAssistant = latestMessageByRole(messages, 'assistant');
  const originalDraft = String(
    source.originalDraft
      ?? identity?.text
      ?? (latestAssistant ? messageText(latestAssistant.message) : '')
  );
  const sourceMessageId = source.sourceMessageId
    ?? identity?.messageId
    ?? (latestAssistant ? messageId(latestAssistant.message, latestAssistant.index) : null);
  const sourceSwipeId = Number(
    source.sourceSwipeId
      ?? identity?.swipeId
      ?? latestAssistant?.message?.swipeId
      ?? latestAssistant?.message?.swipe_id
      ?? 0
  );
  const sourceHash = cleanText(source.sourceHash || identity?.originalHash) || hashJson(originalDraft);
  const supportingContext = boundedSupportingContext(
    source,
    settings,
    latestAssistant?.index ?? -1
  );
  const normalized = {
    chatKey: canonicalId(
      cleanText(source.chatKey || source.chatId || identity?.chatKey || 'chat'),
      'chat'
    ),
    chatIdentityHash: cleanText(
      source.chatIdentityHash || identity?.chatIdentityHash
    ),
    sourceMessageId,
    sourceSwipeId: Number.isFinite(sourceSwipeId) ? Math.max(0, Math.round(sourceSwipeId)) : 0,
    sourceHash,
    originalDraft,
    activeCharacterHash: cleanText(
      source.activeCharacterHash || identity?.activeCharacterHash
    ),
    activeGroupHash: cleanText(
      source.activeGroupHash || identity?.activeGroupHash
    ),
    supportingContext
  };
  normalized.snapshotHash = cleanText(source.snapshotHash) || hashJson(normalized);
  return normalized;
}

export function buildPostProcessPlan({
  settings = {},
  deck = {},
  snapshot = {}
} = {}) {
  const frozenSnapshot = cloneValue(snapshot);
  delete frozenSnapshot.chatId;
  delete frozenSnapshot.chat_id;
  delete frozenSnapshot.currentChatId;
  if (!cleanText(frozenSnapshot.sourceHash)) {
    frozenSnapshot.sourceHash = hashJson(String(frozenSnapshot.originalDraft ?? ''));
  }
  if (!cleanText(frozenSnapshot.snapshotHash)) {
    frozenSnapshot.snapshotHash = hashJson(frozenSnapshot);
  }
  const categories = orderedRunnablePostProcessCategories(deck);
  const route = postProcessGuidanceRoute(settings.reasoningLevel);
  return deepFreeze({
    operationId: makeId('post-process'),
    snapshot: frozenSnapshot,
    snapshotHash: frozenSnapshot.snapshotHash,
    sourceHash: frozenSnapshot.sourceHash,
    deckId: safeId(deck?.id, 'post-process-deck'),
    reasoningLevel: cleanText(settings.reasoningLevel || 'medium').toLowerCase(),
    route: cloneValue(route),
    applyMode: normalizedApplyMode(settings?.postProcess?.applyMode),
    rewriteFlow: normalizedRewriteFlow(settings?.postProcess?.rewriteFlow),
    categories
  });
}

function stageInput(operation, categories, draft) {
  return Object.freeze({
    operationId: operation.operationId,
    snapshotHash: operation.snapshotHash,
    sourceHash: operation.sourceHash,
    reasoningLevel: operation.reasoningLevel,
    supportingContext: operation.snapshot.supportingContext,
    categories,
    draft
  });
}

function guidanceAttempts(result) {
  const retryCount = Number(result?.diagnostics?.retryCount);
  return Math.max(1, Math.min(2, Number.isFinite(retryCount) ? retryCount + 1 : 1));
}

function structuralFailureCode(result, fallback) {
  return safeCode(result?.error?.code, fallback);
}

function guidanceRequestForStage(stage, operation) {
  const request = {
    ...buildPostProcessGuidanceRequest(stage),
    lane: operation.route.lane
  };
  Object.defineProperties(request, {
    draft: {
      configurable: false,
      enumerable: false,
      value: stage.draft,
      writable: false
    },
    supportingContext: {
      configurable: false,
      enumerable: false,
      value: stage.supportingContext,
      writable: false
    },
    categories: {
      configurable: false,
      enumerable: false,
      value: stage.categories,
      writable: false
    }
  });
  return request;
}

async function synthesizeCategoryGuidance(stage, operation, generationRouter) {
  if (typeof generationRouter?.generate !== 'function') {
    return {
      ok: false,
      attempts: 0,
      failureCode: 'RECURSION_POST_PROCESS_GUIDANCE_UNAVAILABLE'
    };
  }
  let result;
  try {
    result = await generationRouter.generate(
      operation.route.roleId,
      guidanceRequestForStage(stage, operation),
      { maxAttempts: 2, signal: operation.signal }
    );
  } catch (error) {
    if (operation.signal.aborted || error?.name === 'AbortError') throw error;
    return {
      ok: false,
      attempts: 1,
      failureCode: safeCode(error?.code, 'RECURSION_POST_PROCESS_GUIDANCE_FAILED')
    };
  }
  if (operation.signal.aborted) return { ok: false, canceled: true, attempts: guidanceAttempts(result) };
  const guidanceText = cleanText(result?.data?.guidanceText);
  if (result?.ok !== true || !guidanceText) {
    return {
      ok: false,
      attempts: guidanceAttempts(result),
      failureCode: structuralFailureCode(
        result,
        guidanceText
          ? 'RECURSION_POST_PROCESS_GUIDANCE_FAILED'
          : 'RECURSION_POST_PROCESS_GUIDANCE_EMPTY'
      )
    };
  }
  return {
    ok: true,
    attempts: guidanceAttempts(result),
    data: {
      schema: cleanText(result.data.schema),
      snapshotHash: cleanText(result.data.snapshotHash),
      sourceHash: cleanText(result.data.sourceHash),
      guidanceText
    }
  };
}

function buildPostProcessWriterPacket(stage, guidance) {
  return JSON.stringify({
    schema: POST_PROCESS_WRITER_PACKET_SCHEMA,
    snapshotHash: stage.snapshotHash,
    sourceHash: stage.sourceHash,
    categories: stage.categories.map((category) => ({
      id: category.id,
      name: category.name,
      cards: category.cards.map((card) => ({
        id: card.id,
        name: card.name,
        promptText: card.promptText
      }))
    })),
    guidance: guidance.guidanceText,
    boundaries: POST_PROCESS_WRITER_BOUNDARIES
  });
}

function buildWriterDirective(stage) {
  return [
    'Rewrite the supplied current draft.',
    'Follow the installed Recursion Post-process packet.',
    ...POST_PROCESS_WRITER_BOUNDARIES,
    'Current writable draft:',
    stage.draft
  ].join('\n\n');
}

function usableRewrite(result, draft) {
  const text = cleanText(result?.text);
  return result?.ok === true && Boolean(text) && text !== cleanText(draft)
    ? text
    : '';
}

async function rewriteWithRetry(stage, guidance, operation, host) {
  if (typeof host?.generation?.rewriteWithPostProcess !== 'function') {
    return {
      ok: false,
      attempts: 0,
      failureCode: 'RECURSION_POST_PROCESS_WRITER_UNAVAILABLE'
    };
  }
  const guidancePacket = buildPostProcessWriterPacket(stage, guidance.data);
  const writerDirective = buildWriterDirective(stage);
  let lastFailureCode = 'RECURSION_POST_PROCESS_WRITER_FAILED';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (operation.signal.aborted) return { ok: false, canceled: true, attempts: attempt - 1 };
    let result;
    try {
      result = await host.generation.rewriteWithPostProcess({
        guidancePacket,
        writerDirective,
        signal: operation.signal
      });
    } catch (error) {
      if (operation.signal.aborted || error?.name === 'AbortError') throw error;
      result = {
        ok: false,
        error: {
          code: safeCode(error?.code, 'RECURSION_POST_PROCESS_WRITER_FAILED')
        }
      };
    }
    if (operation.signal.aborted) return { ok: false, canceled: true, attempts: attempt };
    const text = usableRewrite(result, stage.draft);
    if (text) return { ok: true, text, attempts: attempt };
    lastFailureCode = result?.ok === true
      ? (cleanText(result?.text)
          ? 'RECURSION_POST_PROCESS_WRITER_NOOP'
          : 'RECURSION_POST_PROCESS_WRITER_EMPTY')
      : structuralFailureCode(result, 'RECURSION_POST_PROCESS_WRITER_FAILED');
  }
  return { ok: false, attempts: 2, failureCode: lastFailureCode };
}

function successfulOutcome(category, guidance, rewrite) {
  return {
    categoryId: safeId(category.id, 'category'),
    status: 'success',
    guidanceAttempts: guidance.attempts,
    hostAttempts: rewrite.attempts
  };
}

function failedOutcome(category, failureStage, details = {}) {
  return {
    categoryId: safeId(category.id, 'category'),
    status: 'failed',
    failureStage,
    guidanceAttempts: Number(details.guidanceAttempts || 0),
    hostAttempts: Number(details.hostAttempts || 0),
    failureCode: safeCode(details.failureCode, 'RECURSION_POST_PROCESS_STAGE_FAILED')
  };
}

function outcomeForCategories(categories, create) {
  return categories.map((category) => create(category));
}

async function runUnified(operation, dependencies) {
  const progressCategory = {
    id: 'unified',
    name: 'Unified'
  };
  dependencies.stageCategory?.(operation, progressCategory, 'running');
  const stage = stageInput(
    operation,
    operation.categories,
    operation.snapshot.originalDraft
  );
  const guidance = await synthesizeCategoryGuidance(
    stage,
    operation,
    dependencies.generationRouter
  );
  if (guidance.canceled) return { canceled: true, outcomes: [] };
  if (!guidance.ok) {
    dependencies.stageCategory?.(operation, progressCategory, 'failed', {
      failureStage: 'guidance',
      guidanceAttempts: guidance.attempts,
      failureCode: guidance.failureCode
    });
    return {
      candidate: '',
      outcomes: outcomeForCategories(operation.categories, (category) => failedOutcome(
        category,
        'guidance',
        {
          guidanceAttempts: guidance.attempts,
          failureCode: guidance.failureCode
        }
      ))
    };
  }
  const rewrite = await rewriteWithRetry(
    stage,
    guidance,
    operation,
    dependencies.host
  );
  if (rewrite.canceled) return { canceled: true, outcomes: [] };
  if (!rewrite.ok) {
    dependencies.stageCategory?.(operation, progressCategory, 'failed', {
      failureStage: 'host-rewrite',
      guidanceAttempts: guidance.attempts,
      hostAttempts: rewrite.attempts,
      failureCode: rewrite.failureCode
    });
    return {
      candidate: '',
      outcomes: outcomeForCategories(operation.categories, (category) => failedOutcome(
        category,
        'host-rewrite',
        {
          guidanceAttempts: guidance.attempts,
          hostAttempts: rewrite.attempts,
          failureCode: rewrite.failureCode
        }
      ))
    };
  }
  dependencies.stageCategory?.(operation, progressCategory, 'success', {
    guidanceAttempts: guidance.attempts,
    hostAttempts: rewrite.attempts
  });
  return {
    candidate: rewrite.text,
    outcomes: outcomeForCategories(operation.categories, (category) => successfulOutcome(
      category,
      guidance,
      rewrite
    ))
  };
}

async function runProgressive(operation, dependencies) {
  let latestDraft = operation.snapshot.originalDraft;
  const outcomes = [];
  for (const category of operation.categories) {
    if (operation.signal.aborted) return { canceled: true, outcomes: [] };
    const stage = stageInput(operation, [category], latestDraft);
    dependencies.stageCategory?.(operation, category, 'running');
    const guidance = await synthesizeCategoryGuidance(
      stage,
      operation,
      dependencies.generationRouter
    );
    if (guidance.canceled) return { canceled: true, outcomes: [] };
    if (!guidance.ok) {
      const failed = failedOutcome(category, 'guidance', {
        guidanceAttempts: guidance.attempts,
        failureCode: guidance.failureCode
      });
      outcomes.push(failed);
      dependencies.stageCategory?.(operation, category, 'failed', failed);
      continue;
    }
    const rewrite = await rewriteWithRetry(
      stage,
      guidance,
      operation,
      dependencies.host
    );
    if (rewrite.canceled) return { canceled: true, outcomes: [] };
    if (!rewrite.ok) {
      const failed = failedOutcome(category, 'host-rewrite', {
        guidanceAttempts: guidance.attempts,
        hostAttempts: rewrite.attempts,
        failureCode: rewrite.failureCode
      });
      outcomes.push(failed);
      dependencies.stageCategory?.(operation, category, 'failed', failed);
      continue;
    }
    latestDraft = rewrite.text;
    const success = successfulOutcome(category, guidance, rewrite);
    outcomes.push(success);
    dependencies.stageCategory?.(operation, category, 'success', success);
  }
  return { candidate: latestDraft, outcomes };
}

function diagnosticCategories(outcomes = []) {
  return outcomes.map((outcome) => ({
    categoryId: safeId(outcome.categoryId, 'category'),
    status: outcome.status === 'success' ? 'success' : 'failed',
    guidanceAttempts: Number(outcome.guidanceAttempts || 0),
    hostAttempts: Number(outcome.hostAttempts || 0),
    ...(outcome.failureStage ? { failureStage: outcome.failureStage } : {}),
    ...(outcome.failureCode ? { failureCode: safeCode(outcome.failureCode, 'RECURSION_POST_PROCESS_STAGE_FAILED') } : {})
  }));
}

function markerForCommit(operation, candidate, outcomes, committedApplyMode, partial) {
  return deepFreeze({
    schema: 'recursion.postProcessMarker.v1',
    operationId: operation.operationId,
    sourceHash: hashJson(String(operation.snapshot.originalDraft ?? '')),
    candidateHash: hashJson(String(candidate ?? '')),
    deckId: operation.deckId,
    rewriteFlow: operation.rewriteFlow,
    requestedApplyMode: operation.applyMode,
    committedApplyMode,
    lane: operation.route.lane,
    partial: partial === true,
    categories: diagnosticCategories(outcomes)
  });
}

function diagnosticsFor(operation, {
  outcomes = [],
  status = 'skipped',
  reason = '',
  partial = false,
  committedApplyMode = ''
} = {}) {
  return deepFreeze({
    operationId: operation?.operationId || '',
    deckId: operation?.deckId || '',
    snapshotHash: operation?.snapshotHash || '',
    sourceHash: operation?.sourceHash || '',
    rewriteFlow: operation?.rewriteFlow || '',
    lane: operation?.route?.lane || '',
    roleId: operation?.route?.roleId || '',
    requestedApplyMode: operation?.applyMode || '',
    committedApplyMode,
    partial: partial === true,
    status,
    ...(reason ? { reason: safeId(reason, 'failed') } : {}),
    categories: diagnosticCategories(outcomes)
  });
}

function skippedResult(reason, diagnostics, outcomes = []) {
  return {
    ok: true,
    committed: false,
    skipped: true,
    reason,
    partial: false,
    requestedApplyMode: diagnostics.requestedApplyMode,
    committedApplyMode: '',
    outcomes,
    diagnostics
  };
}

function guardAllowsCommit(value) {
  if (value === false || value?.ok === false || value?.current === false || value?.stale === true) {
    return false;
  }
  return true;
}

async function defaultCommitResult(host, input) {
  const messages = host?.messages;
  const messageId = input.sourceMessageId;
  if (input.mode === 'replace' && typeof messages?.replaceAssistantMessageText === 'function') {
    return messages.replaceAssistantMessageText(messageId, input.text, {
      markerNamespace: input.markerNamespace,
      marker: input.marker
    });
  }
  if (input.mode === 'as-swipe' && typeof messages?.appendAssistantMessageSwipe === 'function') {
    return messages.appendAssistantMessageSwipe(messageId, input.text, {
      markerNamespace: input.markerNamespace,
      marker: input.marker,
      select: true
    });
  }
  return {
    ok: false,
    error: {
      code: 'RECURSION_POST_PROCESS_COMMIT_UNAVAILABLE'
    }
  };
}

export function createPostProcessRuntime({
  host = {},
  generationRouter = null,
  settingsStore = { get: () => ({}) },
  activity = null,
  snapshotProvider = () => host?.snapshot?.(),
  deckProvider = (settings) => getActivePostProcessDeck(settings?.postProcessDecks),
  sourceGuard = async () => true,
  commitResult = (input) => defaultCommitResult(host, input)
} = {}) {
  let active = null;
  let armed = false;
  let lastDiagnostics = diagnosticsFor(null);

  function publish(method, event) {
    try {
      return activity?.[method]?.(event) || null;
    } catch {
      return null;
    }
  }

  function startActivity(record, operation) {
    record.activityStarted = true;
    publish('start', {
      runId: operation.operationId,
      operationId: operation.operationId,
      phase: 'postProcessStarted',
      mode: 'review',
      label: 'Post-processing response...',
      providerLane: operation.route.lane,
      chips: ['Post-process', operation.rewriteFlow === 'progressive' ? 'Progressive' : 'Unified'],
      detail: {
        deckId: operation.deckId,
        rewriteFlow: operation.rewriteFlow,
        requestedApplyMode: operation.applyMode,
        categoryCount: operation.categories.length,
        sourceHash: operation.sourceHash,
        snapshotHash: operation.snapshotHash
      }
    });
  }

  function stageCategory(operation, category, state, details = {}) {
    const failureStage = cleanText(details.failureStage);
    const failed = state === 'failed';
    const retried = Number(details.guidanceAttempts || 0) > 1 || Number(details.hostAttempts || 0) > 1;
    publish('stage', {
      runId: operation.operationId,
      operationId: operation.operationId,
      phase: 'postProcessCategory',
      mode: 'review',
      severity: failed ? 'error' : (retried ? 'warning' : (state === 'success' ? 'success' : 'info')),
      label: cleanText(category?.name || category?.id || 'Post-process category'),
      providerLane: operation.route.lane,
      chips: ['Post-process', cleanText(category?.name || category?.id || 'Category')],
      detail: {
        categoryId: safeId(category?.id, 'category'),
        categoryName: cleanText(category?.name || category?.id || 'Post-process category'),
        state,
        guidanceAttempts: Number(details.guidanceAttempts || 0),
        hostAttempts: Number(details.hostAttempts || 0),
        ...(retried ? { cautionReason: 'Post-process stage recovered after retry.' } : {}),
        ...(failureStage ? { failureStage } : {}),
        ...(failed
          ? {
              failure: {
                code: safeCode(details.failureCode, 'RECURSION_POST_PROCESS_STAGE_FAILED'),
                stage: failureStage ? `post-process-${failureStage}` : 'post-process',
                category: 'post-process',
                message: failureStage === 'guidance'
                  ? 'Guidance synthesis failed after retry.'
                  : 'SillyTavern rewrite failed after retry.'
              }
            }
          : {})
      }
    });
  }

  function settleActivity(record, operation, {
    outcome = 'success',
    label,
    detail = null
  } = {}) {
    if (!record?.activityStarted || record.activitySettled) return;
    record.activitySettled = true;
    publish('settle', {
      runId: operation?.operationId,
      operationId: operation?.operationId,
      outcome,
      mode: 'review',
      label,
      chips: ['Post-process'],
      detail
    });
  }

  function finishWithoutCommit(operation, reason, outcomes = [], extra = {}, record = active) {
    lastDiagnostics = diagnosticsFor(operation, {
      outcomes,
      status: reason === 'canceled' ? 'canceled' : 'skipped',
      reason,
      partial: extra.partial === true
    });
    const canceled = reason === 'canceled';
    const failed = ['all-stages-failed', 'runtime-failed', 'commit-failed'].includes(reason);
    settleActivity(record, operation, {
      outcome: canceled ? 'canceled' : (failed ? 'error' : 'skipped'),
      label: canceled
        ? 'Post-processing canceled. Original kept.'
        : (failed ? 'Post-processing failed. Original kept.' : 'Post-processing skipped. Original kept.'),
      detail: {
        reason: safeId(reason, 'skipped'),
        partial: extra.partial === true,
        categories: diagnosticCategories(outcomes)
      }
    });
    return {
      ...skippedResult(reason, lastDiagnostics, outcomes),
      ...(extra.candidate ? { candidate: extra.candidate } : {})
    };
  }

  async function execute(record) {
    let operation = null;
    try {
      const currentSettings = cloneValue(settingsStore?.get?.() || {});
      if (currentSettings?.postProcess?.enabled !== true) {
        return finishWithoutCommit(null, 'disabled');
      }

      const rawSnapshot = await snapshotProvider();
      if (record.controller.signal.aborted) return finishWithoutCommit(null, 'canceled');
      const capturedSnapshot = await capturePostProcessSnapshot(
        rawSnapshot,
        currentSettings,
        host
      );
      const deck = await deckProvider(currentSettings);
      operation = {
        ...buildPostProcessPlan({
          settings: currentSettings,
          deck,
          snapshot: capturedSnapshot
        }),
        signal: record.controller.signal
      };
      record.phase = 'running';

      if (!cleanText(operation.snapshot.originalDraft)) {
        return finishWithoutCommit(operation, 'empty-source', [], {}, record);
      }
      if (operation.categories.length === 0) {
        return finishWithoutCommit(operation, 'no-runnable-cards', [], {}, record);
      }
      startActivity(record, operation);

      const runResult = operation.rewriteFlow === 'progressive'
        ? await runProgressive(operation, { generationRouter, host, stageCategory })
        : await runUnified(operation, { generationRouter, host, stageCategory });
      if (record.controller.signal.aborted || runResult.canceled) {
        return finishWithoutCommit(operation, 'canceled', [], {}, record);
      }

      const outcomes = runResult.outcomes || [];
      const successes = outcomes.filter((outcome) => outcome.status === 'success');
      if (successes.length === 0) {
        return finishWithoutCommit(operation, 'all-stages-failed', outcomes, {}, record);
      }
      const partial = successes.length < outcomes.length;
      const candidate = cleanText(runResult.candidate);
      if (!candidate) {
        return finishWithoutCommit(operation, 'empty-candidate', outcomes, { partial }, record);
      }
      if (candidate === cleanText(operation.snapshot.originalDraft)) {
        return finishWithoutCommit(operation, 'no-op-candidate', outcomes, { partial }, record);
      }

      let current = false;
      try {
        current = guardAllowsCommit(await sourceGuard(operation.snapshot, operation));
      } catch {
        current = false;
      }
      if (record.controller.signal.aborted) {
        return finishWithoutCommit(operation, 'canceled', [], {}, record);
      }
      if (!current) {
        return finishWithoutCommit(operation, 'stale-source', outcomes, {
          partial,
          candidate
        }, record);
      }

      const committedApplyMode = partial ? 'as-swipe' : operation.applyMode;
      const marker = markerForCommit(
        operation,
        candidate,
        outcomes,
        committedApplyMode,
        partial
      );
      let commit;
      try {
        commit = await commitResult({
          operationId: operation.operationId,
          sourceMessageId: operation.snapshot.sourceMessageId,
          sourceSwipeId: operation.snapshot.sourceSwipeId,
          sourceHash: operation.sourceHash,
          snapshotHash: operation.snapshotHash,
          deckId: operation.deckId,
          rewriteFlow: operation.rewriteFlow,
          requestedApplyMode: operation.applyMode,
          mode: committedApplyMode,
          lane: operation.route.lane,
          partial,
          outcomes: diagnosticCategories(outcomes),
          markerNamespace: 'postProcess',
          marker,
          text: candidate,
          signal: operation.signal
        });
      } catch {
        return finishWithoutCommit(operation, 'commit-failed', outcomes, {
          partial,
          candidate
        }, record);
      }
      if (record.controller.signal.aborted) {
        return finishWithoutCommit(operation, 'canceled', [], {}, record);
      }
      if (commit?.ok === false) {
        return finishWithoutCommit(operation, 'commit-failed', outcomes, {
          partial,
          candidate
        }, record);
      }

      lastDiagnostics = diagnosticsFor(operation, {
        outcomes,
        status: 'committed',
        partial,
        committedApplyMode
      });
      publish('stage', {
        runId: operation.operationId,
        operationId: operation.operationId,
        phase: 'postProcessCommitted',
        mode: 'review',
        severity: partial ? 'warning' : 'success',
        outcome: partial ? 'warning' : 'success',
        label: committedApplyMode === 'replace'
          ? 'Post-process response replaced.'
          : (partial ? 'Post-process swipe added with failed categories.' : 'Post-process swipe added.'),
        chips: ['Post-process', committedApplyMode === 'replace' ? 'Replace' : 'As Swipe'],
        detail: {
          partial,
          requestedApplyMode: operation.applyMode,
          committedApplyMode,
          sourceHash: marker.sourceHash,
          candidateHash: marker.candidateHash,
          ...(partial
            ? { cautionReason: 'Replace was withheld because at least one Post-process category failed.' }
            : {})
        }
      });
      settleActivity(record, operation, {
        outcome: partial ? 'warning' : 'success',
        label: partial ? 'Post-processing completed with failed categories.' : 'Post-processing complete.',
        detail: {
          partial,
          requestedApplyMode: operation.applyMode,
          committedApplyMode,
          sourceHash: marker.sourceHash,
          candidateHash: marker.candidateHash,
          ...(partial
            ? { cautionReason: 'Replace was withheld because at least one Post-process category failed.' }
            : {}),
          categories: diagnosticCategories(outcomes)
        }
      });
      return {
        ok: true,
        committed: true,
        candidate,
        partial,
        requestedApplyMode: operation.applyMode,
        committedApplyMode,
        outcomes,
        diagnostics: lastDiagnostics,
        commit
      };
    } catch (error) {
      const canceled = record.controller.signal.aborted || error?.name === 'AbortError';
      return finishWithoutCommit(
        operation,
        canceled ? 'canceled' : 'runtime-failed',
        [],
        {},
        record
      );
    }
  }

  function runPostProcessForLatestAssistant() {
    if (active?.promise) return active.promise;
    armed = false;
    const record = {
      controller: new AbortController(),
      phase: 'pending',
      activityStarted: false,
      activitySettled: false,
      promise: null
    };
    active = record;
    record.promise = execute(record).finally(() => {
      if (active === record) active = null;
    });
    return record.promise;
  }

  function armPostProcess() {
    if (settingsStore?.get?.()?.postProcess?.enabled !== true) {
      armed = false;
      return { ok: true, armed: false, reason: 'disabled' };
    }
    if (active) return { ok: true, armed: false, reason: 'running' };
    armed = true;
    return { ok: true, armed: true };
  }

  function cancelPostProcess() {
    const canceled = armed || Boolean(active);
    armed = false;
    if (!active) return { ok: true, canceled };
    active.controller.abort();
    return { ok: true, canceled: true };
  }

  return {
    postProcessPending() {
      return armed;
    },
    armPostProcess,
    postProcessRunning() {
      return Boolean(active);
    },
    runPostProcessForLatestAssistant,
    cancelPostProcess,
    postProcessDiagnostics() {
      return cloneValue(lastDiagnostics);
    }
  };
}
