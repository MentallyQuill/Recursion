import { randomUUID } from 'node:crypto';
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function profiles(settings) {
  const value = settings?.extension_settings?.connectionManager?.profiles;
  if (!Array.isArray(value)) throw new Error('Connection Manager profiles are unavailable.');
  return value;
}

export function cloneExactProfile({ source, target, label, newId }) {
  const requestedLabel = String(label || '').trim();
  const matches = profiles(source).filter((profile) => String(profile?.name || profile?.label || '').trim() === requestedLabel);
  if (matches.length !== 1) throw new Error(`Expected exactly one source profile for ${requestedLabel}.`);
  if (profiles(target).some((profile) => String(profile?.name || profile?.label || '').trim() === requestedLabel)) {
    throw new Error(`Target profile already exists for ${requestedLabel}.`);
  }
  const sourceProfile = matches[0];
  const secretReference = sourceProfile['secret-id'];
  if (secretReference && !profiles(target).some((profile) => profile?.['secret-id'] === secretReference)) {
    throw new Error('Target does not already contain the required credential reference.');
  }
  const nextTarget = structuredClone(target);
  const profile = { ...structuredClone(sourceProfile), id: String(newId || '').trim() };
  if (!profile.id) throw new Error('A new profile id is required.');
  profiles(nextTarget).push(profile);
  return {
    target: nextTarget,
    profile,
    summary: {
      label: requestedLabel,
      model: String(profile.model || '').slice(0, 180),
      api: String(profile.api || '').slice(0, 80),
      added: true
    }
  };
}

function parseArgs(argv) {
  const args = { apply: false, source: '', target: '', label: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--apply') args.apply = true;
    else if (['--source', '--target', '--label'].includes(argv[index])) {
      args[argv[index].slice(2)] = String(argv[index + 1] || '');
      index += 1;
    }
  }
  if (!args.apply) throw new Error('Pass --apply to clone the profile.');
  args.source = resolve(args.source);
  args.target = resolve(args.target);
  if (!/[\\/]data[\\/]default-user[\\/]settings\.json$/i.test(args.source)) throw new Error('Source must be default-user settings.json.');
  if (!/[\\/]data[\\/]recursion-soak-[^\\/]+[\\/]settings\.json$/i.test(args.target)) throw new Error('Target must be a recursion-soak-* settings.json.');
  if (!args.label.trim()) throw new Error('An exact --label is required.');
  return args;
}

export function prepareLiveResilienceProfile(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const source = JSON.parse(readFileSync(args.source, 'utf8'));
  const target = JSON.parse(readFileSync(args.target, 'utf8'));
  const result = cloneExactProfile({ source, target, label: args.label, newId: randomUUID() });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${args.target}.backup-${stamp}`;
  const tempPath = join(dirname(args.target), `.recursion-profile-${randomUUID()}.tmp`);
  copyFileSync(args.target, backupPath);
  writeFileSync(tempPath, `${JSON.stringify(result.target, null, 4)}\n`, 'utf8');
  JSON.parse(readFileSync(tempPath, 'utf8'));
  renameSync(tempPath, args.target);
  return { ...result.summary, backupPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(prepareLiveResilienceProfile(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'fail', summary: String(error?.message || error).slice(0, 500) }, null, 2));
    process.exitCode = 1;
  }
}
