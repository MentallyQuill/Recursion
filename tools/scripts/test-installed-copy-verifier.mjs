import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInstalledCopies } from './verify-installed-copy.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const verifierPath = join(here, 'verify-installed-copy.mjs');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'recursion-installed-copy-'));

function write(root, relativePath, contents) {
  const target = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function createRepository(root) {
  const files = {
    'manifest.json': '{"key":"recursion"}\n',
    'package.json': '{"name":"recursion","type":"module"}\n',
    'src/extension/index.js': 'import "../runtime.mjs";\n',
    'src/runtime.mjs': 'export const runtime = true;\n',
    'src/vendor/runtime/LICENSE.md': 'runtime dependency license\n',
    'styles/recursion.css': '.icon { mask: url("../assets/icons/action.svg"); }\n',
    'assets/icons/action.svg': '<svg></svg>\n'
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    write(root, relativePath, contents);
  }
  write(root, 'src/README.md', 'source documentation is not shipped\n');
  write(root, 'assets/documentation/screenshot.png', 'documentation-only\n');
  write(root, 'tests/not-production.mjs', 'throw new Error("not production");\n');
  write(root, 'debug.log', 'debug data\n');
  return files;
}

function copyProduction(repositoryRoot, targetRoot) {
  for (const relativePath of [
    'manifest.json',
    'package.json',
    'src',
    'styles',
    'assets/icons'
  ]) {
    cpSync(
      join(repositoryRoot, ...relativePath.split('/')),
      join(targetRoot, ...relativePath.split('/')),
      { recursive: true }
    );
  }
}

function makeCopies(caseName) {
  const root = join(fixtureRoot, caseName);
  const repositoryRoot = join(root, 'repository');
  const installedRoot = join(root, 'installed');
  const publicRoot = join(root, 'public');
  createRepository(repositoryRoot);
  copyProduction(repositoryRoot, installedRoot);
  copyProduction(repositoryRoot, publicRoot);
  return { root, repositoryRoot, installedRoot, publicRoot };
}

function simplifiedDifferences(report) {
  return report.differences.map(({ copy, kind, path }) => ({ copy, kind, path }));
}

try {
  {
    const roots = makeCopies('matching');
    write(roots.installedRoot, '.git/objects/ignored', 'not compared\n');
    write(roots.installedRoot, 'artifacts/report.json', 'not compared\n');
    write(roots.installedRoot, 'tmp/debug.mjs', 'not compared\n');
    write(roots.installedRoot, 'debug.log', 'not compared\n');
    const report = verifyInstalledCopies(roots);
    assertEqual(report.ok, true, 'matching production trees pass');
    assertEqual(report.filesCompared, 7, 'all production fixture files are compared');
    assertDeepEqual(report.differences, [], 'matching trees have no differences');
  }

  {
    const roots = makeCopies('missing');
    unlinkSync(join(roots.installedRoot, 'src', 'runtime.mjs'));
    const report = verifyInstalledCopies(roots);
    assertEqual(report.ok, false, 'missing installed file fails');
    assertDeepEqual(
      simplifiedDifferences(report),
      [{ copy: 'installed', kind: 'missing', path: 'src/runtime.mjs' }],
      'missing result identifies the exact relative path'
    );
  }

  {
    const roots = makeCopies('stale');
    write(roots.installedRoot, 'styles/recursion.css', 'stale stylesheet\n');
    const report = verifyInstalledCopies(roots);
    assertDeepEqual(
      simplifiedDifferences(report),
      [{ copy: 'installed', kind: 'content-mismatch', path: 'styles/recursion.css' }],
      'stale result identifies the exact relative path'
    );
  }

  {
    const roots = makeCopies('extra');
    write(roots.installedRoot, 'src/stale-runtime.mjs', 'export const stale = true;\n');
    const report = verifyInstalledCopies(roots);
    assertDeepEqual(
      simplifiedDifferences(report),
      [{ copy: 'installed', kind: 'extra', path: 'src/stale-runtime.mjs' }],
      'extra production file identifies the exact relative path'
    );
  }

  {
    const roots = makeCopies('public-mismatch');
    write(roots.publicRoot, 'assets/icons/action.svg', '<svg>stale</svg>\n');
    const report = verifyInstalledCopies(roots);
    assertDeepEqual(
      simplifiedDifferences(report),
      [{ copy: 'public', kind: 'content-mismatch', path: 'assets/icons/action.svg' }],
      'public mismatch identifies the exact relative path'
    );
  }

  {
    const roots = makeCopies('multiple');
    unlinkSync(join(roots.installedRoot, 'manifest.json'));
    write(roots.installedRoot, 'src/extra.js', 'export {};\n');
    unlinkSync(join(roots.publicRoot, 'package.json'));
    const report = verifyInstalledCopies(roots);
    assertDeepEqual(
      simplifiedDifferences(report),
      [
        { copy: 'installed', kind: 'missing', path: 'manifest.json' },
        { copy: 'installed', kind: 'extra', path: 'src/extra.js' },
        { copy: 'public', kind: 'missing', path: 'package.json' }
      ],
      'multiple failures are deterministic and copy-specific'
    );
  }

  {
    const roots = makeCopies('cli-failure');
    write(roots.publicRoot, 'src/runtime.mjs', 'stale public runtime\n');
    const result = spawnSync(process.execPath, [
      verifierPath,
      '--repo-root', roots.repositoryRoot,
      '--installed-root', roots.installedRoot,
      '--public-root', roots.publicRoot
    ], { encoding: 'utf8' });
    assert(result.status !== 0, 'CLI exits nonzero on mismatch');
    assert(
      `${result.stdout}\n${result.stderr}`.includes('public content-mismatch: src/runtime.mjs'),
      'CLI output identifies the exact public mismatch path'
    );
  }

  {
    const root = join(fixtureRoot, 'user-layout');
    const repositoryRoot = join(root, 'repository');
    const sillyTavernRoot = join(root, 'SillyTavern');
    const installedRoot = join(sillyTavernRoot, 'data', 'fixture-user', 'extensions', 'Recursion');
    const publicRoot = join(sillyTavernRoot, 'public', 'scripts', 'extensions', 'third-party', 'Recursion');
    createRepository(repositoryRoot);
    copyProduction(repositoryRoot, installedRoot);
    copyProduction(repositoryRoot, publicRoot);
    write(sillyTavernRoot, 'data/fixture-user/chats/private.jsonl', 'must never be read\n');
    write(sillyTavernRoot, 'data/fixture-user/settings.json', 'must never be read\n');
    write(sillyTavernRoot, 'data/fixture-user/user/files/provider-secret.json', 'must never be read\n');
    const result = spawnSync(process.execPath, [
      verifierPath,
      '--repo-root', repositoryRoot,
      '--sillytavern-root', sillyTavernRoot,
      '--user', 'fixture-user'
    ], { encoding: 'utf8' });
    assertEqual(result.status, 0, `--user SillyTavern layout passes: ${result.stderr}`);
    assert(
      result.stdout.includes('[pass] installed copy matches 7 production files'),
      '--user CLI reports matching production files'
    );
  }

  console.log('[pass] installed copy verifier');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
