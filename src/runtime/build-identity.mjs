export const BUILD_INFO_SCHEMA = 'recursion.buildInfo.v1';
export const BUILD_INFO_MAX_CHARACTERS = 2048;
const UNAVAILABLE = Object.freeze({ status: 'unavailable' });

export function normalizeBuildIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schema !== BUILD_INFO_SCHEMA
      || typeof value.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,79}$/.test(value.version)
      || (value.sourceRevision !== null && (typeof value.sourceRevision !== 'string'
        || !/^[a-f0-9]{40}$/.test(value.sourceRevision)))
      || typeof value.dirty !== 'boolean'
      || typeof value.productionHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.productionHash)
      || typeof value.createdAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt)
      || !Number.isFinite(Date.parse(value.createdAt))
      || new Date(value.createdAt).toISOString() !== value.createdAt) return UNAVAILABLE;
  return Object.freeze({ status: 'declared', schema: BUILD_INFO_SCHEMA,
    version: value.version, sourceRevision: value.sourceRevision, dirty: value.dirty,
    productionHash: value.productionHash, createdAt: value.createdAt });
}

async function readBoundedMetadata(response) {
  if (!response?.ok) return UNAVAILABLE;
  let text = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > BUILD_INFO_MAX_CHARACTERS * 4) return UNAVAILABLE;
        text += decoder.decode(value, { stream: true });
        if (text.length > BUILD_INFO_MAX_CHARACTERS) return UNAVAILABLE;
      }
      text += decoder.decode();
    } finally {
      void reader.cancel().catch(() => {});
    }
  } else {
    text = await response.text();
  }
  if (text.length > BUILD_INFO_MAX_CHARACTERS) return UNAVAILABLE;
  return normalizeBuildIdentity(JSON.parse(text));
}

export function createBuildIdentityReader({ fetchImpl = globalThis.fetch, url, timeoutMs = 2000 } = {}) {
  let current = UNAVAILABLE;
  let loading = null;
  return Object.freeze({
    snapshot: () => current,
    load() {
      if (loading) return loading;
      const controller = new AbortController();
      let timer;
      const request = Promise.resolve().then(() => fetchImpl(url, {
        signal: controller.signal, cache: 'no-store', credentials: 'same-origin'
      })).then(readBoundedMetadata).catch(() => UNAVAILABLE);
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(UNAVAILABLE); },
          Math.max(1, Math.min(2000, Number(timeoutMs) || 2000)));
      });
      loading = Promise.race([request, deadline]).then((result) => {
        current = result;
        return current;
      }).finally(() => clearTimeout(timer));
      return loading;
    }
  });
}
