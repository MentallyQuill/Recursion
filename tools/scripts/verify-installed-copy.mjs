import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_PRODUCTION_FILES = Object.freeze(['manifest.json', 'package.json']);
const PRODUCTION_TREES = Object.freeze(['src', 'styles', 'assets/icons']);
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.tmp',
  'artifacts',
  'coverage',
  'node_modules',
  'test',
  'tests',
  'tmp'
]);
const IGNORED_FILE_NAMES = new Set(['.gitkeep', 'README.md', 'debug.log']);

function forwardSlashes(value) {
  return String(value || '').split(sep).join('/');
}

function ignoredFile(name) {
  return IGNORED_FILE_NAMES.has(name) || name.toLowerCase().endsWith('.log');
}

function ensureRoot(root, label) {
  const resolved = resolve(String(root || ''));
  if (!root || !existsSync(resolved)) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function walkProductionTree(root, tree, files, symlinks) {
  const absoluteTree = join(root, ...tree.split('/'));
  if (!existsSync(absoluteTree)) return;
  const pending = [absoluteTree];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = forwardSlashes(relative(root, absolutePath));
      if (entry.isSymbolicLink()) {
        symlinks.add(relativePath);
      } else if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile() && !ignoredFile(entry.name)) {
        files.add(relativePath);
      }
    }
  }
}

function inventoryProduction(root) {
  const files = new Set();
  const symlinks = new Set();
  for (const relativePath of ROOT_PRODUCTION_FILES) {
    if (existsSync(join(root, relativePath))) files.add(relativePath);
  }
  for (const tree of PRODUCTION_TREES) {
    walkProductionTree(root, tree, files, symlinks);
  }
  return {
    files: [...files].sort(),
    symlinks: [...symlinks].sort()
  };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function compareCopy({ repositoryRoot, expectedFiles, copyRoot, copy }) {
  const actual = inventoryProduction(copyRoot);
  const expected = new Set(expectedFiles);
  const actualFiles = new Set(actual.files);
  const differences = [];

  for (const path of expectedFiles) {
    if (!actualFiles.has(path)) {
      differences.push({ copy, kind: 'missing', path });
      continue;
    }
    const expectedHash = sha256(join(repositoryRoot, ...path.split('/')));
    const actualHash = sha256(join(copyRoot, ...path.split('/')));
    if (actualHash !== expectedHash) {
      differences.push({
        copy,
        kind: 'content-mismatch',
        path,
        expectedSha256: expectedHash,
        actualSha256: actualHash
      });
    }
  }

  for (const path of actual.files) {
    if (!expected.has(path)) differences.push({ copy, kind: 'extra', path });
  }
  for (const path of actual.symlinks) {
    differences.push({ copy, kind: 'unsafe-symlink', path });
  }
  return differences;
}

function compareDifference(left, right) {
  return left.copy.localeCompare(right.copy)
    || left.path.localeCompare(right.path)
    || left.kind.localeCompare(right.kind);
}

export function productionFilePaths(repositoryRoot) {
  const root = ensureRoot(repositoryRoot, 'Repository root');
  const inventory = inventoryProduction(root);
  if (inventory.symlinks.length > 0) {
    throw new Error(`Repository production tree contains a symbolic link: ${inventory.symlinks[0]}`);
  }
  for (const required of ROOT_PRODUCTION_FILES) {
    if (!inventory.files.includes(required)) {
      throw new Error(`Repository production file is missing: ${required}`);
    }
  }
  return inventory.files;
}

export function verifyInstalledCopies({
  repositoryRoot,
  installedRoot,
  publicRoot
} = {}) {
  const roots = {
    repositoryRoot: ensureRoot(repositoryRoot, 'Repository root'),
    installedRoot: ensureRoot(installedRoot, 'Installed extension root'),
    publicRoot: ensureRoot(publicRoot, 'Public extension root')
  };
  const expectedFiles = productionFilePaths(roots.repositoryRoot);
  const differences = [
    ...compareCopy({
      repositoryRoot: roots.repositoryRoot,
      expectedFiles,
      copyRoot: roots.installedRoot,
      copy: 'installed'
    }),
    ...compareCopy({
      repositoryRoot: roots.repositoryRoot,
      expectedFiles,
      copyRoot: roots.publicRoot,
      copy: 'public'
    })
  ].sort(compareDifference);
  return {
    ok: differences.length === 0,
    filesCompared: expectedFiles.length,
    differences
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (![
      'user',
      'repo-root',
      'installed-root',
      'public-root',
      'sillytavern-root'
    ].includes(key)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function safeUserName(user) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(user || ''));
}

function rootsFromArguments(argv, cwd = process.cwd(), environment = process.env) {
  const args = parseArguments(argv);
  const repositoryRoot = resolve(args['repo-root'] || cwd);
  const hasExplicitCopyRoot = Boolean(args['installed-root'] || args['public-root']);
  if (hasExplicitCopyRoot) {
    if (!args['installed-root'] || !args['public-root']) {
      throw new Error('--installed-root and --public-root must be provided together.');
    }
    return {
      repositoryRoot,
      installedRoot: resolve(args['installed-root']),
      publicRoot: resolve(args['public-root'])
    };
  }

  if (!safeUserName(args.user)) {
    throw new Error('A safe --user <name> is required unless explicit copy roots are provided.');
  }
  const sillyTavernRoot = resolve(
    args['sillytavern-root']
      || environment.SILLYTAVERN_ROOT
      || join(repositoryRoot, '..', '..', 'SillyTavern', 'SillyTavern')
  );
  return {
    repositoryRoot,
    installedRoot: join(sillyTavernRoot, 'data', args.user, 'extensions', 'Recursion'),
    publicRoot: join(sillyTavernRoot, 'public', 'scripts', 'extensions', 'third-party', 'Recursion')
  };
}

export function runInstalledCopyVerifierCli(
  argv = process.argv.slice(2),
  {
    cwd = process.cwd(),
    environment = process.env,
    stdout = process.stdout,
    stderr = process.stderr
  } = {}
) {
  try {
    const roots = rootsFromArguments(argv, cwd, environment);
    const report = verifyInstalledCopies(roots);
    if (report.ok) {
      stdout.write(`[pass] installed copy matches ${report.filesCompared} production files\n`);
      return 0;
    }
    for (const difference of report.differences) {
      stderr.write(`${difference.copy} ${difference.kind}: ${difference.path}\n`);
    }
    stderr.write(`[fail] ${report.differences.length} installed-copy difference(s)\n`);
    return 1;
  } catch (error) {
    stderr.write(`[fail] ${String(error?.message || error)}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(isAbsolute(process.argv[1]) ? process.argv[1] : resolve(process.argv[1])).href
  : '';
if (invokedPath === import.meta.url) {
  process.exitCode = runInstalledCopyVerifierCli();
}
