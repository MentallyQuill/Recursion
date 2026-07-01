import { createActivityReporter } from './activity.mjs';
import { CARD_CATALOG, applyCardPlan, buildCardRequests, cardsFromProviderResult, normalizeCard, selectHand } from './cards.mjs';
import { compact, hashJson, makeId, nowIso, redact, truncate } from './core.mjs';
import { composePromptPacket } from './prompt.mjs';
import { createSettingsStore } from './settings.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from './storage.mjs';

const UTILITY_ARBITER_SCHEMA = 'recursion.utilityArbiter.v1';
const DEFAULT_CHAT_ID = 'chat';
const DEFAULT_SCENE_KEY = 'scene';
const INSTALL_FAILURE_LABEL = 'Prompt install failed. Generation will continue without Recursion.';
const CLEAR_FAILURE_LABEL = 'Prompt clear failed. Recursion skipped without clearing host prompt.';
const SECRET_TEXT_PATTERN = /(private[-_\s]*secret|\bsk-[a-z0-9_-]+|\bbearer\s+[a-z0-9._-]+)/ig;
const PROVIDER_VISIBLE_MESSAGE_LIMIT = 12;
const PROVIDER_MESSAGE_TEXT_LIMIT = 900;
const PLAN_ACTIONS = new Set(['skip', 'reuse-cache', 'refresh-cards', 'compose-brief']);
const REASONER_DECISION_MODES = new Set(['use', 'skip']);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function safeText(value, limit = 700) {
  return truncate(compact(String(redact(value, { maxString: limit }) ?? '').replace(SECRET_TEXT_PATTERN, '[redacted]'), limit), limit);
}

function hasSecretText(value) {
  SECRET_TEXT_PATTERN.lastIndex = 0;
  return SECRET_TEXT_PATTERN.test(String(value ?? ''));
}

function safeIdentifier(value, fallback = '', limit = 180) {
  return cleanString(safeText(value, limit), fallback);
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeMessage(message, index) {
  const source = asObject(message);
  const mesid = numberOr(source.mesid ?? source.id ?? source.messageId, index);
  const role = cleanString(
    source.role ?? (source.is_user === true ? 'user' : (source.is_system === true ? 'system' : 'assistant')),
    'assistant'
  );
  return {
    mesid,
    role,
    text: safeText(source.text ?? source.mes ?? source.content ?? '', 1200),
    visible: source.visible === false || source.hidden === true ? false : true
  };
}

function normalizeSnapshot(rawSnapshot = {}) {
  const source = asObject(rawSnapshot);
  const messages = Array.isArray(source.messages)
    ? source.messages.map((message, index) => normalizeMessage(message, index))
    : [];
  const latestMessage = messages.at(-1);
  const latestMesId = numberOr(source.latestMesId ?? latestMessage?.mesid, 0);
  const chatId = safeIdentifier(source.chatId ?? source.chatKey, DEFAULT_CHAT_ID);
  const chatKey = safeIdentifier(source.chatKey ?? source.chatId, chatId);
  const sceneFingerprint = safeIdentifier(source.sceneFingerprint, hashJson(messages));
  return {
    chatId,
    chatKey,
    sceneKey: safeIdentifier(source.sceneKey ?? source.sceneFingerprint, DEFAULT_SCENE_KEY),
    sceneFingerprint,
    turnFingerprint: safeIdentifier(
      source.turnFingerprint,
      hashJson({ latestMesId, messages: messages.slice(-3) })
    ),
    latestMesId,
    messages
  };
}

function safeProviderRole(value) {
  const role = cleanString(value, 'assistant').toLowerCase();
  return ['assistant', 'system', 'user'].includes(role) ? role : 'assistant';
}

function providerSafeMessage(message) {
  const source = asObject(message);
  if (source.visible === false) return null;
  const text = safeText(source.text ?? '', PROVIDER_MESSAGE_TEXT_LIMIT);
  if (!text) return null;
  return {
    mesid: numberOr(source.mesid, 0),
    role: safeProviderRole(source.role),
    text
  };
}

function providerSafeSnapshot(snapshot = {}) {
  const source = asObject(snapshot);
  const messages = Array.isArray(source.messages)
    ? source.messages.map(providerSafeMessage).filter(Boolean).slice(-PROVIDER_VISIBLE_MESSAGE_LIMIT)
    : [];
  return {
    sceneKey: safeText(source.sceneKey || DEFAULT_SCENE_KEY, 120) || DEFAULT_SCENE_KEY,
    sceneFingerprint: safeText(source.sceneFingerprint || '', 180),
    turnFingerprint: safeText(source.turnFingerprint || '', 180),
    latestMesId: numberOr(source.latestMesId, 0),
    messages
  };
}

function viewSnapshot(snapshot) {
  if (!snapshot) return null;
  const source = asObject(snapshot);
  const messages = Array.isArray(source.messages)
    ? source.messages.map(providerSafeMessage).filter(Boolean).map((message) => ({ ...message, visible: true }))
    : [];
  return {
    chatId: safeText(source.chatId || DEFAULT_CHAT_ID, 160) || DEFAULT_CHAT_ID,
    chatKey: safeText(source.chatKey || source.chatId || DEFAULT_CHAT_ID, 160) || DEFAULT_CHAT_ID,
    sceneKey: safeText(source.sceneKey || DEFAULT_SCENE_KEY, 160) || DEFAULT_SCENE_KEY,
    sceneFingerprint: safeText(source.sceneFingerprint || '', 180),
    turnFingerprint: safeText(source.turnFingerprint || '', 180),
    latestMesId: numberOr(source.latestMesId, 0),
    messages
  };
}

function latestVisibleMessage(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  return messages
    .slice()
    .reverse()
    .find((message) => message?.visible !== false && String(message?.text ?? '').trim());
}

function latestVisibleUserMessage(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  return messages
    .slice()
    .reverse()
    .find((message) => message?.visible !== false && message?.role === 'user' && String(message?.text ?? '').trim());
}

function localFallbackPlan(snapshot, settings) {
  const snapshotHash = hashJson(snapshot);
  return {
    schema: UTILITY_ARBITER_SCHEMA,
    snapshotHash,
    action: 'compose-brief',
    sceneStatus: 'same-scene',
    cardJobs: [],
    reasonerDecision: {
      mode: settings.reasonerUse === 'always' ? 'use' : 'skip',
      reason: 'local fallback',
      signals: []
    },
    budgets: {
      targetBriefTokens: settings.promptFootprint === 'rich' ? 900 : 500,
      maxCards: 6
    },
    diagnostics: ['local-fallback-plan'],
    source: { snapshotHash }
  };
}

function normalizeBudget(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.round(number));
}

function mergeDiagnostics(...groups) {
  return [...new Set(groups.flatMap((group) => Array.isArray(group)
    ? group.map((entry) => safeText(entry, 180)).filter(Boolean)
    : []))];
}

function safeStringList(value, limit = 120) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry) => ['string', 'number', 'boolean'].includes(typeof entry))
    .map((entry) => safeText(entry, limit))
    .filter(Boolean))];
}

function normalizePlanAction(value, fallback) {
  const action = cleanString(value, fallback);
  return PLAN_ACTIONS.has(action) ? action : fallback;
}

function normalizeReasonerDecision(fallbackDecision, value) {
  const source = asObject(value);
  const fallback = asObject(fallbackDecision);
  const mode = cleanString(source.mode, fallback.mode || 'skip');
  return {
    mode: REASONER_DECISION_MODES.has(mode) ? mode : (fallback.mode || 'skip'),
    reason: safeText(source.reason ?? fallback.reason ?? '', 240),
    signals: safeStringList(source.signals ?? fallback.signals, 120)
  };
}

function normalizePlanCardJobs(value) {
  if (!Array.isArray(value)) return null;
  return value.map((job) => {
    const source = asObject(job);
    const output = {};
    const family = safeText(source.family, 120);
    const role = safeText(source.role, 120);
    const roleId = safeText(source.roleId, 120);
    const reason = safeText(source.reason, 240);
    if (family) output.family = family;
    if (role) output.role = role;
    if (roleId) output.roleId = roleId;
    if (reason) output.reason = reason;
    return output;
  }).filter((job) => job.family || job.role || job.roleId);
}

function mergeSource(fallbackSource) {
  const source = asObject(fallbackSource);
  return {
    snapshotHash: safeText(source.snapshotHash || '', 180),
    ...(source.userMessageHash ? { userMessageHash: safeText(source.userMessageHash, 180) } : {}),
    ...(source.catalogHash ? { catalogHash: safeText(source.catalogHash, 180) } : {})
  };
}

function mergePlan(fallbackPlan, arbiterData) {
  const data = asObject(arbiterData);
  const budgets = {
    targetBriefTokens: normalizeBudget(
      asObject(data.budgets).targetBriefTokens,
      fallbackPlan.budgets.targetBriefTokens
    ),
    maxCards: normalizeBudget(
      asObject(data.budgets).maxCards,
      fallbackPlan.budgets.maxCards
    )
  };
  return {
    schema: safeText(data.schema || fallbackPlan.schema || UTILITY_ARBITER_SCHEMA, 120) || UTILITY_ARBITER_SCHEMA,
    snapshotHash: fallbackPlan.snapshotHash,
    action: normalizePlanAction(data.action, fallbackPlan.action),
    sceneStatus: safeText(data.sceneStatus || fallbackPlan.sceneStatus, 80) || fallbackPlan.sceneStatus,
    cardJobs: normalizePlanCardJobs(data.cardJobs) ?? fallbackPlan.cardJobs,
    reasonerDecision: normalizeReasonerDecision(fallbackPlan.reasonerDecision, data.reasonerDecision),
    budgets,
    diagnostics: mergeDiagnostics(fallbackPlan.diagnostics, data.diagnostics),
    source: {
      ...mergeSource(fallbackPlan.source),
      snapshotHash: fallbackPlan.source?.snapshotHash || fallbackPlan.snapshotHash
    }
  };
}

function markArbiterFallback(plan, reason) {
  return {
    ...plan,
    diagnostics: mergeDiagnostics(plan.diagnostics, ['utility-arbiter-fallback']),
    utilityArbiterFallbackReason: safeText(reason || 'utility arbiter unavailable', 240)
  };
}

function planAction(plan) {
  const action = cleanString(plan?.action, 'compose-brief');
  return PLAN_ACTIONS.has(action) ? action : 'compose-brief';
}

function settingsForPlan(settings, plan) {
  if (settings.reasonerUse === 'auto' && plan?.reasonerDecision?.mode === 'skip') {
    return { ...settings, reasonerUse: 'off' };
  }
  if (settings.reasonerUse !== 'off' && plan?.reasonerDecision?.mode === 'use') {
    return { ...settings, reasonerUse: 'always' };
  }
  return settings;
}

function budgetOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function arbiterSafeSettings(settings) {
  const source = asObject(settings);
  return {
    mode: safeText(source.mode || 'auto', 40),
    strength: safeText(source.strength || 'balanced', 40),
    promptFootprint: safeText(source.promptFootprint || 'normal', 40),
    focus: safeText(source.focus || 'balanced', 80),
    reasonerUse: safeText(source.reasonerUse || 'auto', 40),
    providers: {
      utility: {
        enabled: source.providers?.utility?.enabled === true,
        source: safeText(source.providers?.utility?.source || '', 80)
      },
      reasoner: {
        enabled: source.providers?.reasoner?.enabled === true,
        source: safeText(source.providers?.reasoner?.source || '', 80)
      }
    }
  };
}

function safeProviderLastTest(value) {
  const source = asObject(value);
  const output = {
    status: safeText(source.status || 'not-run', 40) || 'not-run'
  };
  const checkedAt = safeText(source.checkedAt || '', 80);
  const compactError = safeText(source.compactError || '', 300);
  if (checkedAt) output.checkedAt = checkedAt;
  if (compactError) output.compactError = compactError;
  return output;
}

function safeProviderSettingsView(provider) {
  const source = asObject(provider);
  return {
    lane: safeText(source.lane || '', 40),
    enabled: source.enabled === true,
    source: safeText(source.source || '', 80),
    hostConnectionProfileId: safeText(source.hostConnectionProfileId || '', 160),
    openAICompatible: {
      baseUrl: safeText(source.openAICompatible?.baseUrl || '', 300),
      model: safeText(source.openAICompatible?.model || '', 160),
      sessionApiKeyPresent: source.openAICompatible?.sessionApiKeyPresent === true
    },
    temperature: numberOr(source.temperature, 0),
    topP: numberOr(source.topP, 0),
    maxTokens: numberOr(source.maxTokens, 0),
    resolvedProviderLabel: safeText(source.resolvedProviderLabel || '', 120),
    resolvedModelLabel: safeText(source.resolvedModelLabel || '', 120),
    lastTest: safeProviderLastTest(source.lastTest)
  };
}

function safeSettingsView(settings) {
  const source = asObject(settings);
  return {
    mode: safeText(source.mode || 'observe', 40),
    strength: safeText(source.strength || 'balanced', 40),
    promptFootprint: safeText(source.promptFootprint || 'normal', 40),
    focus: safeText(source.focus || 'balanced', 80),
    reasonerUse: safeText(source.reasonerUse || 'auto', 40),
    diagnostics: {
      maxJournalEntries: numberOr(source.diagnostics?.maxJournalEntries, 100),
      includeExcerpts: source.diagnostics?.includeExcerpts === true
    },
    providers: {
      utility: safeProviderSettingsView(source.providers?.utility),
      reasoner: safeProviderSettingsView(source.providers?.reasoner)
    },
    ui: {
      viewerOpen: source.ui?.viewerOpen === true
    }
  };
}

function runtimeError(error) {
  const wrapped = new Error(safeText(error?.message || error || 'Runtime failed.', 240));
  wrapped.code = safeText(error?.code || 'RECURSION_RUNTIME_FAILED', 120) || 'RECURSION_RUNTIME_FAILED';
  return wrapped;
}

function localCards(snapshot) {
  const snapshotHash = hashJson(snapshot);
  const latest = latestVisibleMessage(snapshot);
  const latestUser = latestVisibleUserMessage(snapshot);
  const latestText = safeText(latest?.text || '', 700);
  const latestUserText = safeText(latestUser?.text || '', 700);
  const evidenceMesId = latest?.mesid ?? snapshot.latestMesId ?? 0;
  const userEvidenceMesId = latestUser?.mesid ?? evidenceMesId;
  const context = {
    sceneId: snapshot.sceneKey,
    chatId: snapshot.chatId,
    snapshotHash,
    lastMesId: snapshot.latestMesId
  };

  const scene = normalizeCard({
    family: 'Scene Frame',
    promptText: `Current scene context: ${latestText || 'continue the visible scene without broad recap.'}`,
    evidenceRefs: [`message:${evidenceMesId}`],
    emphasis: 'normal'
  }, context);
  const continuity = normalizeCard({
    family: 'Continuity Risk',
    promptText: latestUserText
      ? `Keep the next response consistent with the latest visible user action: ${latestUserText}`
      : 'Keep the next response consistent with the latest visible user action and current scene state.',
    evidenceRefs: [`message:${userEvidenceMesId}`],
    emphasis: 'emphasized'
  }, context);
  return [scene, continuity];
}

function sanitizeGeneratedCard(card) {
  const rawId = String(card?.id ?? '').trim();
  const safeId = rawId && !hasSecretText(rawId) ? safeText(rawId, 160) : undefined;
  const sanitized = {
    ...card,
    id: safeId || undefined,
    promptText: safeText(card?.promptText || '', 1000),
    summary: safeText(card?.summary || card?.promptText || '', 400),
    evidenceRefs: Array.isArray(card?.evidenceRefs)
      ? card.evidenceRefs.map((entry) => safeText(entry, 120)).filter(Boolean).slice(0, 12)
      : [],
    arbiter: {
      ...asObject(card?.arbiter),
      reason: safeText(card?.arbiter?.reason || '', 240)
    }
  };
  if (card?.inspectorNotes) sanitized.inspectorNotes = safeText(card.inspectorNotes, 800);
  return sanitized;
}

function safeActivity(activity, method, input, fallback = null) {
  try {
    const fn = activity?.[method];
    if (typeof fn !== 'function') return fallback;
    const result = fn.call(activity, input);
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return result ?? fallback;
  } catch {
    return fallback;
  }
}

function safeCurrentActivity(activity) {
  try {
    if (typeof activity?.current === 'function') return activity.current();
  } catch {
    return null;
  }
  return null;
}

function sanitizePromptError(error, fallbackCode, fallbackMessage) {
  const source = asObject(error);
  return {
    code: safeText(source.code || fallbackCode, 120) || fallbackCode,
    message: safeText(source.message || error?.message || error || fallbackMessage, 240) || fallbackMessage
  };
}

function sanitizePromptOutcome(value, { fallbackCode, fallbackMessage } = {}) {
  const source = asObject(value);
  const ok = source.ok !== false;
  const output = { ok };
  if (source.skipped !== undefined) output.skipped = Boolean(source.skipped);
  if (source.cleared !== undefined) output.cleared = Boolean(source.cleared);
  if (Array.isArray(source.installed)) {
    output.installed = source.installed.map((entry) => safeText(entry, 120)).filter(Boolean).slice(0, 16);
  } else if (source.installed === true) {
    output.installed = true;
  }
  if (!ok) {
    output.error = sanitizePromptError(source.error, fallbackCode, fallbackMessage);
  }
  return output;
}

async function installPrompt(host, packet) {
  const install = host?.prompt?.install;
  if (typeof install !== 'function') {
    return sanitizePromptOutcome({
      ok: false,
      error: {
        code: 'RECURSION_PROMPT_INSTALL_UNAVAILABLE',
        message: 'Host prompt install is unavailable.'
      }
    }, {
      fallbackCode: 'RECURSION_PROMPT_INSTALL_UNAVAILABLE',
      fallbackMessage: 'Host prompt install is unavailable.'
    });
  }
  try {
    const result = await install.call(host.prompt, packet);
    if (result && typeof result === 'object') {
      return sanitizePromptOutcome(result, {
        fallbackCode: 'RECURSION_PROMPT_INSTALL_FAILED',
        fallbackMessage: 'Prompt install failed.'
      });
    }
    return sanitizePromptOutcome({ ok: true }, {
      fallbackCode: 'RECURSION_PROMPT_INSTALL_FAILED',
      fallbackMessage: 'Prompt install failed.'
    });
  } catch (error) {
    return sanitizePromptOutcome({
      ok: false,
      error: {
        code: error?.code ? String(error.code) : 'RECURSION_PROMPT_INSTALL_FAILED',
        message: String(error?.message || error || 'Prompt install failed.')
      }
    }, {
      fallbackCode: 'RECURSION_PROMPT_INSTALL_FAILED',
      fallbackMessage: 'Prompt install failed.'
    });
  }
}

function installSummary(install) {
  if (install?.ok !== false) return 'Prompt installed';
  return safeText(install.error?.message || install.error?.code || 'Prompt install failed', 300);
}

function installJournalDetails(install) {
  if (install?.ok !== false) {
    return {
      status: 'installed',
      installedCount: Array.isArray(install?.installed) ? install.installed.length : undefined
    };
  }
  return {
    status: 'failed',
    code: safeText(install?.error?.code || 'RECURSION_PROMPT_INSTALL_FAILED', 120),
    message: safeText(install?.error?.message || 'Prompt install failed.', 240)
  };
}

async function clearPromptBestEffort(host) {
  const clear = host?.prompt?.clear;
  if (typeof clear !== 'function') {
    return sanitizePromptOutcome({
      ok: false,
      error: {
        code: 'RECURSION_PROMPT_CLEAR_UNAVAILABLE',
        message: 'Host prompt clear is unavailable.'
      }
    }, {
      fallbackCode: 'RECURSION_PROMPT_CLEAR_UNAVAILABLE',
      fallbackMessage: 'Host prompt clear is unavailable.'
    });
  }
  try {
    const result = await clear.call(host.prompt);
    return sanitizePromptOutcome(result && typeof result === 'object' ? result : { ok: true }, {
      fallbackCode: 'RECURSION_PROMPT_CLEAR_FAILED',
      fallbackMessage: 'Prompt clear failed.'
    });
  } catch (error) {
    return sanitizePromptOutcome({
      ok: false,
      error: {
        code: error?.code ? String(error.code) : 'RECURSION_PROMPT_CLEAR_FAILED',
        message: safeText(error?.message || error || 'Prompt clear failed.', 240)
      }
    }, {
      fallbackCode: 'RECURSION_PROMPT_CLEAR_FAILED',
      fallbackMessage: 'Prompt clear failed.'
    });
  }
}

function clearWarningDetails(clear) {
  return {
    code: safeText(clear?.error?.code || 'RECURSION_PROMPT_CLEAR_FAILED', 120),
    message: safeText(clear?.error?.message || 'Prompt clear failed.', 240)
  };
}

function signalAwareGenerationRouter(router, signal, runId) {
  if (!router || !signal) return router;
  return {
    ...router,
    generate(roleId, request = {}, options = {}) {
      const nextRequest = { ...asObject(request), signal };
      const nextOptions = { ...asObject(options), runId: options.runId ?? runId, signal: options.signal ?? signal };
      return router.generate(roleId, nextRequest, nextOptions);
    },
    batch(requests = [], options = {}) {
      if (typeof router.batch !== 'function') return undefined;
      const nextRequests = Array.isArray(requests)
        ? requests.map((request) => ({ ...asObject(request), signal: request?.signal ?? signal }))
        : requests;
      const nextOptions = { ...asObject(options), runId: options.runId ?? runId, signal: options.signal ?? signal };
      return router.batch(nextRequests, nextOptions);
    }
  };
}

export function createRecursionRuntime({
  host = {},
  settingsStore = createSettingsStore({ root: {} }),
  storage = createStorageRepository({ storage: createMemoryStorageAdapter() }),
  activity = createActivityReporter(),
  generationRouter = null
} = {}) {
  let activeRunId = null;
  let activeRunController = null;
  let lastPacket = null;
  let lastHand = { cards: [], omitted: [] };
  let lastPlan = null;
  let lastSnapshot = null;
  let promptInstallTail = Promise.resolve();
  let storageSaveTail = Promise.resolve();

  async function readSnapshot() {
    if (typeof host?.snapshot !== 'function') {
      throw new Error('Recursion runtime requires host.snapshot().');
    }
    return normalizeSnapshot(await host.snapshot());
  }

  function isActiveRun(runId) {
    return activeRunId === runId;
  }

  function abortActiveRun() {
    try {
      activeRunController?.abort?.();
    } catch {
      // Abort notification is best-effort; supersession guards still prevent stale writes.
    }
  }

  function startRun(runId) {
    abortActiveRun();
    activeRunController = typeof AbortController === 'function' ? new AbortController() : null;
    activeRunId = runId;
    return activeRunController?.signal ?? null;
  }

  function clearActiveRun(runId = null) {
    if (runId && activeRunId !== runId) return;
    activeRunId = null;
    activeRunController = null;
  }

  function supersededResult(runId) {
    return { ok: false, superseded: true, runId };
  }

  function startRuntimeActivity(event) {
    return safeActivity(activity, 'start', event);
  }

  function stageRuntimeActivity(event) {
    const result = safeActivity(activity, 'stage', event);
    if (event?.runId && event?.phase && result?.phase !== event.phase) {
      return safeActivity(activity, 'start', event);
    }
    return result;
  }

  function settleRuntimeActivity(event) {
    const result = safeActivity(activity, 'settle', event);
    if (event?.runId && event?.label && result?.label !== event.label) {
      safeActivity(activity, 'start', event);
      return safeActivity(activity, 'settle', event);
    }
    return result;
  }

  function providerLane(value) {
    return cleanString(value).toLowerCase() === 'reasoner' ? 'reasoner' : 'utility';
  }

  function updateSettings(patch = {}) {
    return settingsStore.update(patch);
  }

  function updateProvider(lane, patch = {}) {
    return settingsStore.updateProvider(providerLane(lane), patch);
  }

  function clearProviderKey(lane) {
    return settingsStore.clearApiKey(providerLane(lane));
  }

  function providerTestPrompt(lane) {
    return [
      'Return strict JSON for a Recursion provider connectivity test.',
      'Do not include prose outside JSON.',
      `Lane: ${lane}.`,
      '{"schema":"recursion.providerTest.v1","ok":true}'
    ].join('\n');
  }

  function providerTestFailure(lane, checkedAt, error) {
    const compactError = safeText(error?.message || error?.code || error || 'Provider test failed.', 300);
    return settingsStore.updateProvider(lane, {
      lastTest: {
        status: 'fail',
        checkedAt,
        compactError
      }
    });
  }

  async function testProvider(lane = 'utility') {
    const resolvedLane = providerLane(lane);
    const checkedAt = nowIso();
    const runId = makeId(`provider-test-${resolvedLane}`);
    startRuntimeActivity({
      runId,
      phase: 'providerCallStarted',
      mode: 'review',
      severity: 'info',
      providerLane: resolvedLane,
      label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test started.`,
      chips: [resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility', 'Provider']
    });

    if (!generationRouter || typeof generationRouter.generate !== 'function') {
      const provider = providerTestFailure(resolvedLane, checkedAt, {
        code: 'RECURSION_PROVIDER_ROUTER_UNAVAILABLE',
        message: 'Provider test is unavailable because the generation router is not configured.'
      });
      settleRuntimeActivity({
        runId,
        outcome: 'warning',
        phase: 'providerTestFailed',
        severity: 'warning',
        providerLane: resolvedLane,
        label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test failed.`,
        chips: ['Provider'],
        detail: provider.lastTest
      });
      return {
        ok: false,
        error: {
          code: 'RECURSION_PROVIDER_ROUTER_UNAVAILABLE',
          message: 'Provider test is unavailable.'
        }
      };
    }

    try {
      stageRuntimeActivity({
        runId,
        phase: 'providerCallRunning',
        mode: 'review',
        severity: 'info',
        providerLane: resolvedLane,
        label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test running.`,
        chips: ['Provider']
      });
      const result = await generationRouter.generate('providerTest', {
        runId,
        lane: resolvedLane,
        prompt: providerTestPrompt(resolvedLane)
      });
      if (result?.ok) {
        const provider = settingsStore.updateProvider(resolvedLane, {
          resolvedProviderLabel: safeText(result.diagnostics?.providerId || result.providerId || '', 120),
          resolvedModelLabel: safeText(result.diagnostics?.model || result.model || '', 120),
          lastTest: {
            status: 'pass',
            checkedAt
          }
        });
        settleRuntimeActivity({
          runId,
          outcome: 'success',
          phase: 'settled',
          severity: 'success',
          providerLane: resolvedLane,
          label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test passed.`,
          chips: ['Provider'],
          detail: {
            provider: provider.resolvedProviderLabel,
            model: provider.resolvedModelLabel
          }
        });
        return result;
      }

      const provider = providerTestFailure(resolvedLane, checkedAt, result?.error || 'Provider test failed.');
      settleRuntimeActivity({
        runId,
        outcome: 'warning',
        phase: 'providerTestFailed',
        severity: 'warning',
        providerLane: resolvedLane,
        label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test failed.`,
        chips: ['Provider'],
        detail: provider.lastTest
      });
      return result || { ok: false, error: { code: 'RECURSION_PROVIDER_TEST_FAILED', message: 'Provider test failed.' } };
    } catch (error) {
      const provider = providerTestFailure(resolvedLane, checkedAt, error);
      settleRuntimeActivity({
        runId,
        outcome: 'warning',
        phase: 'providerTestFailed',
        severity: 'warning',
        providerLane: resolvedLane,
        label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test failed.`,
        chips: ['Provider'],
        detail: provider.lastTest
      });
      return {
        ok: false,
        error: {
          code: safeText(error?.code || 'RECURSION_PROVIDER_TEST_FAILED', 120),
          message: safeText(error?.message || 'Provider test failed.', 300)
        }
      };
    }
  }

  async function waitForExternalMutations() {
    try {
      await Promise.all([promptInstallTail, storageSaveTail]);
    } catch {
      // Mutation failures are normalized at their source; tails are only sequencing gates.
    }
  }

  async function runPromptMutationSection(runId, mutationWork) {
    const previous = promptInstallTail.catch(() => {});
    const current = previous.then(async () => {
      if (runId && !isActiveRun(runId)) return supersededResult(runId);
      return mutationWork();
    });
    promptInstallTail = current.catch(() => {});
    return current;
  }

  async function runStorageSaveSection(runId, saveWork) {
    const previous = storageSaveTail.catch(() => {});
    const current = previous.then(async () => {
      if (!isActiveRun(runId)) return supersededResult(runId);
      return saveWork();
    });
    storageSaveTail = current.catch(() => {});
    return current;
  }

  function reportStorageWarning(runId, operation, error) {
    if (!isActiveRun(runId)) return;
    stageRuntimeActivity({
      runId,
      phase: 'storageWarning',
      severity: 'warning',
      label: 'Recursion storage warning; continuing in memory.',
      chips: ['Storage'],
      detail: {
        operation,
        message: safeText(error?.message || error || 'Storage operation failed.', 240)
      }
    });
  }

  async function loadSceneCacheSafe(runId, snapshot) {
    try {
      return await storage.loadSceneCache(snapshot.chatKey, snapshot.sceneKey);
    } catch (error) {
      reportStorageWarning(runId, 'loadSceneCache', error);
      return null;
    }
  }

  async function saveSceneCacheSafe(runId, snapshot, value) {
    try {
      return await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, value);
    } catch (error) {
      reportStorageWarning(runId, 'saveSceneCache', error);
      return null;
    }
  }

  async function appendJournalSafe(runId, chatKey, entry) {
    try {
      return await storage.appendJournal(chatKey, entry);
    } catch (error) {
      reportStorageWarning(runId, 'appendJournal', error);
      return null;
    }
  }

  function sanitizedCacheCards(runId, snapshot, cards) {
    const accepted = [];
    let rejected = 0;
    for (const card of Array.isArray(cards) ? cards : []) {
      const sanitized = sanitizeGeneratedCard(card);
      try {
        normalizeCard(sanitized, {
          sceneId: snapshot.sceneKey,
          chatId: snapshot.chatId,
          snapshotHash: hashJson(snapshot),
          lastMesId: snapshot.latestMesId
        });
        accepted.push(sanitized);
      } catch {
        rejected += 1;
      }
    }
    if (rejected) {
      stageRuntimeActivity({
        runId,
        phase: 'cacheWarning',
        severity: 'warning',
        label: 'Ignored invalid cached Recursion cards.',
        chips: ['Cache'],
        cardCounts: { omitted: rejected }
      });
    }
    return accepted;
  }

  function reportClearWarning(runId, clear) {
    settleRuntimeActivity({
      runId,
      outcome: 'warning',
      phase: 'promptClearFailed',
      label: CLEAR_FAILURE_LABEL,
      chips: ['Prompt'],
      detail: clearWarningDetails(clear)
    });
  }

  async function askUtilityArbiter({ runId, snapshot, settings, fallbackPlan, signal }) {
    if (!generationRouter || typeof generationRouter.generate !== 'function') return fallbackPlan;
    stageRuntimeActivity({
      runId,
      phase: 'arbiterPlanning',
      label: 'Planning card pass...',
      providerLane: 'utility',
      chips: ['Utility']
    });
    try {
      const result = await generationRouter.generate('utilityArbiter', {
        runId,
        signal,
        prompt: [
          'Return a Recursion Utility Arbiter plan as strict JSON.',
          `Schema: ${UTILITY_ARBITER_SCHEMA}`,
          `Settings: ${JSON.stringify(arbiterSafeSettings(settings))}`,
          `Catalog: ${JSON.stringify(CARD_CATALOG)}`,
          `Snapshot: ${JSON.stringify(providerSafeSnapshot(snapshot))}`
        ].join('\n\n')
      }, { runId, signal });
      if (result?.ok) return mergePlan(fallbackPlan, result.data);
      return markArbiterFallback(fallbackPlan, result?.error?.message || result?.error?.code || 'utility arbiter returned non-ok result');
    } catch (error) {
      return markArbiterFallback(fallbackPlan, error?.message || error);
    }
  }

  async function generatePlanCards({ runId, plan, snapshot, signal }) {
    if (!generationRouter || typeof generationRouter.batch !== 'function') return [];
    const requests = buildCardRequests(plan, {
      runId,
      snapshotHash: plan.snapshotHash || hashJson(snapshot),
      snapshot: providerSafeSnapshot(snapshot)
    });
    if (!requests.length) return [];
    stageRuntimeActivity({
      runId,
      phase: 'cardBatchRunning',
      label: 'Generating scene cards...',
      cardCounts: { requested: requests.length },
      providerLane: 'utility',
      chips: ['Cards', String(requests.length)]
    });
    try {
      const signalRequests = signal
        ? requests.map((request) => ({ ...request, signal }))
        : requests;
      const results = await generationRouter.batch(signalRequests, { runId, signal });
      return results.flatMap((result) => cardsFromProviderResult(result, {
        sceneId: snapshot.sceneKey,
        chatId: snapshot.chatId,
        snapshotHash: plan.snapshotHash || hashJson(snapshot),
        lastMesId: snapshot.latestMesId
      }));
    } catch {
      return [];
    }
  }

  async function prepareForGeneration({ userMessage = '' } = {}) {
    const settings = settingsStore.get();
    if (settings.mode === 'off') {
      await waitForExternalMutations();
      abortActiveRun();
      clearActiveRun();
      const clearRunId = makeId('run');
      startRuntimeActivity({
        runId: clearRunId,
        phase: 'promptClearing',
        label: 'Clearing Recursion prompt...',
        chips: ['Prompt']
      });
      const clear = await runPromptMutationSection(null, () => clearPromptBestEffort(host));
      if (clear?.ok === false) reportClearWarning(clearRunId, clear);
      else safeActivity(activity, 'clear');
      return { ok: true, skipped: true, reason: 'off', clear };
    }

    await waitForExternalMutations();
    const runId = makeId('run');
    const signal = startRun(runId);
    startRuntimeActivity({ runId, label: 'Reading current turn...', chips: ['Auto'] });
    try {
      const snapshot = await readSnapshot();
      if (!isActiveRun(runId)) return supersededResult(runId);
      lastSnapshot = snapshot;
      const fallbackPlan = localFallbackPlan(snapshot, settings);
      fallbackPlan.source = {
        ...fallbackPlan.source,
        userMessageHash: hashJson(userMessage),
        catalogHash: hashJson(CARD_CATALOG)
      };
      const plan = await askUtilityArbiter({ runId, snapshot, settings, fallbackPlan, signal });
      if (!isActiveRun(runId)) return supersededResult(runId);
      lastPlan = plan;
      const action = planAction(plan);
      if (action === 'skip') {
        const clear = await runPromptMutationSection(runId, () => clearPromptBestEffort(host));
        if (clear?.superseded) return clear;
        if (!isActiveRun(runId)) return supersededResult(runId);
        if (clear?.ok === false) {
          reportClearWarning(runId, clear);
        } else {
          settleRuntimeActivity({
            runId,
            outcome: 'success',
            label: 'Recursion skipped by Utility Arbiter.'
          });
        }
        return { ok: true, skipped: true, reason: 'arbiter-skip', plan, clear };
      }

      stageRuntimeActivity({
        runId,
        phase: 'cardBatchRunning',
        label: plan.cardJobs?.length ? 'Generating scene cards...' : 'Reusing scene deck...',
        cardCounts: { requested: plan.cardJobs?.length || 0 },
        chips: ['Cards']
      });
      const cache = await loadSceneCacheSafe(runId, snapshot);
      if (!isActiveRun(runId)) return supersededResult(runId);
      const cacheCards = sanitizedCacheCards(runId, snapshot, cache?.cards);
      const reuseCacheOnly = action === 'reuse-cache' && cacheCards.length > 0;
      const providerCards = reuseCacheOnly ? [] : (await generatePlanCards({ runId, plan, snapshot, signal })).map(sanitizeGeneratedCard);
      if (!isActiveRun(runId)) return supersededResult(runId);
      const generatedCards = reuseCacheOnly ? [] : localCards(snapshot).map(sanitizeGeneratedCard);
      if (action === 'reuse-cache' && !cacheCards.length) {
        const clear = await runPromptMutationSection(runId, () => clearPromptBestEffort(host));
        if (clear?.superseded) return clear;
        if (!isActiveRun(runId)) return supersededResult(runId);
        if (clear?.ok === false) {
          reportClearWarning(runId, clear);
        } else {
          settleRuntimeActivity({
            runId,
            outcome: 'warning',
            label: 'Recursion skipped: no reusable scene hand.'
          });
        }
        return { ok: true, skipped: true, reason: 'cache-unavailable', plan, clear };
      }
      const deck = applyCardPlan(cacheCards, {
        acceptedCards: [...generatedCards, ...providerCards],
        lifecycle: (reuseCacheOnly ? cacheCards : [...generatedCards, ...providerCards]).map((card) => ({
          action: 'select',
          cardId: card.id,
          reason: reuseCacheOnly
            ? 'reused scene cache'
            : (providerCards.some((entry) => entry.id === card.id) ? 'utility generated card' : 'current fallback hand')
        }))
      });
      if (!isActiveRun(runId)) return supersededResult(runId);
      if (!reuseCacheOnly) {
        await runStorageSaveSection(runId, () => saveSceneCacheSafe(runId, snapshot, {
          cacheState: 'active',
          source: {
            chatIdHash: hashJson(snapshot.chatId),
            latestMesId: snapshot.latestMesId,
            sceneFingerprint: snapshot.sceneFingerprint,
            chatWindowHash: hashJson(snapshot.messages)
          },
          cards: deck.cards
        }));
      }
      if (!isActiveRun(runId)) return supersededResult(runId);

      stageRuntimeActivity({
        runId,
        phase: 'handSelected',
        label: 'Selecting turn hand...',
        cardCounts: { selected: Math.min(deck.cards.length, budgetOr(plan.budgets?.maxCards, 6)) }
      });
      const hand = selectHand(deck.cards, {
        maxCards: budgetOr(plan.budgets?.maxCards, 6),
        maxTokens: budgetOr(plan.budgets?.targetBriefTokens, 700)
      });

      const packet = await composePromptPacket({
        hand,
        snapshot,
        settings: settingsForPlan(settings, plan),
        generationRouter: signalAwareGenerationRouter(generationRouter, signal, runId),
        activity,
        runId,
        signal
      });
      if (!isActiveRun(runId)) return supersededResult(runId);
      lastHand = hand;
      lastPacket = packet;

      if (settings.mode === 'observe') {
        const clear = await runPromptMutationSection(runId, () => clearPromptBestEffort(host));
        if (clear?.superseded) return clear;
        if (!isActiveRun(runId)) return supersededResult(runId);
        if (clear?.ok === false) {
          reportClearWarning(runId, clear);
        } else {
          settleRuntimeActivity({
            runId,
            outcome: 'success',
            label: 'Observe mode: hand preview ready. No prompt injected.'
          });
        }
        return { ok: true, observe: true, packet, hand, plan, clear };
      }

      if (!isActiveRun(runId)) return supersededResult(runId);
      const installedResult = await runPromptMutationSection(runId, async () => {
        stageRuntimeActivity({
          runId,
          phase: 'promptInstalling',
          label: 'Installing Recursion prompt...',
          chips: ['Prompt']
        });
        if (!isActiveRun(runId)) return supersededResult(runId);
        const install = await installPrompt(host, packet);
        if (!isActiveRun(runId)) return supersededResult(runId);
        const installOk = install?.ok !== false;
        await appendJournalSafe(runId, snapshot.chatKey, {
          event: installOk ? 'prompt.installed' : 'prompt.install_failed',
          severity: installOk ? 'info' : 'warn',
          summary: installSummary(install),
          runId,
          sceneKey: snapshot.sceneKey,
          details: installJournalDetails(install),
          hashes: { promptPacketHash: hashJson(packet) }
        });
        if (!isActiveRun(runId)) return supersededResult(runId);
        settleRuntimeActivity({
          runId,
          outcome: installOk ? 'success' : 'warning',
          label: installOk ? 'Recursion prompt ready.' : INSTALL_FAILURE_LABEL
        });
        return { ok: installOk, packet, hand, plan, install };
      });
      return installedResult;
    } catch (error) {
      if (!isActiveRun(runId)) return supersededResult(runId);
      const safeError = runtimeError(error);
      settleRuntimeActivity({
        runId,
        outcome: 'error',
        label: 'Recursion runtime failed.',
        detail: { message: safeError.message }
      });
      throw safeError;
    } finally {
      clearActiveRun(runId);
    }
  }

  return {
    storage,
    prepareForGeneration,
    async refreshScene() {
      return prepareForGeneration({ userMessage: 'manual refresh' });
    },
    updateSettings,
    updateProvider,
    clearProviderKey,
    testProvider,
    view() {
      return {
        activeRunId,
        lastPacket,
        lastHand,
        lastPlan,
        lastSnapshot: viewSnapshot(lastSnapshot),
        activity: safeCurrentActivity(activity),
        settings: safeSettingsView(settingsStore.get()),
        updatedAt: nowIso()
      };
    }
  };
}
