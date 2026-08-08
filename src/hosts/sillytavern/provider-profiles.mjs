function textValue(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

export function requireConnectionManagerService(context = {}) {
  const service = context?.ConnectionManagerRequestService;
  const required = ['getSupportedProfiles', 'getProfile', 'validateProfile', 'sendRequest'];
  const missing = required.filter((name) => typeof service?.[name] !== 'function');
  if (missing.length) {
    const error = new Error(`Connection Manager API is missing: ${missing.join(', ')}.`);
    error.code = 'RECURSION_CONNECTION_MANAGER_UNAVAILABLE';
    error.retryable = false;
    throw error;
  }
  return service;
}

export function completionModeFromApiMap(apiMap = {}) {
  const selected = textValue(apiMap?.selected).toLowerCase();
  if (selected === 'openai') return 'chat';
  if (selected === 'textgenerationwebui') return 'text';
  return 'unknown';
}

function supportedProfiles(service) {
  const profiles = service.getSupportedProfiles();
  if (Array.isArray(profiles)) return profiles;
  if (profiles && typeof profiles === 'object') return Object.values(profiles);
  return [];
}

export function listSillyTavernConnectionProfiles({ context = null } = {}) {
  const service = requireConnectionManagerService(context || {});
  return supportedProfiles(service).map((profile) => {
    const apiMap = service.validateProfile(profile);
    const name = textValue(profile?.name || profile?.label || profile?.id);
    const model = textValue(profile?.model);
    return {
      id: textValue(profile?.id),
      name,
      model,
      label: model ? `${name} / ${model}` : name,
      api: textValue(profile?.api),
      completionMode: completionModeFromApiMap(apiMap),
      presetName: textValue(profile?.preset),
      instructName: textValue(profile?.instruct)
    };
  }).filter((profile) => profile.id && profile.completionMode !== 'unknown');
}

export const completionModeFromMap = completionModeFromApiMap;
