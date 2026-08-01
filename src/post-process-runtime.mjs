import { hashJson, makeId, safeId as canonicalId } from './core.mjs';
import {
  getActivePostProcessDeck,
  orderedRunnablePostProcessCategories
} from './post-process-decks.mjs';
import {
  buildPostProcessGuidanceRequest,
  postProcessGuidanceRoute
} from './post-process-guidance.mjs';
import { runModelStageAttempts } from './execution/attempt-policy.mjs';
import { createExecutionGraph } from './execution/stage-registry.mjs';
import { createPipelineRun } from './execution/checkpoints.mjs';
import { buildRunProvenance } from './execution/provenance.mjs';
import {
  bindQueuedReprocess,
  normalizeQueuedReprocess
} from './execution/queued-reprocess.mjs';
import { purgeTerminalResumeArtifacts } from './storage.mjs';

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
    modelAttemptsPerStep: Math.min(5, Math.max(1, Number.parseInt(settings.modelAttemptsPerStep, 10) || 2)),
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

function recoveredRewriteMessage(code) {
  if (code === 'RECURSION_POST_PROCESS_WRITER_EMPTY') {
    return 'The first SillyTavern rewrite returned no text; the retry succeeded.';
  }
  if (code === 'RECURSION_POST_PROCESS_WRITER_NOOP') {
    return 'The first SillyTavern rewrite did not change the response; the retry succeeded.';
  }
  if (code === 'RECURSION_PROVIDER_TIMEOUT') {
    return 'The first SillyTavern rewrite exceeded the time limit; the retry succeeded.';
  }
  return 'The first SillyTavern rewrite could not complete; the retry succeeded.';
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
  const attemptResult = await runModelStageAttempts({
    attemptsPerStep: operation.modelAttemptsPerStep,
    request: guidanceRequestForStage(stage, operation),
    signal: operation.signal,
    invoke: (request) => generationRouter.generate(
      operation.route.roleId,
      request,
      {
        signal: operation.signal,
        runId: operation.operationId,
        lockRunId: true,
        activityLifecycle: 'nested'
      }
    ),
    validate(result) {
      const guidanceText = cleanText(result?.data?.guidanceText);
      if (result?.ok !== true || !guidanceText) {
        return {
          ok: false,
          error: result?.error || {
            code: 'RECURSION_POST_PROCESS_GUIDANCE_EMPTY'
          }
        };
      }
      return {
        ok: true,
        value: {
          schema: cleanText(result.data.schema),
          snapshotHash: cleanText(result.data.snapshotHash),
          sourceHash: cleanText(result.data.sourceHash),
          guidanceText
        }
      };
    },
    buildCorrectionRequest: ({ request }) => {
      const correction = guidanceRequestForStage(stage, operation);
      correction.prompt = `${cleanText(request.prompt)}\n\nReturn valid post-process guidance matching the requested schema.`;
      return correction;
    }
  });
  if (attemptResult.aborted || operation.signal.aborted) {
    return { ok: false, canceled: true, attempts: attemptResult.attempts.length };
  }
  if (!attemptResult.ok) {
    return {
      ok: false,
      attempts: attemptResult.attempts.length,
      failureCode: safeCode(
        attemptResult.failure?.code,
        'RECURSION_POST_PROCESS_GUIDANCE_FAILED'
      )
    };
  }
  return {
    ok: true,
    attempts: attemptResult.attempts.length,
    data: attemptResult.value
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
  const attemptResult = await runModelStageAttempts({
    attemptsPerStep: operation.modelAttemptsPerStep,
    request: {
      guidancePacket,
      writerDirective,
      draft: stage.draft
    },
    signal: operation.signal,
    invoke: (request) => host.generation.rewriteWithPostProcess({
      guidancePacket: request.guidancePacket,
      writerDirective: request.writerDirective,
      signal: operation.signal
    }),
    validate(result) {
      const text = usableRewrite(result, stage.draft);
      if (text) return { ok: true, value: { text } };
      return {
        ok: false,
        error: {
          code: result?.ok === true
            ? (cleanText(result?.text)
                ? 'RECURSION_POST_PROCESS_WRITER_NOOP'
                : 'RECURSION_POST_PROCESS_WRITER_EMPTY')
            : structuralFailureCode(result, 'RECURSION_POST_PROCESS_WRITER_FAILED'),
          retryable: true
        }
      };
    },
    buildCorrectionRequest: ({ request }) => request
  });
  if (attemptResult.aborted || operation.signal.aborted) {
    return {
      ok: false,
      canceled: true,
      attempts: attemptResult.attempts.length
    };
  }
  if (!attemptResult.ok) {
    return {
      ok: false,
      attempts: attemptResult.attempts.length,
      failureCode: safeCode(
        attemptResult.failure?.code,
        'RECURSION_POST_PROCESS_WRITER_FAILED'
      )
    };
  }
  const recoveredFailure = attemptResult.attempts.find((attempt) => (
    ['failed', 'invalid'].includes(attempt.outcome) && attempt.failure?.code
  ));
  return {
    ok: true,
    text: attemptResult.value.text,
    attempts: attemptResult.attempts.length,
    ...(recoveredFailure
      ? {
          recoveredFailureCode: safeCode(
            recoveredFailure.failure.code,
            'RECURSION_POST_PROCESS_WRITER_FAILED'
          )
        }
      : {})
  };
}

function successfulOutcome(category, guidance, rewrite) {
  return {
    categoryId: safeId(category.id, 'category'),
    status: 'success',
    guidanceAttempts: guidance.attempts,
    hostAttempts: rewrite.attempts,
    ...(rewrite.recoveredFailureCode ? { recoveredFailureCode: rewrite.recoveredFailureCode } : {})
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
  dependencies.stageCategory?.(operation, progressCategory, 'running', {
    activeStage: 'host-rewrite',
    guidanceAttempts: guidance.attempts
  });
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
    hostAttempts: rewrite.attempts,
    ...(rewrite.recoveredFailureCode ? { recoveredFailureCode: rewrite.recoveredFailureCode } : {})
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
    dependencies.stageCategory?.(operation, category, 'running', {
      activeStage: 'host-rewrite',
      guidanceAttempts: guidance.attempts
    });
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
    ...(outcome.recoveredFailureCode
      ? { recoveredFailureCode: safeCode(outcome.recoveredFailureCode, 'RECURSION_POST_PROCESS_WRITER_FAILED') }
      : {}),
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

export function createPostProcessStages({
  operationId = '',
  mode = 'unified',
  categories = [],
  sourceSnapshot = {},
  buildGuidanceRequest = ({ categoryIds, draft }) => ({ categoryIds, draft }),
  buildRewriteRequest = ({ categoryIds, draft, guidance }) => ({
    categoryIds,
    draft,
    guidance
  }),
  validateGuidance = (result) => {
    const data = isObject(result?.data) ? result.data : result;
    return cleanText(data?.guidanceText)
      ? { ok: true, value: data }
      : {
          ok: false,
          error: {
            code: 'RECURSION_POST_PROCESS_GUIDANCE_EMPTY',
            retryable: true
          }
        };
  },
  validateRewrite = (result, { draft }) => {
    const text = usableRewrite(result, draft);
    return text
      ? { ok: true, value: { text } }
      : {
          ok: false,
          error: {
            code: cleanText(result?.text)
              ? 'RECURSION_POST_PROCESS_WRITER_NOOP'
              : 'RECURSION_POST_PROCESS_WRITER_EMPTY',
            retryable: true
          }
        };
  },
  generateGuidance,
  rewrite,
  commit
} = {}) {
  const normalizedMode = normalizedRewriteFlow(mode);
  const orderedCategories = Array.isArray(categories)
    ? categories.map((category) => cloneValue(category))
    : [];
  const sourceStageId = 'postprocess.source-snapshot';
  const stages = [{
    id: sourceStageId,
    version: 1,
    kind: 'local',
    executable: true,
    dependencies: [],
    checkpoint: 'durable',
    failurePolicy: 'blocking',
    buildInputFingerprint() {
      return {
        snapshotHash: cleanText(sourceSnapshot.snapshotHash),
        sourceHash: cleanText(sourceSnapshot.sourceHash)
      };
    },
    run() {
      return {
        snapshot: cloneValue(sourceSnapshot),
        originalDraft: String(sourceSnapshot.originalDraft || ''),
        mode: normalizedMode,
        categories: cloneValue(orderedCategories)
      };
    },
    validate(artifact) {
      return cleanText(artifact?.snapshot?.sourceHash)
        && cleanText(artifact?.originalDraft)
        ? { ok: true, value: artifact }
        : {
            ok: false,
            error: { code: 'RECURSION_POST_PROCESS_SOURCE_INVALID' }
          };
    },
    summarizeArtifact(artifact) {
      return {
        sourceHash: cleanText(artifact?.snapshot?.sourceHash),
        draftHash: hashJson(String(artifact?.originalDraft || '')),
        draftLength: String(artifact?.originalDraft || '').length
      };
    }
  }];

  const groups = normalizedMode === 'progressive'
    ? orderedCategories.map((category) => [category])
    : [orderedCategories];
  let priorRewriteStageId = '';
  for (const [index, group] of groups.entries()) {
    const categoryIds = group.map((category) => safeId(category?.id, `category-${index + 1}`));
    const suffix = normalizedMode === 'unified'
      ? 'unified'
      : safeId(categoryIds[0], `category-${index + 1}`);
    const guidanceStageId = `postprocess.${suffix}.guidance`;
    const rewriteStageId = `postprocess.${suffix}.rewrite`;
    const previousRewriteStageId = priorRewriteStageId;
    const draftDependencyId = previousRewriteStageId || sourceStageId;
    const draftFromDependencies = (dependencies) => (
      previousRewriteStageId
        ? dependencies[draftDependencyId]?.artifact?.text
        : dependencies[sourceStageId]?.artifact?.originalDraft
    );
    stages.push({
      id: guidanceStageId,
      version: 1,
      kind: 'model',
      executable: true,
      dependencies: previousRewriteStageId
        ? [sourceStageId, previousRewriteStageId]
        : [sourceStageId],
      checkpoint: 'durable',
      failurePolicy: 'blocking',
      buildInputFingerprint(_context, dependencies) {
        return {
          sourceHash: dependencies[sourceStageId].checkpoint.outputHash,
          draftHash: hashJson(String(draftFromDependencies(dependencies) || '')),
          categoryIds
        };
      },
      buildRequest(_context, dependencies) {
        return buildGuidanceRequest({
          operationId,
          categories: group,
          categoryIds,
          sourceSnapshot,
          draft: String(draftFromDependencies(dependencies) || ''),
          dependencies
        });
      },
      run({ request, signal, attempt }) {
        if (typeof generateGuidance !== 'function') {
          throw Object.assign(new Error('Post-process guidance is unavailable.'), {
            code: 'RECURSION_POST_PROCESS_GUIDANCE_UNAVAILABLE',
            retryable: false
          });
        }
        return generateGuidance(request, {
          signal,
          attempt,
          categoryIds
        });
      },
      validate(result) {
        return validateGuidance(result, {
          sourceSnapshot,
          categories: group,
          categoryIds
        });
      },
      buildCorrectionRequest({ request, error, attempt }) {
        return {
          ...request,
          prompt: [
            cleanText(request?.prompt),
            `Correction required after attempt ${attempt}: ${cleanText(error?.message || error?.code || 'invalid guidance')}.`,
            'Return valid post-process guidance matching the requested schema.'
          ].filter(Boolean).join('\n\n')
        };
      },
      summarizeArtifact(artifact) {
        return {
          categoryIds,
          guidanceHash: hashJson(artifact),
          guidanceLength: cleanText(artifact?.guidanceText).length
        };
      }
    });
    stages.push({
      id: rewriteStageId,
      version: 1,
      kind: 'model',
      executable: true,
      dependencies: [
        sourceStageId,
        guidanceStageId,
        ...(previousRewriteStageId ? [previousRewriteStageId] : [])
      ],
      checkpoint: 'durable',
      failurePolicy: 'blocking',
      buildInputFingerprint(_context, dependencies) {
        return {
          guidanceHash: dependencies[guidanceStageId].checkpoint.outputHash,
          draftHash: hashJson(String(draftFromDependencies(dependencies) || '')),
          categoryIds
        };
      },
      buildRequest(_context, dependencies) {
        const draft = String(draftFromDependencies(dependencies) || '');
        return buildRewriteRequest({
          operationId,
          categories: group,
          categoryIds,
          sourceSnapshot,
          draft,
          guidance: dependencies[guidanceStageId].artifact,
          dependencies
        });
      },
      run({ request, signal, attempt, dependencies }) {
        if (typeof rewrite !== 'function') {
          throw Object.assign(new Error('Post-process rewrite is unavailable.'), {
            code: 'RECURSION_POST_PROCESS_WRITER_UNAVAILABLE',
            retryable: false
          });
        }
        return rewrite(request, {
          signal,
          attempt,
          categoryIds,
          dependencies
        });
      },
      validate(result, validationContext = {}) {
        if (
          validationContext.reuse === true
          && cleanText(result?.text)
          && cleanText(result.text) !== cleanText(
            draftFromDependencies(validationContext.dependencies || {})
          )
        ) {
          return { ok: true, value: result };
        }
        return validateRewrite(result, {
          draft: String(draftFromDependencies(validationContext.dependencies || {}) || ''),
          sourceSnapshot,
          categories: group,
          categoryIds
        });
      },
      summarizeArtifact(artifact) {
        return {
          categoryIds,
          draftHash: hashJson(String(artifact?.text || '')),
          draftLength: String(artifact?.text || '').length,
          validationStatus: 'accepted'
        };
      }
    });
    priorRewriteStageId = rewriteStageId;
  }

  const finalRewriteStageId = priorRewriteStageId;
  stages.push({
    id: 'postprocess.host-commit',
    version: 1,
    kind: 'host',
    executable: true,
    dependencies: [sourceStageId, finalRewriteStageId],
    checkpoint: 'durable',
    failurePolicy: 'blocking',
    buildInputFingerprint(_context, dependencies) {
      return {
        sourceHash: dependencies[sourceStageId].checkpoint.outputHash,
        finalDraftHash: dependencies[finalRewriteStageId].checkpoint.outputHash
      };
    },
    async run({ dependencies, signal }) {
      const text = String(dependencies[finalRewriteStageId].artifact?.text || '');
      const finalArtifactHash = hashJson(text);
      const commitId = hashJson({ operationId, finalArtifactHash });
      if (typeof commit !== 'function') {
        throw Object.assign(new Error('Post-process commit is unavailable.'), {
          code: 'RECURSION_POST_PROCESS_COMMIT_UNAVAILABLE',
          retryable: false
        });
      }
      return commit({
        operationId,
        commitId,
        sourceSnapshot,
        text,
        finalArtifactHash,
        signal
      });
    },
    validate(artifact) {
      return artifact?.ok !== false && (artifact?.applied === true || artifact?.reason === 'already-applied')
        ? { ok: true, value: artifact }
        : {
            ok: false,
            error: artifact?.error || {
              code: 'RECURSION_POST_PROCESS_COMMIT_FAILED'
            }
          };
    },
    summarizeArtifact(artifact) {
      return {
        applied: artifact?.applied === true,
        reason: cleanText(artifact?.reason),
        commitId: cleanText(artifact?.receipt?.commitId),
        finalArtifactHash: cleanText(artifact?.receipt?.finalArtifactHash)
      };
    }
  });

  return createExecutionGraph({ stages });
}

async function defaultCommitResult(host, input) {
  const messages = host?.messages;
  const messageId = input.sourceMessageId;
  if (input.mode === 'replace' && typeof messages?.replaceAssistantMessageText === 'function') {
    return messages.replaceAssistantMessageText(messageId, input.text, {
      markerNamespace: input.markerNamespace,
      marker: input.marker,
      expectedSourceIdentity: input.expectedSourceIdentity,
      signal: input.signal
    });
  }
  if (input.mode === 'as-swipe' && typeof messages?.appendAssistantMessageSwipe === 'function') {
    return messages.appendAssistantMessageSwipe(messageId, input.text, {
      markerNamespace: input.markerNamespace,
      marker: input.marker,
      expectedSourceIdentity: input.expectedSourceIdentity,
      signal: input.signal,
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
  commitResult = (input) => defaultCommitResult(host, input),
  durableExecution = null
} = {}) {
  let active = null;
  let pendingTrigger = null;
  let finalizationClaim = null;
  let lastDiagnostics = diagnosticsFor(null);
  const durableOperations = new Map();
  const durableScheduler = durableExecution?.scheduler || null;
  const durableRepository = durableExecution?.repository || null;
  const durableEnabled = Boolean(durableScheduler && durableRepository);

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
    const recoveredFailureCode = details.recoveredFailureCode
      ? safeCode(details.recoveredFailureCode, 'RECURSION_POST_PROCESS_WRITER_FAILED')
      : '';
    const recoveredMessage = recoveredFailureCode ? recoveredRewriteMessage(recoveredFailureCode) : '';
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
        activeStage: cleanText(details.activeStage),
        guidanceAttempts: Number(details.guidanceAttempts || 0),
        hostAttempts: Number(details.hostAttempts || 0),
        ...(retried ? { cautionReason: recoveredMessage || 'Post-process stage recovered after retry.' } : {}),
        ...(recoveredFailureCode
          ? {
              recoveredFailureCode,
              failure: {
                code: recoveredFailureCode,
                stage: 'post-process-host-rewrite',
                category: 'host-mutation',
                message: recoveredMessage,
                retryable: false
              }
            }
          : {}),
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

  function durableProvenance(operation, currentSettings) {
    return buildRunProvenance({
      chatKey: operation.snapshot.chatKey,
      sourceIdentity: {
        sourceRevisionHash: operation.sourceHash,
        latestMessageId: String(operation.snapshot.sourceMessageId ?? ''),
        selectedSwipeId: String(operation.snapshot.sourceSwipeId ?? ''),
        characterHash: cleanText(operation.snapshot.activeCharacterHash),
        groupHash: cleanText(operation.snapshot.activeGroupHash)
      },
      settingsHash: hashJson({
        reasoningLevel: currentSettings.reasoningLevel,
        modelAttemptsPerStep: currentSettings.modelAttemptsPerStep,
        postProcess: currentSettings.postProcess,
        postProcessDecks: currentSettings.postProcessDecks
      }),
      provider: {
        id: cleanText(operation.route?.lane || 'utility'),
        model: ''
      },
      pipelineMode: 'segmented',
      promptVersions: { postProcess: 1 },
      providerContractHash: 'recursion.postprocess.provider.v1',
      deckRevisionHash: hashJson({
        deckId: operation.deckId,
        categories: operation.categories
      }),
      cardConfigurationHash: hashJson(operation.categories),
      promptContractHash: hashJson({
        writerPacketSchema: POST_PROCESS_WRITER_PACKET_SCHEMA,
        boundaries: POST_PROCESS_WRITER_BOUNDARIES
      })
    });
  }

  function durableGraph(operation) {
    const outcomes = operation.categories.map((category) => ({
      categoryId: safeId(category.id, 'category'),
      status: 'success',
      guidanceAttempts: 1,
      hostAttempts: 1
    }));
    return createPostProcessStages({
      operationId: operation.operationId,
      mode: operation.rewriteFlow,
      categories: operation.categories,
      sourceSnapshot: operation.snapshot,
      buildGuidanceRequest({ categories, draft }) {
        return guidanceRequestForStage(
          stageInput(operation, categories, draft),
          operation
        );
      },
      async generateGuidance(request, { signal }) {
        if (typeof generationRouter?.generate !== 'function') {
          throw Object.assign(new Error('Post-process guidance is unavailable.'), {
            code: 'RECURSION_POST_PROCESS_GUIDANCE_UNAVAILABLE',
            retryable: false
          });
        }
        return generationRouter.generate(
          operation.route.roleId,
          request,
          {
            signal,
            runId: operation.operationId,
            lockRunId: true,
            activityLifecycle: 'nested'
          }
        );
      },
      validateGuidance(result) {
        const data = isObject(result?.data) ? result.data : result;
        const guidanceText = cleanText(data?.guidanceText);
        if (
          result?.ok === false
          || !guidanceText
          || (
            cleanText(data?.snapshotHash)
            && cleanText(data.snapshotHash) !== operation.snapshotHash
          )
          || (
            cleanText(data?.sourceHash)
            && cleanText(data.sourceHash) !== operation.sourceHash
          )
        ) {
          return {
            ok: false,
            error: result?.error || {
              code: 'RECURSION_POST_PROCESS_GUIDANCE_INVALID',
              retryable: true
            }
          };
        }
        return {
          ok: true,
          value: {
            schema: cleanText(data.schema),
            snapshotHash: operation.snapshotHash,
            sourceHash: operation.sourceHash,
            guidanceText
          }
        };
      },
      buildRewriteRequest({ categories, draft, guidance }) {
        const stage = stageInput(operation, categories, draft);
        return {
          draft,
          guidancePacket: buildPostProcessWriterPacket(stage, guidance),
          writerDirective: buildWriterDirective(stage)
        };
      },
      rewrite(request, { signal }) {
        if (typeof host?.generation?.rewriteWithPostProcess !== 'function') {
          throw Object.assign(new Error('Post-process rewrite is unavailable.'), {
            code: 'RECURSION_POST_PROCESS_WRITER_UNAVAILABLE',
            retryable: false
          });
        }
        return host.generation.rewriteWithPostProcess({
          guidancePacket: request.guidancePacket,
          writerDirective: request.writerDirective,
          signal
        });
      },
      async commit({
        commitId,
        text,
        finalArtifactHash,
        signal
      }) {
        let current = false;
        try {
          current = guardAllowsCommit(
            await sourceGuard(operation.snapshot, operation)
          );
        } catch {
          current = false;
        }
        if (!current) {
          return {
            ok: false,
            applied: false,
            error: {
              code: 'RECURSION_POST_PROCESS_SOURCE_STALE'
            }
          };
        }
        const marker = markerForCommit(
          operation,
          text,
          outcomes,
          operation.applyMode,
          false
        );
        const sourceIdentity = {
          chatIdentityHash: operation.snapshot.chatIdentityHash,
          messageId: operation.snapshot.sourceMessageId,
          swipeId: operation.snapshot.sourceSwipeId,
          sourceTextHash: marker.sourceHash,
          activeCharacterHash: operation.snapshot.activeCharacterHash,
          activeGroupHash: operation.snapshot.activeGroupHash
        };
        const input = {
          operationId: operation.operationId,
          commitId,
          sourceMessageId: operation.snapshot.sourceMessageId,
          sourceSwipeId: operation.snapshot.sourceSwipeId,
          sourceHash: operation.sourceHash,
          snapshotHash: operation.snapshotHash,
          sourceIdentity,
          expectedSourceIdentity: sourceIdentity,
          finalArtifactHash,
          text,
          mode: operation.applyMode,
          marker,
          signal
        };
        const result = typeof host?.commitPostProcessResult === 'function'
          ? await host.commitPostProcessResult(input)
          : await commitResult({
              ...input,
              markerNamespace: 'postProcess'
            });
        return {
          ok: result?.ok !== false,
          applied: result?.applied !== false,
          reason: cleanText(result?.reason || (result?.applied === false ? 'already-applied' : 'applied')),
          receipt: cloneValue(result?.receipt || {
            commitId,
            finalArtifactHash
          }),
          ...(result?.error ? { error: cloneValue(result.error) } : {})
        };
      }
    });
  }

  async function durableArtifact(manifest, stageId) {
    const checkpoint = manifest?.stageRecords?.[stageId]?.checkpoint;
    if (!checkpoint) return null;
    return durableRepository.loadPipelineArtifact(
      manifest.chatKey,
      manifest.operationId,
      checkpoint.artifactRef?.artifactId || stageId
    );
  }

  function finalRewriteStageId(operation) {
    if (operation.rewriteFlow !== 'progressive') {
      return 'postprocess.unified.rewrite';
    }
    const last = operation.categories.at(-1);
    return `postprocess.${safeId(last?.id, 'category')}.rewrite`;
  }

  async function finalizeDurableOperation(record, operation, manifest) {
    if (manifest?.state !== 'completed') {
      lastDiagnostics = diagnosticsFor(operation, {
        status: 'paused',
        reason: manifest?.pauseReason || 'paused'
      });
      return {
        ok: false,
        committed: false,
        paused: manifest?.state === 'paused',
        execution: manifest,
        diagnostics: lastDiagnostics
      };
    }
    const [draftArtifact, commitArtifact] = await Promise.all([
      durableArtifact(manifest, finalRewriteStageId(operation)),
      durableArtifact(manifest, 'postprocess.host-commit')
    ]);
    await purgeTerminalResumeArtifacts({
      repository: durableRepository,
      manifest
    });
    const candidate = cleanText(draftArtifact?.text);
    const outcomes = operation.categories.map((category) => {
      const suffix = operation.rewriteFlow === 'progressive'
        ? safeId(category.id, 'category')
        : 'unified';
      return {
        categoryId: safeId(category.id, 'category'),
        status: 'success',
        guidanceAttempts: Number(
          manifest.stageRecords?.[`postprocess.${suffix}.guidance`]?.attempts?.total || 0
        ),
        hostAttempts: Number(
          manifest.stageRecords?.[`postprocess.${suffix}.rewrite`]?.attempts?.total || 0
        )
      };
    });
    lastDiagnostics = diagnosticsFor(operation, {
      outcomes,
      status: 'committed',
      committedApplyMode: operation.applyMode
    });
    settleActivity(record, operation, {
      outcome: 'success',
      label: 'Post-processing complete.',
      detail: {
        partial: false,
        requestedApplyMode: operation.applyMode,
        committedApplyMode: operation.applyMode,
        candidateHash: hashJson(candidate),
        categories: diagnosticCategories(outcomes)
      }
    });
    return {
      ok: true,
      committed: true,
      candidate,
      partial: false,
      requestedApplyMode: operation.applyMode,
      committedApplyMode: operation.applyMode,
      outcomes,
      diagnostics: lastDiagnostics,
      commit: commitArtifact,
      execution: manifest
    };
  }

  async function startDurableOperation(record, operation, currentSettings) {
    const provenance = durableProvenance(operation, currentSettings);
    const graph = durableGraph(operation);
    const queuedIntent = normalizeQueuedReprocess(
      await durableRepository.loadQueuedReprocess?.(operation.snapshot.chatKey, 'postprocess')
    );
    let manifest = createPipelineRun({
      operationId: operation.operationId,
      chatKey: operation.snapshot.chatKey,
      phase: 'postprocess',
      pipelineMode: 'segmented',
      sourceIdentity: provenance.sourceIdentity,
      provenance,
      turnKeyHash: queuedIntent?.turnKeyHash || '',
      sourceBandHash: ''
    });
    if (queuedIntent) {
      const binding = bindQueuedReprocess({
        intent: queuedIntent,
        graph,
        manifest,
        provenance
      });
      manifest = binding.manifest;
      const retainedIntent = binding.intent;
      if (retainedIntent) {
        await durableRepository.saveQueuedReprocess?.(manifest.chatKey, retainedIntent);
      } else {
        await durableRepository.clearQueuedReprocess?.(manifest.chatKey, 'postprocess');
      }
      durableExecution?.onQueuedReprocessChanged?.(retainedIntent || null);
    }
    record.operationId = operation.operationId;
    durableOperations.set(operation.operationId, {
      operation,
      graph,
      provenance,
      record
    });
    durableExecution?.onOperation?.({
      operation,
      graph,
      provenance,
      record
    });
    const settled = await durableScheduler.start({
      manifest,
      graph,
      context: {}
    });
    durableExecution?.onQueuedReprocessChanged?.(
      await durableRepository.loadQueuedReprocess?.(manifest.chatKey, 'postprocess') || null
    );
    return finalizeDurableOperation(record, operation, settled);
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
      if (record.expectedFinalTarget) {
        const expected = record.expectedFinalTarget;
        const matchesVerifiedTarget = capturedSnapshot.chatIdentityHash === expected.chatIdentityHash
          && Number(capturedSnapshot.sourceMessageId) === Number(expected.messageId)
          && Number(capturedSnapshot.sourceSwipeId ?? 0) === Number(expected.swipeId ?? 0)
          && capturedSnapshot.sourceHash === expected.sourceTextHash
          && capturedSnapshot.activeCharacterHash === expected.activeCharacterHash
          && capturedSnapshot.activeGroupHash === expected.activeGroupHash;
        if (!matchesVerifiedTarget) {
          return finishWithoutCommit(null, 'stale-source', [], {}, record);
        }
      } else if (record.consumedTrigger && record.consumedTrigger.requireFinalTargetVerification !== false) {
        return finishWithoutCommit(null, 'final-target-unverified', [], {}, record);
      }
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

      if (durableEnabled) {
        return startDurableOperation(record, operation, currentSettings);
      }

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
      publish('stage', {
        runId: operation.operationId,
        operationId: operation.operationId,
        phase: 'postProcessCommitting',
        mode: 'review',
        severity: 'info',
        label: committedApplyMode === 'replace'
          ? 'Replacing response...'
          : 'Adding Post-process swipe...',
        chips: ['Post-process', committedApplyMode === 'replace' ? 'Replace' : 'As Swipe'],
        detail: {
          partial,
          requestedApplyMode: operation.applyMode,
          committedApplyMode
        }
      });
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
          expectedSourceIdentity: {
            chatIdentityHash: operation.snapshot.chatIdentityHash,
            messageId: operation.snapshot.sourceMessageId,
            swipeId: operation.snapshot.sourceSwipeId,
            sourceTextHash: marker.sourceHash,
            activeCharacterHash: operation.snapshot.activeCharacterHash,
            activeGroupHash: operation.snapshot.activeGroupHash
          },
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

  function runPostProcessForLatestAssistant(options = {}) {
    if (active?.promise) return active.promise;
    if (
      options.hostTriggered === true
      && (
        !pendingTrigger
        || !finalizationClaim
        || cleanText(options.operationToken) !== pendingTrigger.operationToken
        || finalizationClaim.operationToken !== pendingTrigger.operationToken
      )
    ) {
      return Promise.resolve({
        ok: true,
        committed: false,
        skipped: true,
        reason: 'post-process-trigger-canceled'
      });
    }
    const consumedTrigger = pendingTrigger;
    const expectedFinalTarget = finalizationClaim;
    pendingTrigger = null;
    finalizationClaim = null;
    const record = {
      controller: new AbortController(),
      phase: 'pending',
      activityStarted: false,
      activitySettled: false,
      consumedTrigger,
      expectedFinalTarget,
      promise: null
    };
    active = record;
    record.promise = execute(record).finally(() => {
      if (active === record) active = null;
    });
    return record.promise;
  }

  function preparePostProcessTrigger(input = {}) {
    if (settingsStore?.get?.()?.postProcess?.enabled !== true) {
      pendingTrigger = null;
      finalizationClaim = null;
      return { ok: true, pending: false, reason: 'disabled' };
    }
    if (active) return { ok: true, pending: false, reason: 'running' };
    const before = isObject(input.preGenerationSourceIdentity)
      ? {
          chatIdentityHash: cleanText(input.preGenerationSourceIdentity.chatIdentityHash),
          messageId: input.preGenerationSourceIdentity.messageId ?? null,
          swipeId: Number(input.preGenerationSourceIdentity.swipeId ?? 0),
          sourceTextHash: cleanText(
            input.preGenerationSourceIdentity.sourceTextHash
            || input.preGenerationSourceIdentity.originalHash
          ),
          activeCharacterHash: cleanText(input.preGenerationSourceIdentity.activeCharacterHash),
          activeGroupHash: cleanText(input.preGenerationSourceIdentity.activeGroupHash)
        }
      : null;
    pendingTrigger = deepFreeze({
      operationToken: makeId('post-process-trigger'),
      generationType: cleanText(input.generationType || 'normal').toLowerCase(),
      requireFinalTargetVerification: input.requireFinalTargetVerification !== false,
      before
    });
    finalizationClaim = null;
    return { ok: true, pending: true };
  }

  function cancelPostProcess() {
    const canceled = Boolean(pendingTrigger || active);
    pendingTrigger = null;
    finalizationClaim = null;
    if (!active) return { ok: true, canceled };
    if (durableEnabled && active.operationId) {
      void durableScheduler.pause({
        operationId: active.operationId,
        reason: 'post-process-stopped'
      });
      return { ok: true, canceled: true, paused: true };
    }
    active.controller.abort();
    return { ok: true, canceled: true };
  }

  async function waitForPostProcessSettlement() {
    const pendingRun = active?.promise;
    if (!pendingRun) return { ok: true, settled: true, active: false };
    try {
      await pendingRun;
    } catch {
      // Execute normalizes failures, but settlement must remain fail-soft.
    }
    return { ok: true, settled: true, active: Boolean(active) };
  }

  async function postProcessFinalTargetReady(details = {}) {
    const trigger = pendingTrigger;
    if (!trigger) return { ok: true, ready: false, reason: 'post-process-trigger-missing' };
    if (finalizationClaim?.operationToken === trigger.operationToken) {
      return { ok: true, ready: false, reason: 'post-process-finalization-in-progress' };
    }
    if (typeof host?.messages?.postProcessSourceIdentity !== 'function') {
      return { ok: true, ready: false, reason: 'post-process-target-unavailable' };
    }
    let current;
    try {
      current = await host.messages.postProcessSourceIdentity();
    } catch {
      current = null;
    }
    if (pendingTrigger !== trigger) {
      return { ok: true, ready: false, reason: 'post-process-trigger-canceled' };
    }
    if (finalizationClaim) {
      return { ok: true, ready: false, reason: 'post-process-finalization-in-progress' };
    }
    if (!current || !cleanText(current.text) || !cleanText(current.originalHash)) {
      return { ok: true, ready: false, reason: 'post-process-final-target-missing' };
    }
    const eventMessageId = details?.messageId ?? details?.mesid ?? details?.id ?? null;
    if (
      eventMessageId !== null
      && eventMessageId !== undefined
      && String(eventMessageId) !== String(current.messageId)
    ) {
      return { ok: true, ready: false, reason: 'post-process-final-target-mismatch' };
    }
    const before = trigger.before;
    if (before) {
      if (
        cleanText(current.chatIdentityHash) !== before.chatIdentityHash
        || cleanText(current.activeCharacterHash) !== before.activeCharacterHash
        || cleanText(current.activeGroupHash) !== before.activeGroupHash
      ) {
        return { ok: true, ready: false, reason: 'post-process-final-target-context-changed' };
      }
      const messageChanged = Number(current.messageId) !== Number(before.messageId);
      const swipeChanged = Number(current.swipeId ?? 0) !== Number(before.swipeId ?? 0);
      const textChanged = cleanText(current.originalHash) !== before.sourceTextHash;
      const requiresNewMessage = !['swipe', 'regenerate', 'continue'].includes(trigger.generationType);
      if (requiresNewMessage ? !messageChanged : !(messageChanged || swipeChanged || textChanged)) {
        return { ok: true, ready: false, reason: 'post-process-final-target-unchanged' };
      }
    }
    finalizationClaim = deepFreeze({
      operationToken: trigger.operationToken,
      chatIdentityHash: cleanText(current.chatIdentityHash),
      messageId: current.messageId,
      swipeId: Number(current.swipeId ?? 0),
      sourceTextHash: cleanText(current.originalHash),
      activeCharacterHash: cleanText(current.activeCharacterHash),
      activeGroupHash: cleanText(current.activeGroupHash)
    });
    return {
      ok: true,
      ready: true,
      operationToken: trigger.operationToken,
      target: cloneValue(finalizationClaim)
    };
  }

  async function postProcessHostRunReady(operationToken) {
    const trigger = pendingTrigger;
    const expected = finalizationClaim;
    if (settingsStore?.get?.()?.postProcess?.enabled !== true) {
      cancelPostProcess('post-process-disabled');
      return { ok: true, ready: false, reason: 'post-process-disabled' };
    }
    if (
      !trigger
      || !expected
      || cleanText(operationToken) !== trigger.operationToken
      || expected.operationToken !== trigger.operationToken
    ) {
      return { ok: true, ready: false, reason: 'post-process-trigger-canceled' };
    }
    if (typeof host?.messages?.postProcessSourceIdentity !== 'function') {
      return { ok: true, ready: false, reason: 'post-process-target-unavailable' };
    }
    let current;
    try {
      current = await host.messages.postProcessSourceIdentity();
    } catch {
      current = null;
    }
    if (
      pendingTrigger !== trigger
      || finalizationClaim !== expected
      || cleanText(operationToken) !== trigger.operationToken
    ) {
      return { ok: true, ready: false, reason: 'post-process-trigger-canceled' };
    }
    if (
      !current
      || cleanText(current.chatIdentityHash) !== expected.chatIdentityHash
      || Number(current.messageId) !== Number(expected.messageId)
      || Number(current.swipeId ?? 0) !== Number(expected.swipeId ?? 0)
      || cleanText(current.originalHash) !== expected.sourceTextHash
      || cleanText(current.activeCharacterHash) !== expected.activeCharacterHash
      || cleanText(current.activeGroupHash) !== expected.activeGroupHash
    ) {
      return { ok: true, ready: false, reason: 'post-process-final-target-changed' };
    }
    return { ok: true, ready: true, operationToken: trigger.operationToken };
  }

  async function restoreExecutionState(manifest) {
    if (!durableEnabled || manifest?.phase !== 'postprocess') return null;
    const sourceArtifact = await durableArtifact(
      manifest,
      'postprocess.source-snapshot'
    );
    if (!sourceArtifact?.snapshot) return null;
    const currentSettings = cloneValue(settingsStore?.get?.() || {});
    const deck = await deckProvider(currentSettings);
    const basePlan = buildPostProcessPlan({
      settings: currentSettings,
      deck,
      snapshot: sourceArtifact.snapshot
    });
    const operation = {
      ...basePlan,
      operationId: manifest.operationId,
      rewriteFlow: normalizedRewriteFlow(
        sourceArtifact.mode || basePlan.rewriteFlow
      ),
      categories: Array.isArray(sourceArtifact.categories)
        ? cloneValue(sourceArtifact.categories)
        : basePlan.categories
    };
    const graph = durableGraph(operation);
    const provenance = durableProvenance(operation, currentSettings);
    durableOperations.set(operation.operationId, {
      operation,
      graph,
      provenance,
      record: null
    });
    durableExecution?.onOperation?.({
      operation,
      graph,
      provenance,
      record: null
    });
    return {
      operation,
      graph,
      provenance
    };
  }

  async function resumeOperation({ operationId } = {}) {
    const id = cleanText(operationId);
    const restored = durableOperations.get(id);
    if (!durableEnabled || !restored) {
      throw new Error('Post-process operation context is unavailable for Resume.');
    }
    const record = restored.record || {
      controller: new AbortController(),
      phase: 'pending',
      activityStarted: false,
      activitySettled: false,
      operationId: id,
      promise: null
    };
    restored.record = record;
    startActivity(record, restored.operation);
    const manifest = await durableScheduler.resume({
      operationId: id,
      graph: restored.graph,
      context: {},
      provenance: restored.provenance
    });
    return finalizeDurableOperation(record, restored.operation, manifest);
  }

  async function retryStage({ operationId, stageId } = {}) {
    const id = cleanText(operationId);
    const restored = durableOperations.get(id);
    if (!durableEnabled || !restored) {
      throw new Error('Post-process operation context is unavailable for Retry.');
    }
    const record = restored.record || {
      controller: new AbortController(),
      phase: 'pending',
      activityStarted: false,
      activitySettled: false,
      operationId: id,
      promise: null
    };
    restored.record = record;
    startActivity(record, restored.operation);
    const manifest = await durableScheduler.retry({
      operationId: id,
      stageId,
      graph: restored.graph,
      context: {},
      provenance: restored.provenance
    });
    return finalizeDurableOperation(record, restored.operation, manifest);
  }

  return {
    postProcessPending() {
      return Boolean(pendingTrigger);
    },
    preparePostProcessTrigger,
    postProcessRunning() {
      return Boolean(active);
    },
    runPostProcessForLatestAssistant,
    cancelPostProcess,
    waitForPostProcessSettlement,
    postProcessFinalTargetReady,
    postProcessHostRunReady,
    restoreExecutionState,
    resumeOperation,
    retryStage,
    executionGraph(operationId) {
      return durableOperations.get(cleanText(operationId))?.graph || null;
    },
    postProcessDiagnostics() {
      return cloneValue(lastDiagnostics);
    }
  };
}
