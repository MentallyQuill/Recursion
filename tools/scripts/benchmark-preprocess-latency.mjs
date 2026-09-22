import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSillyTavernHttpSession, validateSoakUserHandle } from './lib/sillytavern-live-harness.mjs';
import { configureSoakDeckFixture, sendAndWait } from './prove-live-pipelines.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = resolve(repo, 'artifacts', process.argv.includes('--reasoning-off') ? 'latency-benchmark-reasoning-off' : 'latency-benchmark');
const user = process.env.RECURSION_SILLYTAVERN_USER;
const baseUrl = process.env.SILLYTAVERN_BASE_URL;
if (!process.argv.includes('--live') || !validateSoakUserHandle(user).ok || !baseUrl) {
  throw new Error('Use --live with SILLYTAVERN_BASE_URL and a dedicated RECURSION_SILLYTAVERN_USER (recursion-soak-*).');
}
const session = createSillyTavernHttpSession({ baseUrl, user, password: process.env.RECURSION_SILLYTAVERN_PASSWORD || '' });
await session.login();
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addCookies(session.playwrightCookies());
  await context.addInitScript(() => { globalThis.__recursionLiveHarness = true; });
  // Serve only this checkout's extension files in the isolated browser. The
  // running host and every installed extension directory remain untouched.
  await context.route('**/scripts/extensions/third-party/Recursion/**', async (route) => {
    const suffix = decodeURIComponent(new URL(route.request().url()).pathname.split('/third-party/Recursion/')[1] || '');
    const path = resolve(repo, suffix);
    if (relative(repo, path).startsWith('..')) return route.abort();
    try {
      const body = await readFile(path);
      const contentType = ['.js', '.mjs'].includes(extname(path)) ? 'text/javascript'
        : extname(path) === '.css' ? 'text/css' : extname(path) === '.json' ? 'application/json' : undefined;
      await route.fulfill({ status: 200, body, contentType });
    } catch { await route.continue(); }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('response', async (response) => {
    if (response.url().includes('/api/backends/chat-completions/generate') && response.status() >= 400) {
      errors.push(`Primary/provider HTTP ${response.status()}`);
    }
  });
  page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 240)));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(globalThis.__recursionLiveHarnessRuntime), null, { timeout: 30000 });
  await page.locator('#send_textarea').waitFor({ state: 'visible', timeout: 30000 });
  const inspection = await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const view = runtime.view();
    const context = SillyTavern.getContext();
    const secretState = await fetch('/api/secrets/read', { method: 'POST', headers: context.getRequestHeaders() }).then((response) => response.json());
    return { enabled: view.settings.enabled, mode: view.settings.mode,
      configuredCredentialTypes: Object.entries(secretState).filter(([, present]) => present).map(([key]) => key),
      selectedCharacter: context.characterId, chatId: context.chatId,
      characters: (context.characters || []).map((character, index) => ({ index, name: character.name, avatar: character.avatar })),
      profiles: view.providerProfiles,
      providers: Object.fromEntries(Object.entries(view.settings.providers).map(([lane, value]) => [lane, {
        profileId: value.connectionProfileId, maxConcurrentRequests: value.maxConcurrentRequests,
        capability: value.capability, certification: value.certification
      }])), errors: [] };
  });
  inspection.errors = errors;
  await page.screenshot({ path: resolve(output, 'initial-desktop.png') });
  await writeFile(resolve(output, 'inspection.json'), JSON.stringify(inspection, null, 2));
  if (process.argv.includes('--ui')) {
    await page.locator('[data-recursion-options-button]').click();
    const evidence = [];
    for (const [size, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const tab of ['providers', 'advanced']) {
        await page.locator(`[data-recursion-settings-tab="${tab}"]`).click();
        const control = page.locator(tab === 'advanced'
          ? '[data-recursion-setting-request-deadline-seconds]'
          : '[data-recursion-provider-max-concurrent-requests-utility]');
        if (!await control.isVisible()) {
          await page.locator(tab === 'advanced' ? '[data-recursion-settings-section-toggle="execution"]' : '[data-recursion-provider-toggle-utility]').click();
        }
        await control.scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(output, `${size}-${tab}.png`) });
        evidence.push({ size, tab, visible: await control.isVisible(), bounds: await control.boundingBox(),
          viewport: width, panel: await page.locator('[data-recursion-settings-panel]').evaluate((el) => ({ width: el.clientWidth, scrollWidth: el.scrollWidth })) });
      }
    }
    await writeFile(resolve(output, 'ui-evidence.json'), JSON.stringify({ evidence, errors }, null, 2));
    console.log(JSON.stringify({ evidence, errors }, null, 2));
  } else if (process.argv.includes('--inspect')) {
    console.log(JSON.stringify({ ...inspection, profiles: inspection.profiles.filter((profile) => /Provider/.test(profile.name)) }, null, 2));
  } else {
    const profileName = process.env.RECURSION_BENCHMARK_PROFILE || 'nanogpt deepseek/deepseek-v4-flash:thinking - Provider';
    const profile = inspection.profiles.find((entry) => entry.name === profileName);
    if (!profile) throw new Error('Dedicated benchmark profile is unavailable.');
    console.log(`Qualifying ${profile.name}`);
    await page.evaluate(async () => {
      const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
      const original = service.sendRequest;
      globalThis.__latencyTransportErrors = [];
      service.sendRequest = async function (...args) {
        try { return await original.apply(this, args); }
        catch (error) {
          const chain = [];
          for (let item = error; item && chain.length < 4; item = item.cause) chain.push(String(item.message || ''));
          let message = chain.join(' | ').replace(/\b(?:sk-[\w-]+|Bearer\s+\S+)/gi, '[redacted]');
          for (const entry of args[1] || []) if (typeof entry.content === 'string') message = message.replaceAll(entry.content, '[request]');
          globalThis.__latencyTransportErrors.push({ name: error?.name, code: error?.code, message: message.slice(0, 240) });
          throw error;
        }
      };
    });
    const qualify = async (concurrency) => page.evaluate(async ({ profileId, concurrency }) => {
      const runtime = globalThis.__recursionLiveHarnessRuntime;
      await runtime.updateProviderConfig('utility', { connectionProfileId: profileId, maxConcurrentRequests: concurrency, outputTokenCeiling: 16000 });
      const result = await runtime.testProvider('utility');
      return { ok: result.ok, provider: runtime.view().settings.providers.utility, transportErrors: globalThis.__latencyTransportErrors };
    }, { profileId: profile.id, concurrency });
    if (process.argv.includes('--certify')) {
      const qualification = await qualify(2);
      await writeFile(resolve(output, 'qualification.json'), JSON.stringify(qualification, null, 2));
      console.log(JSON.stringify(qualification));
      if (!qualification.ok) process.exitCode = 1;
    } else {
      const families = ['Scene Frame', 'Scene Constraints', 'Active Cast', 'Character Motivation', 'Environment', 'Open Threads'];
      const decks = configureSoakDeckFixture(await page.evaluate(() => globalThis.__recursionLiveHarnessRuntime.view().settings.preProcessDecks), { mode: 'manual', families });
      await page.evaluate(async ({ decks, profileName }) => {
        const runtime = globalThis.__recursionLiveHarnessRuntime;
        await runtime.updateSettings({ enabled: true, mode: 'manual', minCards: 6, maxCards: 6,
          reasoningLevel: 'medium', preProcessDecks: decks, postProcess: { enabled: false } });
        const context = SillyTavern.getContext();
        await context.selectCharacterById(0);
        await context.executeSlashCommandsWithOptions('/profile <None>');
        await context.executeSlashCommandsWithOptions(`/profile await=true timeout=10000 ${profileName}`);
      }, { decks, profileName });
      await page.locator('#model_nanogpt_select').selectOption(profile.model, { force: true });
      const primarySetup = await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        return { source: oai_settings.chat_completion_source, model: oai_settings.nanogpt_model, streaming: oai_settings.stream_openai };
      });
      console.log(JSON.stringify({ primarySetup }));
      const report = process.argv.includes('--resume')
        ? JSON.parse(await readFile(resolve(output, 'results.json'), 'utf8'))
        : { profile: { model: profile.model, name: profile.name }, families, qualification: [], samples: [],
          order: 'Three identical-source samples per arm; arms grouped to avoid repeated qualification calls.' };
      const persist = () => writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
      const arms = [{ mode: 'segmented', concurrency: 1 }, { mode: 'segmented', concurrency: 2 }, { mode: 'fused', concurrency: 2 }];
      for (const arm of arms.filter((arm) => !process.argv.includes('--reasoning-off') || arm.concurrency === 2)) {
        const completed = report.samples.filter((sample) => sample.mode === arm.mode && sample.concurrency === arm.concurrency).length;
        if (completed >= 3) continue;
        if (arm.mode === 'segmented' || process.argv.includes('--resume')) {
          const qualification = await qualify(arm.concurrency);
          report.qualification.push({ ...arm, ...qualification });
          await persist();
          if (!qualification.ok || qualification.provider.capability.safeConcurrency !== arm.concurrency
              || (arm.concurrency === 2 && !qualification.provider.capability.fusedEligible)) {
            throw new Error('Live qualification failed; failed qualification is recorded, and no benchmark arm was silently substituted.');
          }
        }
        for (let sample = completed + 1; sample <= 3; sample += 1) {
          console.log(`Running ${arm.mode}, concurrency ${arm.concurrency}, sample ${sample}/3`);
          const chatName = `Recursion-Latency-${Date.now()}-${arm.mode}-${sample}`;
          await page.evaluate(async ({ mode, chatName }) => {
            await SillyTavern.getContext().openCharacterChat(chatName);
            await globalThis.__recursionLiveHarnessRuntime.updateSettings({ pipelineMode: mode });
          }, { mode: arm.mode, chatName });
          const message = 'Write one short paragraph, under 100 words, continuing this scene in third-person past tense. Mara and Ivo stood outside a locked observatory. Mara held a brass key; Ivo carried the star chart. Rain was rising and their lantern had ten minutes of oil. Mara wanted to inspect the telescope before dawn, while Ivo worried about leaving wet footprints. Mara tried the key and asked Ivo to keep watch. Preserve these visible facts and do not decide what Ivo secretly knows.';
          const started = Date.now();
          let failure = null;
          try { await sendAndWait(page, message, { requirePrompt: true, timeoutMs: 420000 }); }
          catch (error) { failure = String(error.message).slice(0, 240); }
          const result = await page.evaluate(async () => {
            const runtime = globalThis.__recursionLiveHarnessRuntime;
            const view = runtime.view();
            const chatKey = view.execution?.chatKey;
            const journal = chatKey ? await runtime.storage.loadRunJournal(chatKey) : null;
            return { timing: view.turnTiming, decision: view.execution?.pipelineDecision,
              budget: view.execution?.recoveryBudget,
              stages: (view.execution?.stages || []).map(({ stageId, state, attempts, timings, failure }) => ({ stageId, state, attempts, timings, failure })),
              cards: (view.lastHand?.cards || []).map(({ family, evidenceRefs, promptText }) => ({ family, evidenceRefs, promptText })),
              promptInstalled: Boolean(view.lastPacket),
              providerCalls: (journal?.entries || []).filter((entry) => ['provider.call.completed', 'provider.call.failed'].includes(entry.event)).map((entry) => entry.details) };
          });
          const sampleResult = { ...arm, sample, elapsedMs: Date.now() - started, failure, ...result };
          sampleResult.accepted = !failure && result.promptInstalled && result.decision?.effectiveMode === arm.mode
            && result.stages.some((stage) => stage.stageId === (arm.mode === 'fused' ? 'preprocess.cards.fused' : 'preprocess.cards.segmented.scene-frame') && stage.state === 'completed')
            && families.every((family) => result.cards.some((card) => card.family === family));
          report.samples.push(sampleResult);
          await persist();
          console.log(JSON.stringify({ mode: arm.mode, sample, accepted: sampleResult.accepted, timing: result.timing, failure }));
          if (!sampleResult.accepted) console.warn('Sample failed acceptance; retained in the comparison, not counted as a quality-preserving speedup.');
        }
      }
    }
  }
} finally { await browser.close(); }
