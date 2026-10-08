import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { productionTreeIdentity } from './lib/production-build.mjs';
import { BUILD_INFO_SCHEMA, normalizeBuildIdentity } from '../../src/runtime/build-identity.mjs';

function rejectLinkedPath(path) {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error('Staging paths must not contain symbolic links.');
    }
    if (dirname(current) === current) break;
  }
}

export function prepareRecursionInstall({ repositoryRoot, outputRoot, sourceRevision = null,
  dirty = true, createdAt = new Date().toISOString() } = {}) {
  if (!repositoryRoot || !outputRoot) throw new Error('An explicit repository and empty output directory are required.');
  const repository = resolve(repositoryRoot);
  const output = resolve(outputRoot);
  const repositoryFromOutput=relative(output,repository);
  if (dirname(output) === output || !repositoryFromOutput
    || !isAbsolute(repositoryFromOutput) && !repositoryFromOutput.startsWith(`..${sep}`) && repositoryFromOutput !== '..') {
    throw new Error('Output must not be the repository or an ancestor of the repository.');
  }
  const inside = relative(repository, output).split(sep).map(part=>part.toLowerCase());
  if (inside[0] === 'src' || inside[0] === 'styles' || inside[0] === 'assets' || inside[0] === '.git') {
    throw new Error('Output must not be inside repository production files or Git state.');
  }
  rejectLinkedPath(repository);
  rejectLinkedPath(output);
  if (existsSync(output) && (!lstatSync(output).isDirectory() || readdirSync(output).length)) {
    throw new Error('Staging output must be an empty directory.');
  }
  const identity = productionTreeIdentity(repository);
  const version = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version;
  const build = normalizeBuildIdentity({ schema: BUILD_INFO_SCHEMA, version, sourceRevision, dirty,
    productionHash: identity.productionHash, createdAt });
  if (build.status !== 'declared') throw new Error('Invalid source build metadata.');
  mkdirSync(output, { recursive: true });
  for (const path of identity.files) {
    const target = join(output, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repository, ...path.split('/')), target);
  }
  const { status, ...metadata } = build;
  writeFileSync(join(output, 'build-info.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  if (productionTreeIdentity(output).productionHash !== build.productionHash) {
    throw new Error('Staged production content changed during copying.');
  }
  return { ok: true, outputRoot: output, filesCopied: identity.files.length, build };
}

export function runPrepareInstallCli(argv = process.argv.slice(2)) {
  try {
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
      if (!['--repo-root', '--output'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
        throw new Error('Usage: prepare-recursion-install --output <empty-directory> [--repo-root <repository>]');
      }
      if (args[argv[i]]) throw new Error('Duplicate staging option.');
      args[argv[i]] = argv[i + 1];
    }
    const repositoryRoot = resolve(args['--repo-root'] || process.cwd());
    const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:repositoryRoot, encoding:'utf8'}).trim();
    const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], {cwd:repositoryRoot, encoding:'utf8'}).trim());
    const report = prepareRecursionInstall({ repositoryRoot, outputRoot:args['--output'], sourceRevision, dirty });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[fail] ${String(error?.message || error)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runPrepareInstallCli();
}
