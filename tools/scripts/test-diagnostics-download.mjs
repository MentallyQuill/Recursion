import assert from 'node:assert/strict';
import { downloadDiagnostics } from '../../src/ui/diagnostics-download.mjs';

const originalDocument = globalThis.document;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const originalTimeout = globalThis.setTimeout;
const blobs = [];
const revoked = [];
const cleanup = [];
let clicked = false;
let removed = false;
const anchor = { click() { clicked = true; }, remove() { removed = true; } };
try {
  globalThis.document = { createElement: () => anchor, body: { appendChild() {} } };
  URL.createObjectURL = blob => { blobs.push(blob); return 'blob:diagnostics'; };
  URL.revokeObjectURL = url => revoked.push(url);
  globalThis.setTimeout = callback => { cleanup.push(callback); return 0; };
  const payload = { schema: 'recursion.diagnostics.v1', createdAt: '2026-09-21T12:00:00.000Z', detail: 'x'.repeat(7000) };
  downloadDiagnostics(payload);
  assert.equal(clicked, true);
  assert.equal(removed, true);
  assert.match(anchor.download, /^recursion-diagnostics-.*\.json$/);
  assert.equal(anchor.href, 'blob:diagnostics');
  assert.equal(blobs[0].type, 'application/json;charset=utf-8');
  assert.deepEqual(JSON.parse(await blobs[0].text()), payload);
  assert.equal(revoked.length, 0, 'download URL remains available until browser can consume it');
  cleanup.forEach(callback => callback());
  assert.deepEqual(revoked, ['blob:diagnostics']);
} finally {
  globalThis.document = originalDocument;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  globalThis.setTimeout = originalTimeout;
}
console.log('[pass] diagnostics JSON download');
