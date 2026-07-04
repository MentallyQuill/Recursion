const MODEL_KEY_PATTERN = /(^|_|\b)(model|modelid|model_id|modelname|model_name|selectedmodel|selected_model|chatmodel|chat_model|completionmodel|completion_model)$/i;
const CONNECTION_PROFILE_PATH_PATTERN = /(^|\.)(connectionProfiles?|connection_profiles|connectionManagerProfiles?|profileList|supportedProfiles|ConnectionManagerRequestService)(\.|$)|connectionManager\.(profiles|profileList)$/i;
const NON_PROVIDER_PROFILE_PATH_PATTERN = /(^|\.)(characters?|characterCards?|personas?|avatars?|groups?|cards?)(\.|$)/i;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function profileId(profile = {}) {
  return textValue(
    profile.id
      || profile.profileId
      || profile.profile_id
      || profile.uuid
      || profile.key
      || profile.name
      || profile.label
  );
}

function profileName(profile = {}, fallback = '') {
  return textValue(
    profile.label
      || profile.name
      || profile.profileName
      || profile.profile_name
      || profile.title
      || profile.displayName,
    fallback
  );
}

function modelFromProfile(profile = {}) {
  const seen = new Set();
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) return '';
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (child === null || child === undefined) continue;
      if (typeof child !== 'object' && MODEL_KEY_PATTERN.test(String(key).replace(/[^a-z0-9_]/ig, ''))) {
        const model = textValue(child);
        if (model) return model;
      }
    }
    for (const key of ['settings', 'generationSettings', 'generation_settings', 'provider', 'completion', 'chatCompletion', 'chat_completion', 'config', 'data']) {
      const model = visit(value[key], depth + 1);
      if (model) return model;
    }
    return '';
  }
  return visit(profile);
}

function profileLike(value, path = '') {
  if (!plainObject(value)) return false;
  const id = profileId(value);
  if (!id) return false;
  if (NON_PROVIDER_PROFILE_PATH_PATTERN.test(path) && !/connection/i.test(path)) return false;
  const explicitProfileKeys = [
    'profileId',
    'profile_id',
    'profileName',
    'profile_name',
    'connectionProfileId',
    'connection_profile_id'
  ];
  const hasExplicitProfileKey = explicitProfileKeys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
  return Boolean(
    CONNECTION_PROFILE_PATH_PATTERN.test(path)
      || hasExplicitProfileKey
      || value.sendRequest
      || value.api
  );
}

function collectProfileCandidates(root, path = '', depth = 0, seen = new Set(), out = []) {
  if (!root || typeof root !== 'object' || seen.has(root) || depth > 6) return out;
  if (path && NON_PROVIDER_PROFILE_PATH_PATTERN.test(path) && !/connection/i.test(path)) return out;
  seen.add(root);
  if (Array.isArray(root)) {
    if (root.some((entry) => profileLike(entry, path))) {
      for (const entry of root) {
        if (profileLike(entry, path)) out.push(entry);
      }
    }
    for (const entry of root) collectProfileCandidates(entry, path, depth + 1, seen, out);
    return out;
  }
  if (profileLike(root, path)) out.push(root);
  for (const [key, child] of Object.entries(root)) {
    const childPath = path ? `${path}.${key}` : key;
    if (Array.isArray(child) && /profile|connection/i.test(key)) {
      for (const entry of child) {
        if (profileLike(entry, childPath)) out.push(entry);
      }
    } else if (plainObject(child) && /profile|connection/i.test(key)) {
      for (const entry of Object.values(child)) {
        if (profileLike(entry, childPath)) out.push(entry);
      }
    }
    collectProfileCandidates(child, childPath, depth + 1, seen, out);
  }
  return out;
}

function normalizeConnectionProfile(profile = {}) {
  const id = profileId(profile);
  if (!id) return null;
  const name = profileName(profile, id);
  const model = modelFromProfile(profile);
  return {
    id,
    name,
    model,
    label: model ? `${name} / ${model}` : name,
    raw: profile
  };
}

function supportedProfilesFromService(service) {
  try {
    const result = service?.getSupportedProfiles?.();
    if (Array.isArray(result)) return result;
    if (plainObject(result)) return Object.values(result);
  } catch {
    return [];
  }
  return [];
}

export function listSillyTavernConnectionProfiles({ context = null, globals = globalThis } = {}) {
  const service = context?.ConnectionManagerRequestService || globals?.ConnectionManagerRequestService || null;
  const roots = [
    { value: { connectionProfiles: supportedProfilesFromService(service) }, path: '' },
    { value: context?.ConnectionManagerRequestService, path: 'ConnectionManagerRequestService' },
    { value: context?.connectionManager, path: 'connectionManager' },
    { value: context?.state?.connectionManager, path: 'connectionManager' },
    { value: globals?.ConnectionManagerRequestService, path: 'ConnectionManagerRequestService' },
    { value: globals?.connectionManager, path: 'connectionManager' },
    { value: globals?.ConnectionManager, path: 'ConnectionManager' },
    { value: context?.extension_settings, path: 'extension_settings' },
    { value: globals?.extension_settings, path: 'extension_settings' },
    { value: context?.power_user, path: 'power_user' },
    { value: globals?.power_user, path: 'power_user' }
  ];
  const byId = new Map();
  for (const root of roots) {
    for (const candidate of collectProfileCandidates(root.value, root.path)) {
      const normalized = normalizeConnectionProfile(candidate);
      if (normalized && !byId.has(normalized.id)) byId.set(normalized.id, normalized);
    }
  }
  return [...byId.values()];
}
