import { compact, redact, truncate } from '../core.mjs';
import { asObject } from '../safe-values.mjs';

const SECRET_TEXT_PATTERN = /(private[-_\s]*secret|\bsk-[a-z0-9_-]+|\bbearer\s+[a-z0-9._-]+)/ig;

function safeTextSource(value, limit = 700) {
  const redacted = redact(value, { maxString: limit });
  if (redacted === undefined || redacted === null) return '';
  if (['string', 'number', 'boolean', 'bigint'].includes(typeof redacted)) return String(redacted);
  try {
    return JSON.stringify(redacted);
  } catch {
    return '';
  }
}

function safeText(value, limit = 700) {
  return truncate(compact(safeTextSource(value, limit).replace(SECRET_TEXT_PATTERN, '[redacted]'), limit), limit);
}

export function sanitizePromptError(error, fallbackCode, fallbackMessage) {
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

export async function installPrompt(host, packet) {
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

export function installSummary(install) {
  if (install?.ok !== false) return 'Prompt installed';
  return safeText(install.error?.message || install.error?.code || 'Prompt install failed', 300);
}

export function installJournalDetails(install) {
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

export async function clearPromptBestEffort(host) {
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

export function clearWarningDetails(clear) {
  return {
    code: safeText(clear?.error?.code || 'RECURSION_PROMPT_CLEAR_FAILED', 120),
    message: safeText(clear?.error?.message || 'Prompt clear failed.', 240)
  };
}

export function clearJournalSummary(clear) {
  if (clear?.ok !== false) return 'Prompt cleared';
  return 'Prompt clear failed';
}

export function clearJournalDetails(clear, reason) {
  const ok = clear?.ok !== false;
  const details = {
    status: ok ? 'cleared' : 'failed'
  };
  const safeReason = safeText(reason || '', 120);
  if (safeReason) details.reason = safeReason;
  if (clear?.cleared !== undefined) details.cleared = Boolean(clear.cleared);
  if (!ok) {
    details.code = promptClearJournalCode(clear);
  }
  return details;
}

function promptClearJournalCode(clear) {
  const code = safeText(clear?.error?.code || '', 120);
  if (code === 'RECURSION_PROMPT_CLEAR_UNAVAILABLE') return code;
  return 'RECURSION_PROMPT_CLEAR_FAILED';
}
