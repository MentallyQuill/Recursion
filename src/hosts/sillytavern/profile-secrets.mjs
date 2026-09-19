// Read only public key metadata (ids/active flags), never credential values.
export async function readSillyTavernSecretMetadata() {
  if (typeof window === 'undefined') return null;
  const [secrets, chat, text] = await Promise.all([
    import('/scripts/secrets.js'),
    import('/scripts/openai.js'),
    import('/scripts/textgen-settings.js')
  ]);
  return {
    SECRET_KEYS: secrets.SECRET_KEYS,
    secret_state: secrets.secret_state,
    chatSources: chat.chat_completion_sources,
    textTypes: text.textgen_types
  };
}

export async function profileSecretOverride(profile, apiMap, readMetadata) {
  if (!profile?.['secret-id']) return {};
  let metadata;
  try {
    metadata = await readMetadata();
  } catch {
    // Metadata being unavailable is not evidence that the saved key is missing.
    return {};
  }
  const isChat = apiMap?.selected === 'openai';
  const source = isChat ? apiMap.source : apiMap?.type;
  // Vertex has two credential stores selected by auth mode, not source alone.
  if (isChat && source === 'vertexai') return {};
  const types = isChat ? metadata?.chatSources : metadata?.textTypes;
  const entry = Object.entries(types || {}).find(([, value]) => value === source);
  const key = entry && metadata?.SECRET_KEYS?.[entry[0]];
  const records = key && metadata?.secret_state?.[key];
  if (!Array.isArray(records)) return {};
  if (records.some(record => record?.id === profile['secret-id'])) return {};
  const active = records.find(record => record?.active === true && typeof record.id === 'string' && record.id);
  return active ? { secret_id: active.id } : {};
}
