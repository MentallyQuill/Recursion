import assert from 'node:assert/strict';
import { failureFrom } from '../../src/failures.mjs';
import { createStorageRepository } from '../../src/storage.mjs';
import { installPrompt, installJournalDetails, installSummary } from '../../src/runtime/prompt-install.mjs';
import { progressFromExecution } from '../../src/progress.mjs';

// Journal normalizes a compact provider token-limit cause.
{
  const repo = createStorageRepository();
  const entry = await repo.appendJournal('failure-test', {
    event: 'provider.call.failed', severity: 'error',
    details: { compactError: { code: 'RECURSION_PROVIDER_TOKEN_LIMIT', message: 'Output ended at its limit.' } }
  });
  assert.equal(entry.details.failure.category, 'provider-length');
  assert.equal(entry.details.failure.stage, entry.event.replaceAll('.', '-'));
}

// Stale prompt install retains its cause through summary and journal.
{
  const stale = { ok: false, installed: false, settled: true, failureClass: 'host-source-stale', continuePrimaryGeneration: false };
  const install = await installPrompt({ prompt: { install: async () => stale } }, {});
  assert.equal(install.failureClass, 'host-source-stale');
  assert.equal(install.installed, false);
  assert.equal(install.continuePrimaryGeneration, false);
  assert.match(installSummary(stale), /Chat changed/);
  const repo = createStorageRepository();
  const entry = await repo.appendJournal('failure-test', {
    event: 'prompt.install_failed', severity: 'warn', details: installJournalDetails(stale)
  });
  assert.equal(entry.details.failure.code, 'RECURSION_HOST_SOURCE_STALE');
  assert.equal(entry.details.failure.category, 'stale-state');
}

// Journal accepts direct failure fields.
{
  const entry = await createStorageRepository().appendJournal('failure-test', {
    event: 'prompt.install_failed', severity: 'warn', details: {
      code: 'RECURSION_PROMPT_INSTALL_FAILED', category: 'prompt-install', message: 'Host rejected the prompt.'
    }
  });
  assert.equal(entry.details.failure.code, 'RECURSION_PROMPT_INSTALL_FAILED');
  assert.equal(entry.details.failure.message, 'Host rejected the prompt.');
}

// Guidance fallback is visible as attention with a neutral stage label.
{
  const progress = progressFromExecution({ operationId: 'guidance-run', state: 'completed', stages: [
    { id: 'preprocess.guidance', state: 'completed', providerLane: 'utility', summary: { status: 'fallback-raw-only' } }
  ] });
  assert.equal(progress.steps[0].label, 'Guidance');
  assert.equal(progress.steps[0].state, 'warning');
  assert.match(progress.steps[0].reason, /raw card evidence/);
  assert.equal(progress.title, 'Needs attention');
}

{
  const failure = failureFrom({ code: 'RECURSION_PROVIDER_CONTEXT_LIMIT', message: 'maximum context length exceeded' });
  assert.equal(failure.code, 'RECURSION_PROVIDER_CONTEXT_LIMIT');
  assert.equal(failure.category, 'provider-request');
  assert.match(failure.suggestedAction, /Reduce/);
  assert.doesNotMatch(failure.suggestedAction, /Increase/);
}

{
  const message = 'Provider settings changed in another view. Refresh and try again.';
  const failure = failureFrom({ code: 'RECURSION_PROVIDER_CONFIG_STALE', message });
  assert.equal(failure.message, message);
  assert.equal(failure.category, 'stale-state');
}

console.log('[pass] failure reporting');
