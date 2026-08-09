import { assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

const module = await import('./prepare-live-resilience-profile.mjs');
const label = 'nanogpt minimax/minimax-m3:thinking - Freaky Frankenstein 5 - Internal States - Fast';
const source = {
  extension_settings: {
    connectionManager: {
      profiles: [{ id: 'source-id', name: label, model: 'minimax/minimax-m3:thinking', api: 'nanogpt', 'secret-id': 'shared-secret' }]
    }
  }
};
const target = {
  extension_settings: {
    connectionManager: {
      profiles: [{ id: 'existing-id', name: 'existing', model: 'other', api: 'nanogpt', 'secret-id': 'shared-secret' }]
    }
  }
};
const result = module.cloneExactProfile({ source, target, label, newId: 'new-safe-id' });
assertEqual(result.profile.name, label, 'clone preserves exact profile label');
assertEqual(result.profile.id, 'new-safe-id', 'clone replaces only profile id');
assertEqual(result.profile['secret-id'], 'shared-secret', 'clone preserves usable existing credential reference');
assertEqual(result.target.extension_settings.connectionManager.profiles.length, 2, 'clone appends one profile');
assertEqual(target.extension_settings.connectionManager.profiles.length, 1, 'clone does not mutate input');
assertDeepEqual(result.summary, {
  label,
  model: 'minimax/minimax-m3:thinking',
  api: 'nanogpt',
  added: true
}, 'clone result exposes safe metadata only');
assertRejects(
  () => Promise.resolve(module.cloneExactProfile({ source, target: result.target, label, newId: 'another' })),
  /already exists/,
  'clone refuses an existing exact profile'
);
assertRejects(
  () => Promise.resolve(module.cloneExactProfile({
    source,
    target: { extension_settings: { connectionManager: { profiles: [] } } },
    label,
    newId: 'new-safe-id'
  })),
  /credential reference/,
  'clone refuses a target without the referenced credential'
);

console.log('[pass] prepare live resilience profile');
