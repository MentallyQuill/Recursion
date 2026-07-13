import { createMemoryStorageAdapter } from '../../storage.mjs';

function stringValue(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function currentContext(contextFactory) {
  if (typeof contextFactory === 'function') {
    const context = contextFactory();
    return context && typeof context === 'object' ? context : {};
  }
  if (typeof globalThis.SillyTavern?.getContext === 'function') {
    const context = globalThis.SillyTavern.getContext();
    return context && typeof context === 'object' ? context : {};
  }
  if (typeof globalThis.getContext === 'function') {
    const context = globalThis.getContext();
    return context && typeof context === 'object' ? context : {};
  }
  return {};
}

function encodeBase64Utf8(text) {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64');
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function validateStorageFileName(key) {
  const source = stringValue(key).trim();
  if (!source) throw new Error('Recursion storage key is required.');
  if (/[\\/]/.test(source) || source.includes('..')) {
    throw new Error(`Recursion storage key rejects path traversal: ${source}`);
  }
  if (!source.endsWith('.json')) {
    throw new Error(`Recursion storage key must end in .json: ${source}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(source)) {
    throw new Error(`Recursion storage key contains unsafe characters: ${source}`);
  }
  return source.startsWith('recursion-') ? source : `recursion-${source}`;
}

async function requestHeaders(context) {
  const base = typeof context.getRequestHeaders === 'function'
    ? { ...(await context.getRequestHeaders()) }
    : {};
  const hasContentType = Object.keys(base).some((key) => key.toLowerCase() === 'content-type');
  if (!hasContentType) base['Content-Type'] = 'application/json';
  return base;
}

async function parseJsonResponse(response) {
  if (typeof response?.json === 'function') return response.json();
  if (typeof response?.text === 'function') {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  return null;
}

function assertOk(response, action, fileName) {
  if (!response?.ok) {
    const error = new Error(`SillyTavern file ${action} failed for ${fileName}: HTTP ${response?.status ?? 'unknown'}`);
    error.status = response?.status;
    throw error;
  }
}

function storageFailure(operation, fileName, error) {
  const status = error?.status ?? error?.response?.status;
  const message = status
    ? `${operation} failed for ${fileName}: HTTP ${status}`
    : `${operation} failed for ${fileName}: ${String(error?.message || 'Unknown storage error').slice(0, 160)}`;
  return {
    operation,
    fileName,
    ...(status === undefined ? {} : { status }),
    message: message.slice(0, 240)
  };
}

function serializeStorageJson(value) {
  const jsonText = JSON.stringify(value);
  if (typeof jsonText !== 'string') {
    throw new Error('Recursion storage values must be JSON-serializable.');
  }
  return jsonText;
}

async function verifyUserFileExists(fetchImpl, context, fileName) {
  const encodedPath = `/user/files/${encodeURIComponent(fileName)}`;
  const plainPath = `/user/files/${fileName}`;
  const response = await fetchImpl('/api/files/verify', {
    method: 'POST',
    headers: await requestHeaders(context),
    body: JSON.stringify({ urls: [encodedPath] })
  });
  if (!response?.ok) return null;
  const result = await parseJsonResponse(response);
  if (!result || typeof result !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(result, encodedPath)) return result[encodedPath] === true;
  if (Object.prototype.hasOwnProperty.call(result, plainPath)) return result[plainPath] === true;
  return null;
}

export function createSillyTavernUserFileStorageAdapter({ contextFactory = null, fetchImpl } = {}) {
  if (typeof fetchImpl !== 'function') return createMemoryStorageAdapter();

  const memoryStorage = createMemoryStorageAdapter();
  let lastFailure = null;

  async function readMemory(fileName) {
    return memoryStorage.readJson(fileName);
  }

  async function writeMemory(key, fileName, value, failure = null) {
    await memoryStorage.writeJson(fileName, value);
    return {
      ok: true,
      key,
      fallback: 'memory',
      reason: 'memory-fallback',
      ...(failure?.message ? { fallbackReason: failure.message } : {})
    };
  }

  async function deleteMemory(key, fileName, failure = null) {
    await memoryStorage.deleteJson(fileName);
    return {
      ok: true,
      key,
      fallback: 'memory',
      reason: 'memory-fallback',
      ...(failure?.message ? { fallbackReason: failure.message } : {})
    };
  }

  return {
    async readJson(key) {
      const fileName = validateStorageFileName(key);
      const context = currentContext(contextFactory);
      try {
        const exists = await verifyUserFileExists(fetchImpl, context, fileName);
        if (exists === false) return null;
        const response = await fetchImpl(`/user/files/${encodeURIComponent(fileName)}`, { method: 'GET' });
        if (response?.status === 404) return null;
        assertOk(response, 'read', fileName);
        const value = await parseJsonResponse(response);
        lastFailure = null;
        return value;
      } catch (error) {
        lastFailure = storageFailure('read', fileName, error);
        return readMemory(fileName);
      }
    },
    async writeJson(key, value) {
      const fileName = validateStorageFileName(key);
      const jsonText = serializeStorageJson(value);
      const context = currentContext(contextFactory);
      let failure = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetchImpl('/api/files/upload', {
            method: 'POST',
            headers: await requestHeaders(context),
            body: JSON.stringify({ name: fileName, data: encodeBase64Utf8(jsonText) })
          });
          assertOk(response, 'write', fileName);
          lastFailure = null;
          return { ok: true, key };
        } catch (error) {
          failure = storageFailure('write', fileName, error);
        }
      }
      lastFailure = failure;
      return writeMemory(key, fileName, value, failure);
    },
    async deleteJson(key) {
      const fileName = validateStorageFileName(key);
      const context = currentContext(contextFactory);
      try {
        const response = await fetchImpl('/api/files/delete', {
          method: 'POST',
          headers: await requestHeaders(context),
          body: JSON.stringify({ path: `/user/files/${fileName}` })
        });
        if (response?.status === 404) return { ok: true, key, missing: true };
        assertOk(response, 'delete', fileName);
        lastFailure = null;
        return { ok: true, key };
      } catch (error) {
        lastFailure = storageFailure('delete', fileName, error);
        return deleteMemory(key, fileName, lastFailure);
      }
    },
    getLastFailure() {
      return lastFailure ? { ...lastFailure } : null;
    }
  };
}
