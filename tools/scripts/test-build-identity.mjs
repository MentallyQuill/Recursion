import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { productionTreeIdentity } from './lib/production-build.mjs';
import * as staging from './prepare-recursion-install.mjs';
import { verifyInstalledCopies } from './verify-installed-copy.mjs';
import { createRecursionRuntime } from '../../src/runtime.mjs';
import * as buildIdentity from '../../src/runtime/build-identity.mjs';
const { normalizeBuildIdentity } = buildIdentity;

const fixture = mkdtempSync(join(tmpdir(), 'recursion-build-'));
function write(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
function tree(name, newline = '\n') {
  const root = join(fixture, name);
  write(root, 'package.json', `{"version":"0.3.0-beta.1"}${newline}`);
  write(root, 'manifest.json', `{"key":"recursion"}${newline}`);
  write(root, 'src/runtime.mjs', `export const value = 1;${newline}`);
  return root;
}
try {
  const lf = tree('lf');
  const crlf = tree('crlf', '\r\n');
  assert.equal(productionTreeIdentity(lf).productionHash, productionTreeIdentity(crlf).productionHash,
    'same text code has the same fingerprint across line endings');
  write(crlf, 'src/runtime.mjs', '\uFEFFexport const value = 1;\r\n');
  assert.equal(productionTreeIdentity(lf).productionHash, productionTreeIdentity(crlf).productionHash);
  const original = productionTreeIdentity(lf).productionHash;
  write(lf, 'docs/private.md', 'ignored');
  write(lf, 'node_modules/dependency.js', 'ignored');
  write(lf, 'build-info.json', '{"productionHash":"ignored"}');
  assert.equal(productionTreeIdentity(lf).productionHash, original);
  write(lf, 'src/runtime.mjs', 'export const value = 2;\n');
  assert.notEqual(productionTreeIdentity(lf).productionHash, original);
  write(lf, 'assets/icons/data.bin', Buffer.from([0, 255, 13, 10]));
  const binary = productionTreeIdentity(lf).productionHash;
  write(lf, 'assets/icons/data.bin', Buffer.from([0, 255, 10]));
  assert.notEqual(productionTreeIdentity(lf).productionHash, binary);
  const linked = join(fixture, 'linked');
  write(linked, 'package.json', '{}');
  write(linked, 'manifest.json', '{}');
  symlinkSync(join(lf, 'src'), join(linked, 'src'), 'junction');
  assert.throws(() => productionTreeIdentity(linked), /symbolic link/,
    'a symlink at the production-tree root cannot bypass inventory checks');
  const valid = { schema: 'recursion.buildInfo.v1', version: '0.3.0-beta.1',
    sourceRevision: 'a'.repeat(40), dirty: false, productionHash: original,
    createdAt: '2026-10-07T12:00:00.000Z', secret: 'PRIVATE_CANARY' };
  const declared = normalizeBuildIdentity(valid);
  assert.equal(declared.status, 'declared');
  assert(Object.isFrozen(declared));
  assert.equal(declared.secret, undefined);
  assert.equal(valid.status, undefined);
  for (const invalid of [null, {}, {...valid, sourceRevision:'main'}, {...valid, productionHash:'fake'},
    {...valid, dirty:'false'}, {...valid, createdAt:'yesterday'}, {...valid, schema:'wrong'}]) {
    assert.equal(normalizeBuildIdentity(invalid).status, 'unavailable');
  }
  assert.equal(typeof buildIdentity.createBuildIdentityReader, 'function', 'bounded metadata reader exists');
  let loads = 0;
  const reader = buildIdentity.createBuildIdentityReader({ url: 'https://example.invalid/build-info.json',
    fetchImpl: async () => { loads++; return new Response(JSON.stringify(valid)); } });
  assert.equal(reader.snapshot().status, 'unavailable');
  assert.equal((await reader.load()).productionHash, original);
  await reader.load();
  assert.equal(loads, 1);
  for (const body of ['not JSON', 'x'.repeat(2049), JSON.stringify({...valid, productionHash:'short'})]) {
    const unavailable = buildIdentity.createBuildIdentityReader({ fetchImpl: async () => new Response(body) });
    assert.equal((await unavailable.load()).status, 'unavailable');
  }
  const absent = buildIdentity.createBuildIdentityReader({ fetchImpl: async () => new Response('', {status:404}) });
  assert.equal((await absent.load()).status, 'unavailable');
  const timeout = buildIdentity.createBuildIdentityReader({ timeoutMs:10, fetchImpl: () => new Promise(() => {}) });
  assert.equal((await timeout.load()).status, 'unavailable');
  assert.equal(typeof staging.prepareRecursionInstall, 'function');
  const outputRoot = join(fixture, 'staged');
  const report = staging.prepareRecursionInstall({ repositoryRoot:crlf, outputRoot,
    sourceRevision:valid.sourceRevision, dirty:false, createdAt:valid.createdAt });
  assert.equal(report.build.status, 'declared');
  assert.equal(report.build.productionHash, productionTreeIdentity(outputRoot).productionHash);
  assert.equal(existsSync(join(outputRoot, 'docs')), false, 'staging only copies the production inventory');
  const linkedOutput = join(fixture, 'linked-output');
  symlinkSync(outputRoot, linkedOutput, 'junction');
  assert.throws(() => staging.prepareRecursionInstall({repositoryRoot:crlf, outputRoot:linkedOutput}), /symbolic links/);
  assert.throws(() => staging.prepareRecursionInstall({repositoryRoot:crlf, outputRoot:join(crlf, 'src', 'output')}), /production/);
  assert.throws(() => staging.prepareRecursionInstall({ repositoryRoot:crlf, outputRoot }), /empty/);
  assert.throws(() => staging.prepareRecursionInstall({ repositoryRoot:crlf, outputRoot:crlf }), /repository/);
  assert.equal(verifyInstalledCopies({ repositoryRoot:crlf, installedRoot:outputRoot, accountOnly:true }).ok, true);
  write(outputRoot, 'build-info.json', JSON.stringify({...valid, productionHash:'b'.repeat(64)}));
  const forged = verifyInstalledCopies({ repositoryRoot:crlf, installedRoot:outputRoot, accountOnly:true });
  assert.equal(forged.ok, false, 'matching code with a forged build stamp fails verification');
  assert.equal(forged.differences[0].kind, 'build-info-hash-mismatch');
  const runtime = createRecursionRuntime({ buildIdentity: () => declared });
  const exported = (await runtime.exportDiagnostics()).diagnostics;
  assert.equal(exported.build?.productionHash, original, 'runtime exports its loaded build descriptor');
  assert.equal(exported.build?.status, 'declared', 'runtime cannot claim content verification');
  assert.equal(exported.build?.secret, undefined);
  assert.equal((await createRecursionRuntime().exportDiagnostics()).diagnostics.build?.status, 'unavailable');
  console.log('[pass] build identity');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
