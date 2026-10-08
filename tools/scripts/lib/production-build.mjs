import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
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
  if (lstatSync(absoluteTree).isSymbolicLink()) {
    symlinks.add(tree);
    return;
  }
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

export function inventoryProduction(root) {
  const files = new Set();
  const symlinks = new Set();
  for (const relativePath of ROOT_PRODUCTION_FILES) {
    const path = join(root, relativePath);
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink()) symlinks.add(relativePath);
    else files.add(relativePath);
  }
  for (const tree of PRODUCTION_TREES) {
    walkProductionTree(root, tree, files, symlinks);
  }
  return {
    files: [...files].sort(),
    symlinks: [...symlinks].sort()
  };
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
  for (const path of inventory.files) {
    if (!/\.(?:m?js|json|css|svg)$/i.test(path)) continue;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(root, ...path.split('/'))));
    } catch {
      throw new Error(`Repository production file contains invalid UTF-8: ${path}`);
    }
  }
  return inventory.files;
}


export function productionTreeIdentity(root) {
  const files = productionFilePaths(root);
  const hash = createHash('sha256');
  for (const path of files) {
    let contents = readFileSync(join(root, ...path.split('/')));
    if (/\.(?:m?js|json|css|svg|md|txt)$/i.test(path)) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
      contents = Buffer.from(text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), 'utf8');
    }
    // Length framing makes boundaries unambiguous even for binary content.
    hash.update(`${Buffer.byteLength(path)}:${path}:${contents.length}:`);
    hash.update(contents);
  }
  return { productionHash: hash.digest('hex'), files };
}
