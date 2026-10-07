function stringValue(value) { return String(value ?? ''); }

// Keep the actual host message projection and retry comparison identical.
export function requestMessages(request = {}) {
  if (Array.isArray(request.messages) && request.messages.length > 0) {
    return request.messages.map(message => ({
      role: ['system', 'assistant', 'user'].includes(stringValue(message?.role).trim())
        ? stringValue(message.role).trim() : 'user',
      content: stringValue(message?.content ?? message?.text ?? message?.value)
    })).filter(message => message.content.trim());
  }
  return [
    ...(stringValue(request.systemPrompt).trim() ? [{ role: 'system', content: stringValue(request.systemPrompt) }] : []),
    { role: 'user', content: stringValue(request.prompt) }
  ];
}
