import { createActivityReporter } from '../activity.mjs';
import { createSillyTavernHost } from '../hosts/sillytavern/host.mjs';
import { createGenerationRouter } from '../providers.mjs';
import { createRecursionRuntime } from '../runtime.mjs';
import { createStorageRepository } from '../storage.mjs';
import { mountRecursionUi } from '../ui.mjs';

let runtime = null;
let ui = null;
let host = null;
let hostEventUnsubscribers = [];
let settingsBootstrapUnsubscribers = [];
let settingsLoadEventObserved = false;

let enhancementControlsLocked = false;

function hasSillyTavernContext() {
  return typeof globalThis.SillyTavern?.getContext === 'function'
    || typeof globalThis.getContext === 'function';
}

function getSillyTavernContextSafe() {
  try {
    if (typeof globalThis.SillyTavern?.getContext === 'function') return globalThis.SillyTavern.getContext() || {};
    if (typeof globalThis.getContext === 'function') return globalThis.getContext() || {};
  } catch (error) {
    warn('Read SillyTavern context failed.', error);
  }
  return {};
}

function warn(label, error) {
  if (typeof console?.warn !== 'function') return;
  console.warn(`[Recursion] ${label}`, error);
}

function publishLiveHarnessRuntime(nextRuntime) {
  if (globalThis.__recursionLiveHarness === true) {
    globalThis.__recursionLiveHarnessRuntime = nextRuntime || null;
  }
}

function setEnhancementCaptureActive() {
  // The original SillyTavern response remains visible while Generation Review runs.
}

function refreshEnhancementCaptureState(activeRuntime = runtime) {
  const active = typeof activeRuntime?.proseEnhancementPending === 'function'
    && activeRuntime.proseEnhancementPending();
  setEnhancementCaptureActive(active);
  return active;
}

async function lockEnhancementControls(currentHost = host) {
  if (enhancementControlsLocked) return { ok: true, locked: true, unchanged: true };
  enhancementControlsLocked = true;
  try {
    const result = await currentHost?.generation?.lockControls?.();
    if (result?.ok === false) enhancementControlsLocked = false;
    return result || { ok: true, locked: true };
  } catch (error) {
    enhancementControlsLocked = false;
    warn('Enhancement control lock failed.', error);
    return { ok: false, locked: false, error };
  }
}

async function unlockEnhancementControls(currentHost = host) {
  if (!enhancementControlsLocked) return { ok: true, locked: false, unchanged: true };
  enhancementControlsLocked = false;
  try {
    return await currentHost?.generation?.unlockControls?.() || { ok: true, locked: false };
  } catch (error) {
    warn('Enhancement control unlock failed.', error);
    return { ok: false, locked: false, error };
  }
}

function activeAssistantIdentityFromHost(currentHost) {
  try {
    return currentHost?.messages?.activeAssistantMessageIdentity?.() || null;
  } catch {
    return null;
  }
}

function enhancementOwnedSourceMutation(details = {}, currentHost = host) {
  if (details?.deleted) return false;
  if (!details?.latestAssistant) return false;
  if (!details.edited && !details.swiped) return false;
  const activeIdentity = activeAssistantIdentityFromHost(currentHost);
  const sameMessage = details.messageId === undefined
    || details.messageId === null
    || String(activeIdentity?.messageId ?? '') === String(details.messageId);
  return activeIdentity?.enhancementOwned === true && sameMessage;
}

function scheduleHeldEnhancementRecovery(activeRuntime = runtime, reason = 'bootstrap') {
  if (typeof activeRuntime?.recoverHeldProseEnhancementMessages !== 'function') return;
  Promise.resolve()
    .then(() => activeRuntime.recoverHeldProseEnhancementMessages({ reason }))
    .catch((error) => warn('Enhancement stale hold recovery failed.', error));
}

function destroyUi() {
  try {
    ui?.destroy?.();
  } catch {
    // UI teardown must never block host lifecycle hooks.
  } finally {
    ui = null;
  }
}

function clearHostEventSubscriptions() {
  const unsubscribers = hostEventUnsubscribers;
  hostEventUnsubscribers = [];
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe();
    } catch (error) {
      warn('Host event unsubscribe failed.', error);
    }
  }
}

function clearSettingsBootstrapSubscriptions() {
  const unsubscribers = settingsBootstrapUnsubscribers;
  settingsBootstrapUnsubscribers = [];
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe();
    } catch (error) {
      warn('Settings bootstrap unsubscribe failed.', error);
    }
  }
}

function subscribeHostEvent(eventSource, eventName, handler) {
  if (!eventSource || !eventName || typeof handler !== 'function') return null;
  if (typeof eventSource.on === 'function') {
    eventSource.on(eventName, handler);
    return () => {
      if (typeof eventSource.removeListener === 'function') eventSource.removeListener(eventName, handler);
      else if (typeof eventSource.off === 'function') eventSource.off(eventName, handler);
    };
  }
  if (typeof eventSource.addEventListener === 'function') {
    eventSource.addEventListener(eventName, handler);
    return () => eventSource.removeEventListener?.(eventName, handler);
  }
  return null;
}

function hasSettingsRoot(context) {
  if (globalThis.extension_settings && typeof globalThis.extension_settings === 'object') return true;
  const root = context?.extensionSettings;
  if (!root || typeof root !== 'object') return false;
  if (root.recursion && typeof root.recursion === 'object') return true;
  return settingsLoadEventObserved && Object.keys(root).length > 0;
}

function scheduleSettingsBootstrap() {
  if (settingsBootstrapUnsubscribers.length > 0) return;
  const context = getSillyTavernContextSafe();
  const eventSource = context.eventSource || globalThis.eventSource;
  const eventTypes = hostEventTypes(context);
  const eventNames = [
    eventTypes.EXTENSION_SETTINGS_LOADED,
    eventTypes.SETTINGS_LOADED,
    eventTypes.APP_READY
  ].filter(Boolean);
  const uniqueEventNames = [...new Set(eventNames)];
  if (!eventSource || uniqueEventNames.length === 0) return;
  const retryBootstrap = () => {
    settingsLoadEventObserved = true;
    if (!hasSettingsRoot(getSillyTavernContextSafe())) return;
    clearSettingsBootstrapSubscriptions();
    bootstrapRecursion();
  };
  settingsBootstrapUnsubscribers = uniqueEventNames
    .map((eventName) => subscribeHostEvent(eventSource, eventName, retryBootstrap))
    .filter((unsubscribe) => typeof unsubscribe === 'function');
}

function hostEventTypes(context) {
  return context?.event_types
    || context?.eventTypes
    || globalThis.event_types
    || globalThis.eventTypes
    || {};
}

function resolveChatChangedEvent(context) {
  return hostEventTypes(context).CHAT_CHANGED || '';
}

function resolveSourceChangedEvents(context) {
  const eventTypes = hostEventTypes(context);
  return [
    eventTypes.MESSAGE_DELETED,
    eventTypes.MESSAGE_UPDATED,
    eventTypes.MESSAGE_SWIPED
  ].filter(Boolean);
}

function resolveGenerationStoppedEvents(context) {
  const eventTypes = hostEventTypes(context);
  return [...new Set([
    eventTypes.GENERATION_STOPPED,
    'generation_stopped'
  ].filter(Boolean))];
}

function resolveAssistantLandedEvents(context) {
  const eventTypes = hostEventTypes(context);
  return [...new Set([
    eventTypes.GENERATION_ENDED,
    eventTypes.MESSAGE_RECEIVED,
    'generation_ended'
  ].filter(Boolean))];
}

function resolveAssistantStreamingEvents(context) {
  const eventTypes = hostEventTypes(context);
  return [...new Set([
    eventTypes.STREAM_TOKEN_RECEIVED,
    eventTypes.SMOOTH_STREAM_TOKEN_RECEIVED
  ].filter(Boolean))];
}

function normalizeHostMessageEvent(currentHost, eventName, payload) {
  const normalized = currentHost?.normalizeMessageEvent?.(payload, { eventName });
  if (normalized && typeof normalized === 'object') return normalized;
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const rawId = source.messageId ?? source.mesid ?? source.id ?? source.message_id ?? payload;
  return {
    eventName: String(eventName || ''),
    messageId: rawId ?? null,
    swiped: String(eventName || '').toLowerCase() === 'message_swiped',
    deleted: String(eventName || '').toLowerCase() === 'message_deleted',
    edited: /message_(edited|updated)/i.test(String(eventName || '')),
    latestAssistant: false,
    text: ''
  };
}

function latestAssistantMessageIdentityFromHost(currentHost) {
  try {
    return currentHost?.latestAssistantMessageIdentity?.() || '';
  } catch {
    return '';
  }
}

function registerRuntimeHostEvent(eventSource, eventName, handler) {
  const unsubscribe = subscribeHostEvent(eventSource, eventName, handler);
  if (typeof unsubscribe === 'function') hostEventUnsubscribers.push(unsubscribe);
}

function invokeRuntimeCleanup(methodName, label, ...args) {
  const activeRuntime = runtime;
  return Promise.resolve(activeRuntime?.[methodName]?.(...args)).catch((error) => {
    warn(label, error);
  });
}

function registerHostEvents(nextRuntime, currentHost = host) {
  clearHostEventSubscriptions();
  const context = getSillyTavernContextSafe();
  const eventSource = context.eventSource || globalThis.eventSource;
  let lastAssistantIdentity = latestAssistantMessageIdentityFromHost(currentHost);
  const refreshAssistantSignature = () => {
    lastAssistantIdentity = latestAssistantMessageIdentityFromHost(currentHost);
  };
  const chatChangedEvent = resolveChatChangedEvent(context);
  registerRuntimeHostEvent(eventSource, chatChangedEvent, () => {
    const nextAssistantIdentity = latestAssistantMessageIdentityFromHost(currentHost);
    const enhancementOwnedChatMutation = activeAssistantIdentityFromHost(currentHost)?.enhancementOwned === true
      && Boolean(nextAssistantIdentity)
      && nextAssistantIdentity === lastAssistantIdentity;
    lastAssistantIdentity = nextAssistantIdentity;
    runtime ||= nextRuntime;
    if (enhancementOwnedChatMutation) {
      setEnhancementCaptureActive(false);
      return { ok: true, skipped: true, reason: 'enhancement-owned-chat-mutation' };
    }
    setEnhancementCaptureActive(false);
    return invokeRuntimeCleanup('handleChatChanged', 'Chat change cleanup failed.');
  });
  for (const eventName of resolveSourceChangedEvents(context)) {
    registerRuntimeHostEvent(eventSource, eventName, (payload) => {
      const details = normalizeHostMessageEvent(currentHost, eventName, payload);
      runtime ||= nextRuntime;
      if (
        typeof nextRuntime.proseEnhancementPending === 'function'
        && nextRuntime.proseEnhancementPending()
        && details.edited
        && !details.deleted
        && !details.swiped
      ) {
        setEnhancementCaptureActive(true);
        return invokeRuntimeCleanup('holdPendingProseEnhancementMessage', 'Enhancement streaming hold failed.', details)
          .then(() => ({ ok: true, skipped: true, reason: 'enhancement-streaming-update' }));
      }
      if (enhancementOwnedSourceMutation(details, currentHost)) {
        return { ok: true, skipped: true, reason: 'enhancement-owned-source-mutation' };
      }
      if (details.swiped && details.latestAssistant) {
        refreshAssistantSignature();
        return invokeRuntimeCleanup('handleLatestAssistantSwipeRetry', 'Latest assistant swipe retry marker failed.', details);
      }
      refreshAssistantSignature();
      setEnhancementCaptureActive(false);
      return invokeRuntimeCleanup('handleSourceChanged', 'Source change cleanup failed.', details);
    });
  }
  for (const eventName of resolveAssistantStreamingEvents(context)) {
    registerRuntimeHostEvent(eventSource, eventName, (payload) => {
      runtime ||= nextRuntime;
      if (typeof nextRuntime.proseEnhancementPending === 'function' && nextRuntime.proseEnhancementPending()) {
        setEnhancementCaptureActive(true);
        const details = normalizeHostMessageEvent(currentHost, eventName, payload);
        return invokeRuntimeCleanup('holdPendingProseEnhancementMessage', 'Enhancement streaming hold failed.', details)
          .then(() => ({ ok: true, skipped: true, reason: 'enhancement-stream-token' }));
      }
      return { ok: true, skipped: true, reason: 'enhancement-not-pending' };
    });
  }
  for (const eventName of resolveGenerationStoppedEvents(context)) {
    registerRuntimeHostEvent(eventSource, eventName, (payload) => {
      refreshAssistantSignature();
      runtime ||= nextRuntime;
      const details = normalizeHostMessageEvent(currentHost, eventName, payload);
      details.enhancementControlsLocked = enhancementControlsLocked;
      return invokeRuntimeCleanup('handleHostGenerationStopped', 'Generation stop cleanup failed.', details)
        .finally(() => unlockEnhancementControls(currentHost))
        .finally(() => setEnhancementCaptureActive(false));
    });
  }
  for (const eventName of resolveAssistantLandedEvents(context)) {
    registerRuntimeHostEvent(eventSource, eventName, (payload) => {
      const nextAssistantIdentity = latestAssistantMessageIdentityFromHost(currentHost);
      runtime ||= nextRuntime;
      const details = normalizeHostMessageEvent(currentHost, eventName, payload);
      const finalGenerationEvent = String(eventName || '').toLowerCase() === 'generation_ended'
        || String(details.eventName || '').toLowerCase() === 'generation_ended';
      if (
        finalGenerationEvent
        && typeof nextRuntime.proseEnhancementRunning === 'function'
        && nextRuntime.proseEnhancementRunning()
      ) {
        return { ok: true, skipped: true, reason: 'enhancement-owned-generation-ended' };
      }
      const sanitizeEnhancementMarker = () => {
        if (!finalGenerationEvent || typeof currentHost?.messages?.sanitizeAssistantEnhancementMarker !== 'function') {
          return Promise.resolve({ ok: true, skipped: true, reason: 'marker-sanitation-unavailable' });
        }
        return Promise.resolve(currentHost.messages.sanitizeAssistantEnhancementMarker(details.messageId)).catch((error) => {
          warn('Enhancement marker sanitation failed.', error);
          return { ok: false, error };
        });
      };
      const generationEnded = () => invokeRuntimeCleanup(
        'handleHostGenerationEnded',
        'Generation end cleanup failed.',
        details
      );
      if (typeof nextRuntime.proseEnhancementPending === 'function' && nextRuntime.proseEnhancementPending()) {
        setEnhancementCaptureActive(true);
        if (!finalGenerationEvent) {
          return invokeRuntimeCleanup('holdPendingProseEnhancementMessage', 'Enhancement assistant hold failed.', details)
            .then(() => ({ ok: true, skipped: true, reason: 'enhancement-awaiting-generation-ended' }));
        }
        return sanitizeEnhancementMarker()
          .then(() => lockEnhancementControls(currentHost))
          .then(() => invokeRuntimeCleanup('holdPendingProseEnhancementMessage', 'Enhancement assistant hold failed.', details))
          .then(() => invokeRuntimeCleanup('enhanceLatestAssistantMessage', 'Enhancement failed.', { reason: 'assistant-message-landed' }))
          .then(() => generationEnded())
          .finally(() => unlockEnhancementControls(currentHost))
          .then(() => {
            lastAssistantIdentity = latestAssistantMessageIdentityFromHost(currentHost);
            return invokeRuntimeCleanup('warmRapidScene', 'Rapid warm failed.', { reason: 'assistant-message-landed' });
          })
          .finally(() => {
            setEnhancementCaptureActive(false);
          });
      }
      if (!nextAssistantIdentity || nextAssistantIdentity === lastAssistantIdentity) {
        return sanitizeEnhancementMarker()
          .then(() => generationEnded())
          .then(() => ({ ok: true, skipped: true, reason: 'assistant-message-unchanged' }))
          .finally(() => setEnhancementCaptureActive(false));
      }
      lastAssistantIdentity = nextAssistantIdentity;
      return sanitizeEnhancementMarker()
        .then(() => generationEnded())
        .then(() => invokeRuntimeCleanup('warmRapidScene', 'Rapid warm failed.', { reason: 'assistant-message-landed' }))
        .finally(() => {
          setEnhancementCaptureActive(false);
        });
    });
  }
}

export function createProviderJournal(storage, currentHost) {
  return {
    async append(entry = {}) {
      try {
        const snapshot = typeof currentHost?.snapshot === 'function'
          ? await currentHost.snapshot()
          : { chatKey: 'unknown-chat', sceneKey: 'unknown-scene' };
        const status = String(entry.status || '').toLowerCase();
        const event = status === 'started'
          ? 'provider.call.started'
          : (status === 'success' ? 'provider.call.completed' : 'provider.call.failed');
        await storage.appendJournal(snapshot.chatKey || 'unknown-chat', {
          event,
          severity: status === 'success' || status === 'started' ? 'info' : 'warn',
          summary: `${entry.roleId || 'provider'} ${entry.status || 'completed'}`,
          runId: entry.runId,
          sceneKey: snapshot.sceneKey,
          details: {
            roleId: entry.roleId,
            lane: entry.lane,
            providerSource: entry.providerSource,
            providerId: entry.providerId,
            model: entry.model,
            responseId: entry.responseId,
            schema: entry.schema,
            retryCount: entry.retryCount,
            structuredOutputRecovery: entry.structuredOutputRecovery,
            effectiveMaxTokens: entry.effectiveMaxTokens,
            finishReason: entry.finishReason,
            promptTokens: entry.promptTokens,
            completionTokens: entry.completionTokens,
            reasoningTokens: entry.reasoningTokens,
            totalTokens: entry.totalTokens,
            visibleContentLength: entry.visibleContentLength,
            latencyMs: entry.latencyMs,
            status: entry.status,
            error: entry.error
          },
          hashes: {
            requestHash: entry.requestHash,
            responseHash: entry.responseHash
          }
        });
      } catch {
        // Provider journal writes are diagnostic only; never affect generation.
      }
    }
  };
}

function messageText(message) {
  if (message === undefined || message === null) return '';
  if (typeof message === 'string') return message.trim();
  if (typeof message !== 'object') return '';
  return String(message.mes ?? message.text ?? '').trim();
}

function messageMesId(message) {
  if (!message || typeof message !== 'object') return undefined;
  const value = Number(message.mesid ?? message.id ?? message.messageId);
  return Number.isFinite(value) ? value : undefined;
}

function isSuppressedMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return message.visible === false || message.hidden === true || message.is_system === true;
}

function isRawUserChatMessage(message) {
  return Boolean(message && typeof message === 'object' && message.is_user === true && !isSuppressedMessage(message));
}

function chatMessagesFromPayload(chat) {
  if (Array.isArray(chat)) return chat;
  if (Array.isArray(chat?.messages)) return chat.messages;
  if (Array.isArray(chat?.chat)) return chat.chat;
  return [];
}

function latestPendingUserMessageFromPayload(chat) {
  if (typeof chat === 'string') return { text: chat.trim() };
  const messages = chatMessagesFromPayload(chat);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isSuppressedMessage(message)) continue;
    if (!isRawUserChatMessage(message)) return null;
    const text = messageText(message);
    if (text) return { text, mesid: messageMesId(message) };
    return null;
  }
  return null;
}

export function bootstrapRecursion() {
  if (runtime) return runtime;
  if (!hasSillyTavernContext()) return null;
  const context = getSillyTavernContextSafe();
  if (!hasSettingsRoot(context)) {
    scheduleSettingsBootstrap();
    return null;
  }
  clearSettingsBootstrapSubscriptions();

  try {
    const nextHost = createSillyTavernHost();
    const activity = createActivityReporter();
    const storage = createStorageRepository({
      storage: nextHost.storageAdapter,
      activity,
      getRetentionSettings: () => nextHost.settingsStore.get().retention
    });
    const generationRouter = createGenerationRouter({
      client: nextHost.providerClient,
      activity,
      journal: createProviderJournal(storage, nextHost)
    });

    const nextRuntime = createRecursionRuntime({
      host: nextHost,
      settingsStore: nextHost.settingsStore,
      storage,
      activity,
      generationRouter
    });
    const nextUi = mountRecursionUi({ runtime: nextRuntime });
    host = nextHost;
    runtime = nextRuntime;
    ui = nextUi;
    publishLiveHarnessRuntime(nextRuntime);
    registerHostEvents(nextRuntime, nextHost);
    scheduleHeldEnhancementRecovery(nextRuntime, 'bootstrap');
    return runtime;
  } catch (error) {
    warn('Bootstrap failed.', error);
    clearHostEventSubscriptions();
    destroyUi();
    host = null;
    runtime = null;
    return null;
  }
}

async function clearPromptBestEffort(label) {
  if (typeof host?.prompt?.clear !== 'function') return;
  try {
    const result = await host.prompt.clear();
    if (result?.ok === false) warn(`${label} prompt clear failed.`, result.error || result);
  } catch (error) {
    warn(`${label} prompt clear failed.`, error);
  }
}

async function teardownRecursion(label) {
  clearSettingsBootstrapSubscriptions();
  clearHostEventSubscriptions();
  settingsLoadEventObserved = false;
  setEnhancementCaptureActive(false);
  await unlockEnhancementControls(host);
  try {
    await runtime?.dispose?.();
  } catch (error) {
    warn(`${label} runtime dispose failed.`, error);
  }
  await clearPromptBestEffort(label);
  destroyUi();
  host = null;
  runtime = null;
  publishLiveHarnessRuntime(null);
}

export async function recursionGenerationInterceptor(chat, _contextSize, _abort, generationType = '') {
  const activeRuntime = bootstrapRecursion();
  if (!activeRuntime) return chat;

  try {
    await activeRuntime.prepareForGeneration({
      userMessage: latestPendingUserMessageFromPayload(chat),
      hostGeneration: true,
      generationType
    });
    refreshEnhancementCaptureState(activeRuntime);
  } catch (error) {
    setEnhancementCaptureActive(false);
    warn('Generation preparation failed.', error);
  }
  return chat;
}

export async function recursionOnInstall() {
  return true;
}

export async function recursionOnUpdate() {
  return true;
}

export async function recursionOnEnable() {
  try {
    bootstrapRecursion();
  } catch (error) {
    warn('Enable failed.', error);
  }
  return true;
}

export async function recursionOnDisable() {
  await teardownRecursion('Disable');
  return true;
}

export async function recursionOnDelete() {
  await teardownRecursion('Delete');
  return true;
}

export async function recursionOnClean() {
  return true;
}

export async function recursionOnActivate() {
  try {
    bootstrapRecursion();
  } catch (error) {
    warn('Activate failed.', error);
  }
  return true;
}

function ready(callback) {
  if (typeof document === 'undefined') return;
  if (typeof globalThis.jQuery === 'function') {
    globalThis.jQuery(callback);
    return;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback, { once: true });
    return;
  }
  callback();
}

globalThis.recursionGenerationInterceptor = recursionGenerationInterceptor;
globalThis.recursionOnInstall = recursionOnInstall;
globalThis.recursionOnUpdate = recursionOnUpdate;
globalThis.recursionOnEnable = recursionOnEnable;
globalThis.recursionOnDisable = recursionOnDisable;
globalThis.recursionOnDelete = recursionOnDelete;
globalThis.recursionOnClean = recursionOnClean;
globalThis.recursionOnActivate = recursionOnActivate;

ready(() => {
  try {
    bootstrapRecursion();
  } catch (error) {
    warn('Document-ready bootstrap failed.', error);
  }
});
