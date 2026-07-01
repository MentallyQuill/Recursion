import { createActivityReporter } from '../activity.mjs';
import { createSillyTavernHost } from '../hosts/sillytavern/host.mjs';
import { createGenerationRouter } from '../providers.mjs';
import { createRecursionRuntime } from '../runtime.mjs';
import { createStorageRepository } from '../storage.mjs';
import { mountRecursionUi } from '../ui.mjs';

let runtime = null;
let ui = null;
let host = null;

function hasSillyTavernContext() {
  return typeof globalThis.SillyTavern?.getContext === 'function'
    || typeof globalThis.getContext === 'function';
}

function warn(label, error) {
  if (typeof console?.warn !== 'function') return;
  console.warn(`[Recursion] ${label}`, error);
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

function createProviderJournal(storage, currentHost) {
  return {
    async append(entry = {}) {
      try {
        const snapshot = typeof currentHost?.snapshot === 'function'
          ? await currentHost.snapshot()
          : { chatKey: 'unknown-chat', sceneKey: 'unknown-scene' };
        await storage.appendJournal(snapshot.chatKey || 'unknown-chat', {
          event: 'provider.call',
          severity: entry.status === 'success' ? 'info' : 'warn',
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

export function bootstrapRecursion() {
  if (runtime) return runtime;
  if (!hasSillyTavernContext()) return null;

  try {
    const nextHost = createSillyTavernHost();
    const activity = createActivityReporter();
    const storage = createStorageRepository({
      storage: nextHost.storageAdapter,
      activity
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
    return runtime;
  } catch (error) {
    warn('Bootstrap failed.', error);
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
  try {
    await runtime?.dispose?.();
  } catch (error) {
    warn(`${label} runtime dispose failed.`, error);
  }
  await clearPromptBestEffort(label);
  destroyUi();
  host = null;
  runtime = null;
}

export async function recursionGenerationInterceptor(chat) {
  const activeRuntime = bootstrapRecursion();
  if (!activeRuntime) return chat;

  try {
    await activeRuntime.prepareForGeneration({ userMessage: '' });
  } catch (error) {
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
