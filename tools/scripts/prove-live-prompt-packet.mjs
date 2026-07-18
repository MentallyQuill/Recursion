import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import {
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';

const DEFAULT_TIMEOUT_MS = 180000;
const PIPELINES = new Set(['standard', 'rapid', 'fused']);
const EXPECTED_STORY_FORM = Object.freeze({
  tense: 'past',
  pov: 'third-person-limited'
});

function parseArgs(argv = []) {
  const args = { live: false, pipeline: 'standard', providerProfile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') args.live = true;
    else if (arg === '--pipeline') {
      args.pipeline = String(argv[index + 1] || '').trim().toLowerCase() || args.pipeline;
      index += 1;
    } else if (arg === '--provider-profile' || arg === '--profile') {
      args.providerProfile = String(argv[index + 1] || '').trim();
      index += 1;
    }
  }
  return args;
}

function fail(result, message, details = {}) {
  const error = new Error(message);
  error.result = result;
  error.details = details;
  throw error;
}

function passwordEnvKey(user) {
  return `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function passwordForUser(user, env) {
  return env[passwordEnvKey(user)] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function assertPreflight(args, env) {
  if (!args.live) fail('dry-run', 'Pass --live to mutate a dedicated SillyTavern user.');
  if (!PIPELINES.has(args.pipeline)) fail('invalid-pipeline', 'Use --pipeline standard, rapid, or fused.', { pipeline: args.pipeline });
  if (!env.SILLYTAVERN_BASE_URL) fail('missing-base-url', 'SILLYTAVERN_BASE_URL is required.');
  const user = String(env.RECURSION_SILLYTAVERN_USER || '').trim();
  const userResult = validateSoakUserHandle(user);
  if (!userResult.ok) {
    fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', {
      user,
      reason: userResult.reason
    });
  }
  return userResult.user;
}

async function waitForRoot(page, timeoutMs) {
  await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-pipeline-button]', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-mode-button]', { timeout: timeoutMs });
}

async function setPower(page, enabled, timeoutMs) {
  const button = page.locator('[data-recursion-power-toggle]').first();
  await button.waitFor({ timeout: timeoutMs });
  const pressed = async () => (await button.getAttribute('aria-pressed').catch(() => 'true')) !== 'false';
  if (await pressed() !== enabled) await button.click({ timeout: timeoutMs });
  await page.waitForFunction((expected) => {
    const node = document.querySelector('[data-recursion-power-toggle]');
    return Boolean(node) && ((node.getAttribute('aria-pressed') !== 'false') === expected);
  }, enabled, { timeout: timeoutMs });
}

async function forcePipelineSetting(page, pipeline, timeoutMs) {
  await page.evaluate(async (expected) => {
    globalThis.__recursionLiveHarness = true;
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const roots = [context.extensionSettings, globalThis.extension_settings].filter(Boolean);
    for (const root of roots) {
      if (!root.recursion || typeof root.recursion !== 'object') root.recursion = {};
      root.recursion.pipelineMode = expected;
    }
    if (typeof globalThis.recursionOnDisable === 'function') await globalThis.recursionOnDisable();
    if (typeof globalThis.recursionOnEnable === 'function') await globalThis.recursionOnEnable();
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    if (typeof runtime?.updateSettings === 'function') await runtime.updateSettings({ pipelineMode: expected });
  }, pipeline);
  await waitForRoot(page, timeoutMs);
  await page.waitForFunction((expected) => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    return String(runtime?.view?.()?.settings?.pipelineMode || '') === expected;
  }, pipeline, { timeout: timeoutMs });
}

async function selectPipeline(page, pipeline, timeoutMs) {
  const button = page.locator('[data-recursion-pipeline-button]').first();
  await button.click({ timeout: timeoutMs });
  await page.locator(`[data-recursion-pipeline-choice="${pipeline}"], [data-recursion-pipeline-choice-${pipeline}]`).first().click({ timeout: timeoutMs });
  await forcePipelineSetting(page, pipeline, timeoutMs);
  await page.waitForFunction((expected) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const settings = context?.extensionSettings?.recursion || globalThis.extension_settings?.recursion || {};
    return String(settings.pipelineMode || '') === expected;
  }, pipeline, { timeout: timeoutMs });
}

async function selectMode(page, mode, timeoutMs) {
  const text = await page.evaluate(() => String(document.querySelector('[data-recursion-mode]')?.textContent || '').toLowerCase()).catch(() => '');
  if (!text.includes(mode)) {
    const button = page.locator('[data-recursion-mode-button]').first();
    await button.click({ timeout: timeoutMs });
    await page.locator(`[data-recursion-mode-choice="${mode}"], [data-recursion-mode-choice-${mode}]`).first().click({ timeout: timeoutMs });
  }
  await page.waitForFunction((expected) => {
    return String(document.querySelector('[data-recursion-mode]')?.textContent || '').toLowerCase().includes(expected);
  }, mode, { timeout: timeoutMs });
}

function installRawPromptRecorderScript() {
  return () => {
    const events = [];
    globalThis.__recursionPromptPacketProofEvents = events;
    const install = (context) => {
      if (!context || typeof context.setExtensionPrompt !== 'function') return false;
      if (context.__recursionPromptPacketProofInstalled) return true;
      const original = context.setExtensionPrompt.bind(context);
      context.__recursionPromptPacketProofOriginal = original;
      context.setExtensionPrompt = (...args) => {
        const key = String(args[0] || '');
        const text = String(args[1] || '');
        if (key.startsWith('recursion.')) {
          events.push({
            key,
            text,
            textLength: text.length,
            cleared: text.length === 0,
            position: String(args[2] || ''),
            depth: Number(args[3] || 0),
            role: String(args[5] || '')
          });
        }
        return original(...args);
      };
      context.__recursionPromptPacketProofInstalled = true;
      return true;
    };
    const current = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
    install(current);
    const wrap = (owner, key) => {
      if (!owner || typeof owner[key] !== 'function' || owner[`__recursionPromptPacketProofOriginal${key}`]) return;
      const original = owner[key].bind(owner);
      owner[`__recursionPromptPacketProofOriginal${key}`] = original;
      owner[key] = (...args) => {
        const context = original(...args);
        install(context);
        return context;
      };
    };
    wrap(globalThis.SillyTavern, 'getContext');
    wrap(globalThis, 'getContext');
    return install(current);
  };
}

function installProviderRequestRecorderScript() {
  return () => {
    const events = [];
    globalThis.__recursionProviderRequestProofEvents = events;

    const classifyPrompt = (text) => {
      const source = String(text || '');
      if (/recursion\.utilityArbiter\.v1/.test(source)) return 'utilityArbiter';
      if (/recursion\.cardBundle\.v1/.test(source)) return 'fusedCardBundle';
      if (/recursion\.card\.v1/.test(source)) return 'card';
      if (/recursion\.guidanceComposer\.v1/.test(source)) return 'guidanceComposer';
      if (/recursion\.reasonerComposer\.v1/.test(source)) return 'reasonerComposer';
      if (/recursion\.rapidTurnDelta\.v2/.test(source)) return 'rapidTurnDelta';
      return 'unknown';
    };

    const textFromMessages = (messages) => {
      if (!Array.isArray(messages)) return String(messages || '');
      return messages.map((message) => {
        if (typeof message === 'string') return message;
        if (!message || typeof message !== 'object') return '';
        return [message.role, message.name, message.content, message.text]
          .filter(Boolean)
          .map((entry) => String(entry))
          .join('\n');
      }).join('\n\n');
    };

    const parseObject = (value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      if (typeof value !== 'string' || !value.trim()) return null;
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    };
    const stringifyValue = (value) => {
      if (value === undefined || value === null) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value || '');
        }
      }
      return String(value);
    };

    const responseShape = (result) => {
      const source = result && typeof result === 'object' ? result : { text: String(result ?? '') };
      const text = stringifyValue(source.text) || stringifyValue(source.content) || stringifyValue(source.message);
      const data = parseObject(source.data)
        || parseObject(source.content)
        || parseObject(source.message)
        || parseObject(source.extractedData)
        || parseObject(source.extractData)
        || parseObject(text);
      const items = Array.isArray(data?.items) ? data.items : [];
      const omitted = Array.isArray(data?.omitted) ? data.omitted : [];
      return {
        resultKeys: Object.keys(source).slice(0, 20),
        ok: source.ok === undefined ? true : source.ok === true,
        textLength: text.length,
        dataDetected: Boolean(data),
        dataSchema: String(data?.schema || ''),
        snapshotHash: String(data?.snapshotHash || ''),
        itemCount: items.length,
        omittedCount: omitted.length,
        itemSummaries: items.slice(0, 6).map((item) => ({
          schema: String(item?.schema || ''),
          family: String(item?.family || ''),
          role: String(item?.role || item?.roleId || ''),
          promptTextLength: String(item?.promptText || '').length,
          evidenceRefCount: Array.isArray(item?.evidenceRefs) ? item.evidenceRefs.length : 0
        }))
      };
    };

    const record = (source, payload = {}) => {
      const prompt = String(payload.prompt || payload.systemPrompt || textFromMessages(payload.messages) || '');
      const parameters = payload.parameters || {};
      const reasoning = parameters.reasoning || payload.reasoning || {};
      const event = {
        source,
        role: classifyPrompt(prompt),
        profileId: String(payload.profileId || payload.hostConnectionProfileId || ''),
        providerSource: String(payload.providerSource || (payload.profileId ? 'host-connection-profile' : '')),
        maxTokens: Number(payload.maxTokens || payload.responseLength || 0),
        responseSchema: String(payload.responseSchema || parameters?.json_schema?.name || ''),
        reasoningIntent: String(reasoning.intent || payload.reasoningIntent || ''),
        reasoningCategory: String(reasoning.category || payload.reasoningCategory || ''),
        promptLength: prompt.length,
        hasStoryFormSchema: /recursion\.storyForm\.v1/.test(prompt),
        hasStoryFormJson: /"storyForm"|"Story form:"|Story form:/.test(prompt),
        hasStoryFormInstruction: /past tense, third-person-limited POV|active chat's established story form/.test(prompt),
        hasArbiterStoryPriority: /latest visible assistant narration first/.test(prompt),
        hasCardStoryBlock: /Story form contract for card promptText:/.test(prompt),
        hasTargetTense: /Target tense: past\./.test(prompt),
        hasTargetPov: /Target POV: third-person-limited\./.test(prompt)
      };
      events.push(event);
      return event;
    };

    const install = (context) => {
      if (!context || typeof context !== 'object') return false;
      if (typeof context.generateRaw === 'function' && !context.__recursionProviderRequestProofGenerateRaw) {
        const original = context.generateRaw.bind(context);
        context.__recursionProviderRequestProofGenerateRaw = original;
        context.generateRaw = (request = {}) => {
          record('generateRaw', request);
          return original(request);
        };
      }
      const service = context.ConnectionManagerRequestService || globalThis.ConnectionManagerRequestService;
      if (service && typeof service.sendRequest === 'function' && !service.__recursionProviderRequestProofSendRequest) {
        const original = service.sendRequest.bind(service);
        service.__recursionProviderRequestProofSendRequest = original;
        service.sendRequest = async (profileId, messages, maxTokens, options, parameters) => {
          const event = record('connectionProfile', { messages, profileId, maxTokens, options, parameters });
          try {
            const result = await original(profileId, messages, maxTokens, options, parameters);
            event.responseShape = responseShape(result);
            return result;
          } catch (error) {
            event.responseError = {
              code: String(error?.code || error?.name || 'Error').slice(0, 120),
              message: String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 300)
            };
            throw error;
          }
        };
      }
      return true;
    };

    const current = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
    install(current);
    const wrap = (owner, key) => {
      if (!owner || typeof owner[key] !== 'function' || owner[`__recursionProviderRequestProofOriginal${key}`]) return;
      const original = owner[key].bind(owner);
      owner[`__recursionProviderRequestProofOriginal${key}`] = original;
      owner[key] = (...args) => {
        const context = original(...args);
        install(context);
        return context;
      };
    };
    wrap(globalThis.SillyTavern, 'getContext');
    wrap(globalThis, 'getContext');
    return install(current);
  };
}

async function forceProviderProfile(page, profileName, timeoutMs) {
  const requestedProfile = String(profileName || '').trim();
  if (!requestedProfile) return null;
  const result = await page.evaluate(async (target) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const text = (value) => String(value ?? '').trim();
    const normalize = (value) => text(value).toLowerCase();
    const words = (value) => normalize(value).split(/[^a-z0-9._-]+/).filter(Boolean);
    const profileHaystack = (profile) => [
      profile.id,
      profile.name,
      profile.label,
      profile.model
    ].map((value) => normalize(value)).join(' ');
    const profileId = (profile = {}) => text(profile.id || profile.profileId || profile.name || profile.label || profile.key);
    const profileName = (profile = {}, id = '') => text(profile.name || profile.label || profile.displayName || profile.title || id);
    const profileModel = (profile = {}) => text(profile.model || profile.modelId || profile.model_id || profile.apiModel || profile.completionModel);
    const normalizeProfile = (profile = {}) => {
      const id = profileId(profile);
      if (!id) return null;
      const name = profileName(profile, id);
      const model = profileModel(profile);
      return {
        id,
        name,
        model,
        label: model ? `${name} / ${model}` : name
      };
    };
    const profiles = [];
    try {
      const detected = runtime?.listProviderConnectionProfiles?.() || [];
      profiles.push(...detected.map(normalizeProfile).filter(Boolean));
    } catch {}
    try {
      const service = context.ConnectionManagerRequestService || globalThis.ConnectionManagerRequestService;
      const supported = service?.getSupportedProfiles?.();
      const values = Array.isArray(supported) ? supported : (supported && typeof supported === 'object' ? Object.values(supported) : []);
      profiles.push(...values.map(normalizeProfile).filter(Boolean));
    } catch {}
    try {
      const module = await import('/scripts/extensions/third-party/Recursion/src/hosts/sillytavern/provider-profiles.mjs');
      const detected = module.listSillyTavernConnectionProfiles?.({ context, globals: globalThis }) || [];
      profiles.push(...detected.map(normalizeProfile).filter(Boolean));
    } catch {}
    const byId = new Map();
    for (const profile of profiles) {
      if (!byId.has(profile.id)) byId.set(profile.id, profile);
    }
    const candidates = [...byId.values()];
    const needle = normalize(target);
    const selected = candidates.find((profile) => [
      profile.id,
      profile.name,
      profile.label,
      profile.model
    ].some((value) => normalize(value) === needle))
      || candidates.find((profile) => [
        profile.id,
        profile.name,
        profile.label,
        profile.model
      ].some((value) => normalize(value).includes(needle)))
      || candidates.find((profile) => words(target).every((word) => profileHaystack(profile).includes(word)));
    if (!selected) {
      return {
        ok: false,
        reason: 'profile-not-detected',
        requested: target,
        profiles: candidates.map((profile) => profile.label || profile.id).slice(0, 20)
      };
    }
    if (!runtime || typeof runtime.updateSettings !== 'function' || typeof runtime.updateProvider !== 'function') {
      return {
        ok: false,
        reason: 'runtime-provider-api-unavailable',
        selected
      };
    }
    await runtime.updateSettings({ reasoningLevel: 'high' });
    const providerPatch = {
      source: 'host-connection-profile',
      hostConnectionProfileId: selected.id
    };
    await runtime.updateProviderConfig('utility', providerPatch);
    await runtime.updateProviderConfig('reasoner', providerPatch);
    const utilityTest = typeof runtime.testProvider === 'function'
      ? await runtime.testProvider('utility')
      : { ok: false, error: { code: 'testProvider-unavailable' } };
    const reasonerTest = typeof runtime.testProvider === 'function'
      ? await runtime.testProvider('reasoner')
      : { ok: false, error: { code: 'testProvider-unavailable' } };
    const view = runtime.view?.() || {};
    return {
      ok: utilityTest?.ok === true && reasonerTest?.ok === true,
      reason: utilityTest?.ok === true && reasonerTest?.ok === true ? '' : 'provider-test-failed',
      selected,
      utilityTestOk: utilityTest?.ok === true,
      reasonerTestOk: reasonerTest?.ok === true,
      settings: {
        reasoningLevel: view.settings?.reasoningLevel || '',
        utility: view.settings?.providers?.utility || null,
        reasoner: view.settings?.providers?.reasoner || null
      },
      utilityError: utilityTest?.ok === true ? null : (utilityTest?.error || null),
      reasonerError: reasonerTest?.ok === true ? null : (reasonerTest?.error || null)
    };
  }, requestedProfile);
  if (!result?.ok) {
    fail('provider-profile-setup-failed', 'Failed to configure requested SillyTavern connection profile.', result || {});
  }
  await page.waitForFunction((profileId) => {
    const settings = globalThis.__recursionLiveHarnessRuntime?.view?.()?.settings || {};
    return settings.reasoningLevel === 'high'
      && settings.providers?.utility?.source === 'host-connection-profile'
      && settings.providers?.reasoner?.source === 'host-connection-profile'
      && settings.providers?.utility?.hostConnectionProfileId === profileId
      && settings.providers?.reasoner?.hostConnectionProfileId === profileId
      && settings.providerCapabilities?.utility?.promptPacket?.state === 'ready'
      && settings.providerCapabilities?.reasoner?.promptPacket?.state === 'ready';
  }, result.selected.id, { timeout: timeoutMs });
  return result;
}

async function seedStoryFormScene(page, timeoutMs) {
  const marker = `recursion-story-form-proof-${Date.now().toString(36)}`;
  await page.evaluate((seed) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    if (!Array.isArray(context.chat)) context.chat = [];
    const base = context.chat.length;
    context.chat.push({
      mesid: base,
      is_user: true,
      name: 'Recursion Story Form Proof',
      mes: `I touch the archive door in first person for ${seed}, but this should not define the assistant output form.`
    });
    context.chat.push({
      mesid: base + 1,
      is_user: false,
      name: 'Recursion Story Form Proof',
      mes: [
        `Mara kept her gloved hand against the sealed archive door for ${seed}.`,
        'She felt the brass ward-lines tighten under her palm, but she did not know what waited beyond the threshold.',
        'Only her perspective was available in the narration, and the corridor remained still behind her.'
      ].join(' ')
    });
    globalThis.__recursionStoryFormProofMarker = seed;
  }, marker);
  await page.waitForFunction((seed) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    return Array.isArray(context.chat) && context.chat.some((message) => String(message?.mes || '').includes(seed) && message?.is_user === false);
  }, marker, { timeout: timeoutMs });
  return marker;
}

function directPrepareScript() {
  return (message) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
    if (!context) throw new Error('SillyTavern context unavailable');
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    if (typeof runtime?.prepareForGeneration === 'function') {
      return runtime.prepareForGeneration({
        userMessage: String(message || ''),
        hostGeneration: true
      });
    }
    const chat = Array.isArray(context.chat) ? context.chat.slice() : [];
    chat.push({
      mesid: chat.length,
      is_user: true,
      name: 'Recursion Prompt Packet Proof',
      mes: String(message || '')
    });
    if (typeof globalThis.recursionGenerationInterceptor !== 'function') {
      throw new Error('recursionGenerationInterceptor unavailable');
    }
    return globalThis.recursionGenerationInterceptor(chat);
  };
}

function readProofStateScript() {
  return () => {
    const events = Array.isArray(globalThis.__recursionPromptPacketProofEvents)
      ? globalThis.__recursionPromptPacketProofEvents.slice()
      : [];
    const installed = events.filter((event) => event && event.cleared === false);
    const cleared = events.filter((event) => event && event.cleared === true);
    const byKey = Object.fromEntries(installed.map((event) => [event.key, event]));
    const packetText = String(document.querySelector('[data-recursion-prompt-packet]')?.textContent || '').trim();
    let packet = null;
    try {
      packet = packetText ? JSON.parse(packetText) : null;
    } catch {
      packet = null;
    }
    const runtimeView = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const runtimePacket = runtimeView.lastPacket || null;
    return {
      events,
      installedKeys: [...new Set(installed.map((event) => event.key))],
      clearedKeys: [...new Set(cleared.map((event) => event.key))],
      guidance: byKey['recursion.guidance']?.text || '',
      cardEvidence: byKey['recursion.cardEvidence']?.text || '',
      guardrails: byKey['recursion.guardrails']?.text || '',
      packet: packet ? {
        packetId: String(packet.packetId || ''),
        handId: String(packet.handId || ''),
        storyForm: packet.storyForm || runtimePacket?.storyForm || null,
        selectedCardRefs: Array.isArray(packet.selectedCardRefs) ? packet.selectedCardRefs : [],
        diagnostics: packet.diagnostics || runtimePacket?.diagnostics || {},
        pipelineMode: String(packet.pipelineMode || '')
      } : null,
      runtimePacketStoryForm: runtimePacket?.storyForm || null,
      lastPlanStoryForm: runtimeView.lastPlan?.storyForm || null,
      providerRequests: Array.isArray(globalThis.__recursionProviderRequestProofEvents)
        ? globalThis.__recursionProviderRequestProofEvents.slice()
        : [],
      handText: String(document.querySelector('[data-recursion-hand-count]')?.textContent || ''),
      statusText: String(document.querySelector('[data-recursion-status]')?.textContent || ''),
      ribbonText: String(document.querySelector('[data-recursion-ribbon-label]')?.textContent || ''),
      runtimeView: globalThis.__recursionLiveHarnessRuntime?.view?.() || null
    };
  };
}

async function warmRapidDeck(page, timeoutMs) {
  await page.evaluate(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const seed = String(globalThis.__recursionStoryFormProofMarker || '');
    if (!Array.isArray(context.chat) || !context.chat.some((message) => message?.is_user === false && String(message?.mes || '').includes(seed))) {
      throw new Error('story form proof seed unavailable for Rapid warm');
    }
    const eventSource = context.eventSource || globalThis.eventSource;
    const payload = { source: 'recursion-prompt-packet-proof-rapid-warm' };
    if (typeof eventSource?.emit === 'function') eventSource.emit('generation_ended', payload);
    else if (typeof eventSource?.trigger === 'function') eventSource.trigger('generation_ended', payload);
    else if (typeof eventSource?.dispatchEvent === 'function') eventSource.dispatchEvent(new CustomEvent('generation_ended', { detail: payload }));
    else throw new Error('generation_ended event source unavailable');
  });
  await page.waitForFunction(() => {
    const text = [
      String(document.querySelector('[data-recursion-current-step]')?.textContent || ''),
      String(document.querySelector('[data-recursion-ribbon-label]')?.textContent || ''),
      String(document.querySelector('#recursion-root')?.textContent || '')
    ].join(' ');
    if (/Rapid deck stale\./i.test(text)) throw new Error('Rapid deck stale.');
    return /Rapid deck ready\./i.test(text);
  }, null, { timeout: timeoutMs });
}

async function emitGenerationStopped(page, timeoutMs) {
  await page.evaluate(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const eventSource = context.eventSource || globalThis.eventSource;
    const payload = { source: 'recursion-prompt-packet-proof' };
    if (typeof eventSource?.emit === 'function') eventSource.emit('generation_stopped', payload);
    else if (typeof eventSource?.trigger === 'function') eventSource.trigger('generation_stopped', payload);
    else if (typeof eventSource?.dispatchEvent === 'function') eventSource.dispatchEvent(new CustomEvent('generation_stopped', { detail: payload }));
    else throw new Error('generation_stopped event source unavailable');
  });
  await page.waitForFunction(() => {
    const events = Array.isArray(globalThis.__recursionPromptPacketProofEvents)
      ? globalThis.__recursionPromptPacketProofEvents
      : [];
    return ['recursion.guidance', 'recursion.cardEvidence', 'recursion.guardrails']
      .every((key) => events.some((event) => event.key === key && event.cleared === true));
  }, null, { timeout: timeoutMs });
}

function assertPacketState(state, { afterStop = false, pipeline = 'standard' } = {}) {
  const requiredKeys = ['recursion.guidance', 'recursion.cardEvidence', 'recursion.guardrails'];
  for (const key of requiredKeys) {
    if (!state.installedKeys.includes(key)) fail('prompt-key-missing', `Missing installed prompt key ${key}.`, { state });
  }
  if (!state.packet?.packetId || !state.packet?.handId || !state.packet.selectedCardRefs.length) {
    fail('prompt-packet-metadata-missing', 'Prompt packet metadata was not visible.', { state });
  }
  const diagnostics = state.packet?.diagnostics || {};
  if (pipeline === 'rapid') {
    if (diagnostics.pipelineMode !== 'rapid' || diagnostics.rapidPath !== 'warm-v2') {
      fail('rapid-warm-v2-missing', 'Rapid packet did not expose warm-v2 diagnostics.', { diagnostics, state });
    }
  } else if (pipeline === 'fused') {
    if (diagnostics.pipelineMode !== 'fused') {
      fail('fused-pipeline-diagnostics-missing', 'Fused packet did not expose Fused diagnostics.', { diagnostics, state });
    }
  } else if (diagnostics.pipelineMode && diagnostics.pipelineMode !== 'standard') {
    fail('standard-pipeline-diagnostics-mismatch', 'Standard packet diagnostics did not report standard pipeline.', { diagnostics, state });
  }
  if (!/Private Recursion guidance for the next assistant message\./.test(state.guidance)) {
    fail('guidance-framing-missing', 'Guidance block did not include private response framing.', { guidance: state.guidance });
  }
  const storyForm = state.packet?.storyForm || {};
  const planStoryForm = state.lastPlanStoryForm || {};
  if (storyForm.tense !== EXPECTED_STORY_FORM.tense || storyForm.pov !== EXPECTED_STORY_FORM.pov) {
    fail('packet-story-form-mismatch', 'Prompt packet did not carry expected story form.', { storyForm, expected: EXPECTED_STORY_FORM });
  }
  if (planStoryForm.tense !== EXPECTED_STORY_FORM.tense || planStoryForm.pov !== EXPECTED_STORY_FORM.pov) {
    fail('arbiter-story-form-mismatch', 'Arbiter plan did not capture expected story form.', { planStoryForm, expected: EXPECTED_STORY_FORM });
  }
  if (diagnostics.storyFormTense !== EXPECTED_STORY_FORM.tense || diagnostics.storyFormPov !== EXPECTED_STORY_FORM.pov) {
    fail('diagnostic-story-form-missing', 'Prompt diagnostics did not expose expected story form.', { diagnostics });
  }
  if (!/Write the next reply in past tense, third-person-limited POV\./.test(state.guidance)) {
    fail('guidance-output-shape-missing', 'Guidance block did not instruct expected story form.', { guidance: state.guidance });
  }
  if (/Write the next reply as normal story prose\/dialogue\./.test(state.guidance)) {
    fail('generic-guidance-output-shape-leaked', 'Guidance block still used the old generic story output instruction.', { guidance: state.guidance });
  }
  if (!/Private Recursion card evidence for the next assistant message\./.test(state.cardEvidence)) {
    fail('card-evidence-framing-missing', 'Card evidence block did not include private response framing.', { cardEvidence: state.cardEvidence });
  }
  if (!/Use these cards silently as evidence\./.test(state.cardEvidence)) {
    fail('card-evidence-silent-use-missing', 'Card evidence block did not instruct silent use.', { cardEvidence: state.cardEvidence });
  }
  if (!/- \[[^\]]+\] .{20,}/.test(state.cardEvidence)) {
    fail('raw-card-evidence-missing', 'Card evidence block did not include raw selected card text.', { cardEvidence: state.cardEvidence });
  }
  if (!/Write only the next assistant message; keep Recursion cards, labels, and guidance invisible\./.test(state.guardrails)) {
    fail('guardrail-output-boundary-missing', 'Guardrails did not keep Recursion internals out of output.', { guardrails: state.guardrails });
  }
  const serialized = `${state.guidance}\n${state.cardEvidence}\n${state.guardrails}`;
  if (/Scene brief:|Turn brief:|conditionedSceneBrief|rapidFastStartPack/.test(serialized)) {
    fail('legacy-brief-text-leaked', 'Legacy brief or fast-start text leaked into prompt blocks.', { serialized });
  }
  if (/recursion\.utilityArbiter\.v1|recursion\.card\.v1|recursion\.cardBundle\.v1|Story form contract for card promptText:|Output contract:/.test(serialized)) {
    fail('internal-provider-prompt-leaked', 'Internal provider prompt text leaked into installed prompt blocks.', { serialized });
  }
  const requests = Array.isArray(state.providerRequests) ? state.providerRequests : [];
  if (pipeline === 'rapid') {
    const rapid = requests.find((request) => request.role === 'rapidTurnDelta');
    if (rapid && (!rapid.hasStoryFormJson || !rapid.hasStoryFormInstruction)) {
      fail('rapid-story-form-request-missing', 'Rapid foreground request did not include expected story-form instruction.', { requests });
    }
  } else {
    const arbiter = requests.find((request) => request.role === 'utilityArbiter');
    if (!arbiter?.hasStoryFormSchema || !arbiter?.hasStoryFormJson || !arbiter?.hasArbiterStoryPriority) {
      fail('arbiter-story-form-request-missing', 'Arbiter provider request did not include story-form detection contract.', { requests });
    }
    if (pipeline === 'fused') {
      const fusedBundle = requests.find((request) => request.role === 'fusedCardBundle');
      if (!fusedBundle?.hasCardStoryBlock || !fusedBundle?.hasTargetTense || !fusedBundle?.hasTargetPov) {
        fail('fused-card-bundle-story-form-request-missing', 'Fused card bundle request did not include expected story-form block.', { requests, diagnostics });
      }
      if (requests.some((request) => request.role === 'card')) {
        fail('fused-individual-card-request-observed', 'Fused proof made individual card requests instead of one bundle request.', { requests, diagnostics });
      }
    } else {
      const card = requests.find((request) => request.role === 'card');
      if (!card?.hasCardStoryBlock || !card?.hasTargetTense || !card?.hasTargetPov) {
        fail('card-story-form-request-missing', 'Card provider request did not include expected story-form block.', { requests });
      }
    }
    const guidance = requests.find((request) => request.role === 'guidanceComposer' || request.role === 'reasonerComposer');
    if (!guidance?.hasStoryFormJson || !guidance?.hasStoryFormInstruction) {
      fail('guidance-story-form-request-missing', 'Guidance composer request did not include expected story-form instruction.', { requests });
    }
  }
  if (afterStop) {
    for (const key of requiredKeys) {
      if (!state.clearedKeys.includes(key)) fail('prompt-clear-missing', `Prompt key ${key} was not cleared after generation stop.`, { state });
    }
    if (!/\bHand\s+[1-9]\d*/i.test(state.handText)) {
      fail('last-brief-lost-after-stop', 'Last Brief hand was not preserved after generation stop.', { state });
    }
  }
}

export async function runLivePromptPacketProof({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  const user = assertPreflight(args, env);
  const providerProfile = args.providerProfile || String(env.RECURSION_LIVE_PROVIDER_PROFILE || '').trim();
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const headless = env.RECURSION_SILLYTAVERN_HEADLESS !== '0';
  const session = createSillyTavernHttpSession({
    baseUrl: env.SILLYTAVERN_BASE_URL,
    user,
    password: passwordForUser(user, env)
  });
  await session.init();
  await session.login();
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext();
    await context.addCookies(session.playwrightCookies());
    const page = await context.newPage();
    await page.goto(env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForRoot(page, timeoutMs);
    await page.evaluate(installRawPromptRecorderScript());
    await page.evaluate(installProviderRequestRecorderScript());
    await setPower(page, true, timeoutMs);
    await selectPipeline(page, args.pipeline, timeoutMs);
    await selectMode(page, 'auto', timeoutMs);
    await forcePipelineSetting(page, args.pipeline, timeoutMs);
    const providerProfileResult = await forceProviderProfile(page, providerProfile, timeoutMs);
    await seedStoryFormScene(page, timeoutMs);
    if (args.pipeline === 'rapid') await warmRapidDeck(page, timeoutMs);
    const message = `Recursion ${args.pipeline} prompt packet proof ${Date.now().toString(36)}: keep the archive door scene coherent.`;
    const previousPacketId = await page.evaluate(() => {
      const packetText = String(document.querySelector('[data-recursion-prompt-packet]')?.textContent || '').trim();
      if (Array.isArray(globalThis.__recursionPromptPacketProofEvents)) globalThis.__recursionPromptPacketProofEvents.length = 0;
      else globalThis.__recursionPromptPacketProofEvents = [];
    if (Array.isArray(globalThis.__recursionProviderRequestProofEvents)) globalThis.__recursionProviderRequestProofEvents.length = 0;
      else globalThis.__recursionProviderRequestProofEvents = [];
      try {
        return packetText ? String(JSON.parse(packetText)?.packetId || '') : '';
      } catch {
        return '';
      }
    });
    if (args.pipeline === 'fused') {
      await page.evaluate(async () => {
        const runtime = globalThis.__recursionLiveHarnessRuntime;
        if (typeof runtime?.requestFreshNextGeneration === 'function') {
          await runtime.requestFreshNextGeneration({ source: 'prompt-packet-proof' });
        }
      });
    }
    await page.evaluate(directPrepareScript(), message);
    await page.waitForFunction((stalePacketId) => {
      const state = (() => {
        const events = Array.isArray(globalThis.__recursionPromptPacketProofEvents)
          ? globalThis.__recursionPromptPacketProofEvents
          : [];
        const keys = new Set(events.filter((event) => event.cleared === false).map((event) => event.key));
        const packetText = String(document.querySelector('[data-recursion-prompt-packet]')?.textContent || '').trim();
        let packet = null;
        try {
          packet = packetText ? JSON.parse(packetText) : null;
        } catch {
          packet = null;
        }
        return { keys, packet };
      })();
      return ['recursion.guidance', 'recursion.cardEvidence', 'recursion.guardrails'].every((key) => state.keys.has(key))
        && Boolean(state.packet?.packetId && state.packet.packetId !== stalePacketId && state.packet?.handId && Array.isArray(state.packet?.selectedCardRefs) && state.packet.selectedCardRefs.length);
    }, previousPacketId, { timeout: timeoutMs });
    const beforeStop = await page.evaluate(readProofStateScript());
    assertPacketState(beforeStop, { pipeline: args.pipeline });
    await emitGenerationStopped(page, timeoutMs);
    const afterStop = await page.evaluate(readProofStateScript());
    assertPacketState(afterStop, { afterStop: true, pipeline: args.pipeline });
    return {
      status: 'pass',
      result: 'live-prompt-packet-proof-pass',
      pipeline: args.pipeline,
      user,
      packetId: beforeStop.packet.packetId,
      selectedCardCount: beforeStop.packet.selectedCardRefs.length,
      installedKeys: beforeStop.installedKeys,
      clearedKeys: afterStop.clearedKeys,
      storyForm: beforeStop.packet.storyForm,
      providerRequestRoles: [...new Set(beforeStop.providerRequests.map((request) => request.role))],
      providerProfile: providerProfileResult?.selected || null,
      textLengths: {
        guidance: beforeStop.guidance.length,
        cardEvidence: beforeStop.cardEvidence.length,
        guardrails: beforeStop.guardrails.length
      },
      diagnostics: beforeStop.packet.diagnostics
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runLivePromptPacketProof();
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      status: error?.result === 'dry-run' ? 'skipped' : 'fail',
      result: error?.result || 'live-prompt-packet-proof-failed',
      error: String(error?.message || error),
      details: error?.details || null
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'skipped' ? 0 : 1;
  }
}
