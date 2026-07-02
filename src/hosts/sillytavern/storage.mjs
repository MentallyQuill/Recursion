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
    throw new Error(`SillyTavern file ${action} failed for ${fileName}: HTTP ${response?.status ?? 'unknown'}`);
  }
}

function serializeStorageJson(value) {
  const jsonText = JSON.stringify(value);
  if (typeof jsonText !== 'string') {
    throw new Error('Recursion storage values must be JSON-serializable.');
  }
  return jsonText;
}

export function createSillyTavernUserFileStorageAdapter({ contextFactory = null, fetchImpl } = {}) {
  if (typeof fetchImpl !== 'function') return createMemoryStorageAdapter();

  const memoryStorage = createMemoryStorageAdapter();
  let fallbackStorage = false;

  async function readMemory(fileName) {
    return memoryStorage.readJson(fileName);
  }

  async function writeMemory(key, fileName, value) {
    await memoryStorage.writeJson(fileName, value);
    return { ok: true, key, fallback: 'memory' };
  }

  async function deleteMemory(key, fileName) {
    await memoryStorage.deleteJson(fileName);
    return { ok: true, key, fallback: 'memory' };
  }

  function downgradeToMemory() {
    fallbackStorage = true;
  }

  return {
    async readJson(key) {
      const fileName = validateStorageFileName(key);
      if (fallbackStorage) return readMemory(fileName);
      try {
        const response = await fetchImpl(`/user/files/${encodeURIComponent(fileName)}`, { method: 'GET' });
        if (response?.status === 404) return null;
        assertOk(response, 'read', fileName);
        return parseJsonResponse(response);
      } catch {
        downgradeToMemory();
        return readMemory(fileName);
      }
    },
    async writeJson(key, value) {
      const fileName = validateStorageFileName(key);
      const jsonText = serializeStorageJson(value);
      if (fallbackStorage) return writeMemory(key, fileName, value);
      const context = currentContext(contextFactory);
      try {
        const response = await fetchImpl('/api/files/upload', {
          method: 'POST',
          headers: await requestHeaders(context),
          body: JSON.stringify({ name: fileName, data: encodeBase64Utf8(jsonText) })
        });
        assertOk(response, 'write', fileName);
        return { ok: true, key };
      } catch {
        downgradeToMemory();
        return writeMemory(key, fileName, value);
      }
    },
    async deleteJson(key) {
      const fileName = validateStorageFileName(key);
      if (fallbackStorage) return deleteMemory(key, fileName);
      const context = currentContext(contextFactory);
      try {
        const response = await fetchImpl('/api/files/delete', {
          method: 'POST',
          headers: await requestHeaders(context),
          body: JSON.stringify({ path: `/user/files/${fileName}` })
        });
        if (response?.status === 404) return { ok: true, key, missing: true };
        assertOk(response, 'delete', fileName);
        return { ok: true, key };
      } catch {
        downgradeToMemory();
        return deleteMemory(key, fileName);
      }
    }
  };
}
