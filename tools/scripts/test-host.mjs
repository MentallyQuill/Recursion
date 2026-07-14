import { createSillyTavernHost, normalizeSillyTavernMessageEvent, promptBlocksFromPacket } from '../../src/hosts/sillytavern/host.mjs';
import { listSillyTavernConnectionProfiles } from '../../src/hosts/sillytavern/provider-profiles.mjs';
import { createGenerationRouter } from '../../src/providers.mjs';
import { assert, assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

async function flushMicrotasks(count = 6) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

const prompts = [];
const context = {
  chatId: 'chat-file',
  chat: [{ mesid: 0, is_user: true, mes: 'Hello' }],
  setExtensionPrompt(key, text, position, depth, scan, role) {
    prompts.push({ key, text, position, depth, scan, role });
  },
  extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
  extension_prompt_roles: { SYSTEM: 0 },
  generateRaw: async () => ({ text: '{"schema":"x"}' })
};

const host = createSillyTavernHost({ contextFactory: () => context, settingsRoot: {} });
const snap = await host.snapshot();
assertEqual(snap.chatId, 'chat-file', 'chat id read');
assertEqual(snap.messages[0].text, 'Hello', 'message text read');

const normalizedSwipeEvent = normalizeSillyTavernMessageEvent(
  { type: 'MESSAGE_SWIPED', id: 'm-2', content: { schema: 'x', ok: true } },
  { latestAssistantMessageId: 'm-2' }
);
assertEqual(normalizedSwipeEvent.swiped, true, 'swipe event is normalized by host adapter');
assertEqual(normalizedSwipeEvent.latestAssistant, true, 'latest assistant identity is normalized by host adapter');
assert(!String(normalizedSwipeEvent.text).includes('[object Object]'), 'object-shaped event content is JSON-normalized');

const normalizedStopEvent = normalizeSillyTavernMessageEvent(
  {
    mesid: 7,
    source: 'host-runtime',
    reason: 'generation-aborted',
    origin: 'unknown-listener',
    authorization: 'must-not-be-recorded',
    prompt: 'must-not-be-recorded'
  },
  { eventName: 'generation_stopped' }
);
assertEqual(normalizedStopEvent.source, 'host-runtime', 'generation stop source survives host normalization');
assertEqual(normalizedStopEvent.reason, 'generation-aborted', 'generation stop reason survives host normalization');
assertEqual(normalizedStopEvent.origin, 'unknown-listener', 'generation stop origin survives host normalization');
assertEqual(normalizedStopEvent.payloadType, 'object', 'generation stop records raw payload shape');
assertDeepEqual(
  normalizedStopEvent.payloadKeys,
  ['authorization', 'mesid', 'origin', 'prompt', 'reason', 'source'],
  'generation stop records sorted payload keys without payload values'
);
assert(!JSON.stringify(normalizedStopEvent).includes('must-not-be-recorded'), 'generation stop normalization excludes sensitive payload values');

{
  const eventHost = createSillyTavernHost({
    contextFactory: () => ({
      chatId: 'event-chat',
      chat: [{ mesid: 42, is_user: false, mes: 'Assistant text.' }]
    }),
    settingsRoot: {}
  });
  assertEqual(eventHost.latestAssistantMessageIdentity(), 'event-chat::42', 'host exposes latest assistant identity');
  assertEqual(
    eventHost.normalizeMessageEvent({ mesid: 42 }, { eventName: 'message_swiped' }).latestAssistant,
    true,
    'host instance marks latest assistant swipe events'
  );
  const sparseSwipe = eventHost.normalizeMessageEvent({}, { eventName: 'message_swiped' });
  assertEqual(sparseSwipe.messageId, 42, 'host instance fills sparse latest-assistant swipe id');
  assertEqual(sparseSwipe.latestAssistant, true, 'sparse latest-assistant swipe remains marked as latest assistant');
}

{
  const contextProfileService = {
    getSupportedProfiles() {
      return [
        { profileId: 'ctx-utility', label: 'Context Utility', model_name: 'glm-fast' },
        { id: 'ctx-reasoner', name: 'Context Reasoner', settings: { model: 'o-reasoner' } }
      ];
    }
  };
  const contextProfiles = listSillyTavernConnectionProfiles({
    context: { ConnectionManagerRequestService: contextProfileService },
    globals: {}
  });
  assertDeepEqual(
    contextProfiles.map((profile) => [profile.id, profile.label, profile.model]),
    [
      ['ctx-utility', 'Context Utility / glm-fast', 'glm-fast'],
      ['ctx-reasoner', 'Context Reasoner / o-reasoner', 'o-reasoner']
    ],
    'host connection profiles are detected from context.ConnectionManagerRequestService'
  );

  const objectMapProfiles = listSillyTavernConnectionProfiles({
    context: {
      state: {
        connectionManager: {
          profiles: {
            mapUtility: { uuid: 'map-utility', title: 'Map Utility', generationSettings: { model: 'map-fast' } },
            mapReasoner: { profile_id: 'map-reasoner', profileName: 'Map Reasoner', modelId: 'map-deep' }
          }
        }
      }
    },
    globals: {}
  });
  assertDeepEqual(
    objectMapProfiles.map((profile) => [profile.id, profile.label, profile.model]),
    [
      ['map-utility', 'Map Utility / map-fast', 'map-fast'],
      ['map-reasoner', 'Map Reasoner / map-deep', 'map-deep']
    ],
    'host connection profiles are detected from nested object-map host state'
  );

  const profilesBesideCharacters = listSillyTavernConnectionProfiles({
    context: {
      characters: [
        { id: 'char-sam', name: 'Sam Vickers', avatar: 'sam.png', data: { description: 'character card' } },
        { id: 'char-ash', name: 'Ashes of Peace', model: 'not-a-provider-model' }
      ],
      ConnectionManagerRequestService: {
        getSupportedProfiles() {
          return [{ id: 'real-profile', label: 'Real Profile', model: 'glm-real' }];
        }
      }
    },
    globals: {
      extension_settings: {
        characterCards: {
          charMap: { id: 'char-map', name: 'Mapped Character Card', model: 'not-a-profile' }
        }
      }
    }
  });
  assertDeepEqual(
    profilesBesideCharacters.map((profile) => [profile.id, profile.label]),
    [['real-profile', 'Real Profile / glm-real']],
    'host connection profile discovery rejects SillyTavern character cards'
  );

  const characterCardWithExpensiveData = {
    id: 'char-expensive',
    name: 'Character Card That Must Not Be Traversed',
    get data() {
      throw new Error('character card data was traversed during connection profile discovery');
    }
  };
  const profilesBesideExpensiveCharacters = listSillyTavernConnectionProfiles({
    context: {
      characters: [characterCardWithExpensiveData],
      state: {
        connectionManager: {
          profiles: [{ id: 'state-profile', label: 'State Profile', model: 'glm-state' }]
        }
      }
    },
    globals: {
      extension_settings: {
        characterCards: {
          get charExpensive() {
            throw new Error('extension character card map was traversed during connection profile discovery');
          }
        }
      }
    }
  });
  assertDeepEqual(
    profilesBesideExpensiveCharacters.map((profile) => [profile.id, profile.label]),
    [['state-profile', 'State Profile / glm-state']],
    'host connection profile discovery skips character-card containers instead of walking them'
  );
}

{
  const boundedContext = {
    chatId: 'long-chat',
    chat: Array.from({ length: 30 }, (_, index) => ({
      mesid: index,
      is_user: index % 2 === 1,
      mes: `visible message ${index}`
    })),
    extensionSettings: {
      recursion: {
        retention: {
          sourceWindowMessages: 12,
          sourceWindowCharacters: 6000,
          providerVisibleMessages: 4
        }
      }
    }
  };
  const boundedHost = createSillyTavernHost({
    contextFactory: () => boundedContext,
    fetchImpl: null
  });
  const boundedSnapshot = await boundedHost.snapshot();
  assertEqual(boundedSnapshot.messages.length, 12, 'host snapshot keeps bounded source messages');
  assertDeepEqual(
    boundedSnapshot.messages.map((message) => message.mesid),
    [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
    'host snapshot keeps canonical SillyTavern message ids in the newest bounded source window'
  );
  assertEqual(boundedSnapshot.sourceWindowMessageCount, 12, 'snapshot exposes source window count');
  assertEqual(boundedSnapshot.sourceWindowTruncated, true, 'snapshot marks bounded source window');
  assertEqual(boundedSnapshot.sourceWindowLimitReason, 'message-cap', 'snapshot records message cap reason');
}

{
  const placeholderContext = {
    chatId: 'long-swipe-placeholder-chat',
    chat: Array.from({ length: 30 }, (_, index) => ({
      mesid: index,
      is_user: index % 2 === 0,
      mes: `visible message ${index}`
    })),
    extensionSettings: {
      recursion: {
        retention: {
          sourceWindowMessages: 10,
          sourceWindowCharacters: 6000,
          providerVisibleMessages: 4
        }
      }
    }
  };
  placeholderContext.chat[29] = {
    mesid: 29,
    is_user: false,
    mes: 'Previous assistant swipe.',
    swipe_id: 1,
    swipes: ['Previous assistant swipe.', '']
  };
  const placeholderHost = createSillyTavernHost({
    contextFactory: () => placeholderContext,
    fetchImpl: null
  });
  const placeholderSnapshot = await placeholderHost.snapshot();
  const placeholderAssistant = placeholderSnapshot.messages.at(-1);
  assertEqual(placeholderAssistant.mesid, 29, 'blank active swipe placeholder preserves canonical assistant message id');
  assertEqual(placeholderAssistant.swipeId, 1, 'blank active swipe placeholder preserves active swipe index');
  assertEqual(placeholderAssistant.swipeCount, 2, 'blank active swipe placeholder preserves swipe count');
  assertEqual(placeholderSnapshot.latestMesId, 29, 'blank active swipe placeholder keeps snapshot latest message id aligned');
}

const swipeContext = {
  chatId: 'swipe-chat',
  chat: [
    {
      mesid: 0,
      is_user: false,
      mes: 'Swipe A text.',
      swipe_id: 0,
      swipes: ['Swipe A text.', 'Swipe B text.']
    }
  ],
  extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
  extension_prompt_roles: { SYSTEM: 0 },
  setExtensionPrompt() {}
};
const swipeHost = createSillyTavernHost({ contextFactory: () => swipeContext, settingsRoot: {} });
const swipeSnapA = await swipeHost.snapshot();
assertEqual(swipeSnapA.messages[0].swipeId, 0, 'snapshot records active swipe id');
assertEqual(swipeSnapA.messages[0].swipeCount, 2, 'snapshot records swipe count');
assertEqual(typeof swipeSnapA.messages[0].activeSwipeTextHash, 'string', 'snapshot records active swipe text hash');
assertEqual(typeof swipeSnapA.sourceRevisionHash, 'string', 'snapshot records source revision hash');
const inactiveHash = swipeSnapA.sourceRevisionHash;
swipeContext.chat[0].swipes[1] = 'Swipe B text changed while inactive.';
assertEqual((await swipeHost.snapshot()).sourceRevisionHash, inactiveHash, 'inactive swipe text does not affect active source revision');
swipeContext.chat[0].swipe_id = 1;
swipeContext.chat[0].mes = swipeContext.chat[0].swipes[1];
const swipeSnapB = await swipeHost.snapshot();
assert(swipeSnapB.sourceRevisionHash !== inactiveHash, 'active swipe change affects source revision');
assert(swipeSnapB.turnFingerprint !== swipeSnapA.turnFingerprint, 'active swipe change affects turn fingerprint');
swipeContext.chat[0].swipes.push('Swipe C text.');
const swipeSnapC = await swipeHost.snapshot();
assert(swipeSnapC.sourceRevisionHash !== swipeSnapB.sourceRevisionHash, 'swipe count change affects source revision');

const messageMutationCalls = [];
const mutationContext = {
  chatId: 'prose-host-chat',
  chat: [
    {
      mesid: 4,
      is_user: false,
      mes: 'Original assistant text.',
      swipe_id: 0,
      swipes: ['Original assistant text.'],
      swipe_info: [{ send_date: '2026-07-07T00:00:00.000Z', gen_started: '2026-07-07T00:00:00.000Z', gen_finished: '2026-07-07T00:00:01.000Z' }]
    }
  ],
  updateMessageBlock(messageId, message) {
    messageMutationCalls.push({ messageId, message });
  },
  saveChat() {
    messageMutationCalls.push({ save: true });
  },
  reloadCurrentChat() {
    messageMutationCalls.push({ reload: true });
  }
};
const mutationHost = createSillyTavernHost({ contextFactory: () => mutationContext, settingsRoot: {} });
const activeIdentity = mutationHost.messages.activeAssistantMessageIdentity();
assertEqual(activeIdentity.chatKey, 'prose-host-chat', 'host active assistant identity includes chat key');
assertEqual(activeIdentity.messageId, 4, 'host active assistant identity includes message id');
assertEqual(activeIdentity.swipeId, 0, 'host active assistant identity includes active swipe id');
assertEqual(activeIdentity.text, 'Original assistant text.', 'host active assistant identity includes active swipe text');
assertEqual(typeof activeIdentity.originalHash, 'string', 'host active assistant identity includes text hash');
assertEqual((await mutationHost.messages.holdAssistantMessage(4)).ok, true, 'host can hold assistant text');
assertEqual(mutationContext.chat[0].mes, 'Original assistant text.', 'hold captures without destructively clearing assistant text');
assertEqual(mutationContext.chat[0].swipes[0], 'Original assistant text.', 'hold captures without destructively clearing active swipe text');
assertEqual(mutationContext.chat[0].__recursionHeldText, 'Original assistant text.', 'hold stores recoverable held assistant text');
assertEqual((await mutationHost.messages.revealAssistantMessage(4)).ok, true, 'host can reveal held assistant text');
assertEqual(mutationContext.chat[0].mes, 'Original assistant text.', 'reveal restores held assistant text');
assertEqual((await mutationHost.messages.appendAssistantMessageSwipe(4, 'Polished assistant text.', { marker: { originalHash: 'hash-a' }, select: true })).ok, true, 'host appends and selects enhanced swipe');
assertEqual(mutationContext.chat[0].swipes.length, 2, 'enhanced swipe appended');
assertEqual(mutationContext.chat[0].swipe_info.length, 2, 'enhanced swipe metadata appended for SillyTavern UI');
assertEqual(typeof mutationContext.chat[0].swipe_info[1].send_date, 'string', 'enhanced swipe metadata includes send date');
assertEqual(mutationContext.chat[0].swipe_id, 1, 'enhanced swipe auto-selected');
assertEqual(mutationContext.chat[0].mes, 'Polished assistant text.', 'active message text follows enhanced swipe');
assertEqual((await mutationHost.messages.findEnhancedSwipe(4, { originalHash: 'hash-a' })).index, 1, 'host finds existing enhanced swipe marker');
assertEqual((await mutationHost.messages.replaceAssistantMessageText(4, 'Replacement text.', { marker: { originalHash: 'hash-b' } })).ok, true, 'host replaces active assistant text');
assertEqual(mutationContext.chat[0].swipes[1], 'Replacement text.', 'replace updates selected swipe text');
mutationContext.chat[0].swipes.push('');
mutationContext.chat[0].swipe_info.push({ send_date: '2026-07-14T00:00:00.000Z', extra: {} });
mutationContext.chat[0].swipe_id = 2;
mutationContext.chat[0].mes = '';
const emptySwipeCleanup = await mutationHost.messages.removeEmptyAssistantSwipePlaceholders(4);
assertEqual(emptySwipeCleanup.ok, true, 'host removes trailing empty assistant swipe placeholders');
assertEqual(emptySwipeCleanup.removed, 1, 'host reports one removed empty swipe placeholder');
assertEqual(mutationContext.chat[0].swipes.length, 2, 'empty swipe cleanup preserves only substantive swipes');
assertEqual(mutationContext.chat[0].swipe_info.length, 2, 'empty swipe cleanup keeps swipe metadata aligned');
assertEqual(mutationContext.chat[0].swipe_id, 1, 'empty swipe cleanup restores the latest substantive swipe');
assertEqual(mutationContext.chat[0].mes, 'Replacement text.', 'empty swipe cleanup restores substantive assistant text');
assert(messageMutationCalls.some((entry) => entry.save === true), 'message mutation saves chat');
assertEqual(messageMutationCalls.some((entry) => entry.reload === true), false, 'self-authored swipe mutation does not reload the chat and emit CHAT_CHANGED');

const latestMutationContext = {
  chatId: 'prose-latest-host-chat',
  chat: [
    { mesid: 0, is_user: false, mes: 'Older assistant text.' },
    { mesid: 1, is_user: true, mes: 'User asks.' },
    {
      mesid: 8,
      is_user: false,
      mes: 'Latest assistant text.',
      swipe_id: 0,
      swipes: ['Latest assistant text.']
    }
  ]
};
const latestMutationHost = createSillyTavernHost({ contextFactory: () => latestMutationContext, settingsRoot: {} });
assertEqual(latestMutationHost.messages.activeAssistantMessageIdentity().messageId, 8, 'host active assistant identity chooses latest assistant when no id is supplied');
assertEqual((await latestMutationHost.messages.holdAssistantMessage(8)).ok, true, 'host can hold latest assistant by id');
assertEqual(latestMutationContext.chat[2].mes, 'Latest assistant text.', 'host hold leaves latest assistant text recoverable in chat state');
assertEqual(latestMutationContext.chat[0].mes, 'Older assistant text.', 'host hold leaves older assistant row unchanged');
latestMutationContext.chat[2].mes = 'Latest assistant text after streaming update.';
latestMutationContext.chat[2].swipes[0] = 'Latest assistant text after streaming update.';
assertEqual((await latestMutationHost.messages.holdAssistantMessage(8)).ok, true, 'host can refresh held text after streaming updates');
assertEqual(latestMutationContext.chat[2].mes, 'Latest assistant text after streaming update.', 'host repeated hold preserves streaming text in chat state');
assertEqual(
  latestMutationHost.messages.activeAssistantMessageIdentity().text,
  'Latest assistant text after streaming update.',
  'host active assistant identity exposes captured held text for Prose Enhancement'
);

const liveContextWithStaleMessages = {
  chatId: 'prose-live-stale-messages-chat',
  messages: [
    { mesid: 0, is_user: false, mes: 'Stale assistant from context.messages.' }
  ],
  chat: [
    { mesid: 1, is_user: true, mes: 'User asks live ST.' },
    { mesid: 2, is_user: false, mes: 'Live generated assistant in context.chat.', swipe_id: 0, swipes: ['Live generated assistant in context.chat.'] }
  ]
};
const liveContextHost = createSillyTavernHost({ contextFactory: () => liveContextWithStaleMessages, settingsRoot: {} });
assertEqual(liveContextHost.messages.activeAssistantMessageIdentity().messageId, 2, 'host active assistant identity prefers live SillyTavern chat over stale context.messages');
assertEqual((await liveContextHost.messages.holdAssistantMessage(2)).ok, true, 'host holds live generated assistant from context.chat');
assertEqual(liveContextWithStaleMessages.chat[1].mes, 'Live generated assistant in context.chat.', 'host leaves live chat assistant text intact during capture');
assertEqual(liveContextWithStaleMessages.messages[0].mes, 'Stale assistant from context.messages.', 'host leaves stale context.messages untouched');

const staleHeldContext = {
  chatId: 'stale-held-prose-chat',
  chat: [
    {
      mesid: 6,
      is_user: false,
      mes: '',
      swipe_id: 0,
      swipes: [''],
      __recursionHeldText: 'Recovered assistant text.'
    }
  ],
  saveChat() {
    messageMutationCalls.push({ staleHeldSave: true });
  }
};
const staleHeldHost = createSillyTavernHost({ contextFactory: () => staleHeldContext, settingsRoot: {} });
const recoveredHeld = await staleHeldHost.messages.recoverHeldAssistantMessages({ reason: 'unit-stale-held' });
assertEqual(recoveredHeld.ok, true, 'host recovers stale held assistant messages');
assertEqual(recoveredHeld.recovered, 1, 'host reports one recovered held assistant message');
assertEqual(staleHeldContext.chat[0].mes, 'Recovered assistant text.', 'host restores stale held assistant text');
assertEqual(staleHeldContext.chat[0].swipes[0], 'Recovered assistant text.', 'host restores stale held active swipe');
assertEqual(staleHeldContext.chat[0].__recursionHeldText, undefined, 'host clears stale held marker after recovery');
assert(messageMutationCalls.some((entry) => entry.staleHeldSave === true), 'stale held recovery saves chat');

const packet = {
  injectionPlan: { blocks: [{ id: 'guidance', promptKey: 'recursion.guidance', placement: 'in_prompt', depth: 2, role: 'system' }] },
  sections: { guidance: 'Use the alley scene.', cardEvidence: 'Card evidence:\n- [Scene Frame] Alley.', guardrails: 'Guardrails:\n- Honor facts.' }
};
assertEqual(promptBlocksFromPacket(packet)[0].text, 'Use the alley scene.', 'prompt block text built');
const installResult = await host.prompt.install(packet);
assertEqual(installResult.ok, true, 'prompt install returns ok result');
assert(installResult.installed.includes('recursion.guidance'), 'prompt install returns installed keys');
assertEqual(prompts.find((entry) => entry.text === 'Use the alley scene.').key, 'recursion.guidance', 'prompt installed with Recursion key');

const liveShapePromptStore = {};
const liveShapeHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'live-shape-prompt-chat',
    chat: [],
    extensionPrompts: liveShapePromptStore,
    setExtensionPrompt(key, text, position, depth, scan, role) {
      liveShapePromptStore[key] = {
        value: String(text),
        position: Number(position),
        depth: Number(depth),
        scan: Boolean(scan),
        role: Number(role)
      };
    }
  }),
  settingsRoot: {}
});
const liveShapePacket = {
  injectionPlan: {
    blocks: [
      { id: 'guidance', promptKey: 'recursion.guidance', placement: 'in_prompt', depth: 1, role: 'system' },
      { id: 'cardEvidence', promptKey: 'recursion.cardEvidence', placement: 'in_prompt', depth: 1, role: 'system' },
      { id: 'guardrails', promptKey: 'recursion.guardrails', placement: 'in_prompt', depth: 1, role: 'system' }
    ]
  },
  sections: {
    guidance: 'Guidance:\nUse the live host contract.',
    cardEvidence: 'Private Recursion card evidence for the next assistant message.\nCard evidence:\n- [Scene Frame] Hold the boundary.',
    guardrails: 'Guardrails:\n- Honor facts.'
  }
};
const liveShapeInstall = await liveShapeHost.prompt.install(liveShapePacket);
assertEqual(liveShapeInstall.ok, true, 'live SillyTavern context shape installs prompt blocks');
assertDeepEqual(
  Object.values(liveShapePromptStore).filter((entry) => entry.value).map((entry) => [entry.position, entry.role]),
  [[0, 0], [0, 0], [0, 0]],
  'live SillyTavern context shape stores numeric in-prompt system metadata'
);

const rejectedPromptStore = {};
const rejectedPromptHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'rejected-prompt-chat',
    chat: [],
    extensionPrompts: rejectedPromptStore,
    setExtensionPrompt(key, text, position, depth, scan, role) {
      rejectedPromptStore[key] = {
        value: String(text),
        position: text ? Number.NaN : Number(position),
        depth: Number(depth),
        scan: Boolean(scan),
        role: Number(role)
      };
    }
  }),
  settingsRoot: {}
});
await assertRejects(
  async () => rejectedPromptHost.prompt.install(liveShapePacket),
  /prompt install rejected/i,
  'prompt install rejects malformed metadata stored by the live host boundary'
);
assert(
  Object.values(rejectedPromptStore).every((entry) => entry.value === ''),
  'rejected prompt install rolls back all known Recursion prompt text'
);

const roleFallbackPrompts = [];
const roleFallbackHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'role-fallback-chat',
    chat: [],
    setExtensionPrompt(key, text, position, depth, scan, role) {
      roleFallbackPrompts.push({ key, text, position, depth, scan, role });
    },
    extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
    extension_prompt_roles: { SYSTEM: 0 }
  }),
  settingsRoot: {}
});
const roleFallbackResult = await roleFallbackHost.prompt.install({
  injectionPlan: { blocks: [{ id: 'guidance', promptKey: 'recursion.guidance', placement: 'in_prompt', depth: 2, role: 'assistant' }] },
  sections: { guidance: 'Install assistant role through system fallback.', cardEvidence: 'Card evidence:\n- [Scene Frame] Alley.', guardrails: 'Guardrails:\n- Honor facts.' }
});
const roleFallbackWrite = roleFallbackPrompts.find((entry) => entry.text === 'Install assistant role through system fallback.');
assertEqual(roleFallbackWrite.role, 0, 'unsupported prompt role falls back to SillyTavern system role enum');
assertDeepEqual(
  roleFallbackResult.warnings,
  [{
    code: 'RECURSION_PROMPT_ROLE_FALLBACK',
    promptKey: 'recursion.guidance',
    requestedRole: 'assistant',
    fallbackRole: 'system'
  }],
  'prompt install returns compact role fallback warning metadata'
);

await host.prompt.clear();
assert(prompts.some((entry) => entry.key === 'recursion.guidance' && entry.text === ''), 'prompt clear removes installed key');
assert(prompts.some((entry) => entry.key === 'recursion.cardEvidence' && entry.text === ''), 'prompt clear removes known card evidence key');
assert(prompts.some((entry) => entry.key === 'recursion.guardrails' && entry.text === ''), 'prompt clear removes known guardrails key');

const clearFailurePrompts = [];
const clearFailureHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'clear-failure-chat',
    chat: [],
    setExtensionPrompt(key, text, position, depth, scan, role) {
      clearFailurePrompts.push({ key, text, position, depth, scan, role });
      if (key === 'recursion.guidance' && text === '') {
        throw new Error('simulated scene clear failure');
      }
    },
    extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
    extension_prompt_roles: { SYSTEM: 0 }
  }),
  settingsRoot: {}
});
const clearFailureResult = await clearFailureHost.prompt.clear();
assertEqual(clearFailureResult.ok, false, 'prompt clear reports failure when one key cannot clear');
assertEqual(clearFailureResult.error.code, 'RECURSION_PROMPT_CLEAR_FAILED', 'prompt clear returns stable failure code');
assert(clearFailurePrompts.some((entry) => entry.key === 'recursion.guidance' && entry.text === ''), 'prompt clear attempted failing known key');
assert(clearFailurePrompts.some((entry) => entry.key === 'recursion.cardEvidence' && entry.text === ''), 'prompt clear continues after failed key');
assert(clearFailurePrompts.some((entry) => entry.key === 'recursion.guardrails' && entry.text === ''), 'prompt clear still clears later known key');

const installAfterFailedClearPrompts = [];
const installAfterFailedClearHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'install-after-failed-clear-chat',
    chat: [],
    setExtensionPrompt(key, text, position, depth, scan, role) {
      installAfterFailedClearPrompts.push({ key, text, position, depth, scan, role });
      if (key === 'recursion.guidance' && text === '') {
        throw new Error('simulated pre-install clear failure');
      }
    },
    extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
    extension_prompt_roles: { SYSTEM: 0 }
  }),
  settingsRoot: {}
});
await assertRejects(
  async () => installAfterFailedClearHost.prompt.install(packet),
  /prompt clear failed/i,
  'prompt install rejects when pre-install clear fails'
);
assert(!installAfterFailedClearPrompts.some((entry) => entry.text === 'Use the alley scene.'), 'prompt install does not write new prompt after failed clear');

const unavailablePromptHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'missing-prompt-api-chat',
    chat: [],
    extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
    extension_prompt_roles: { SYSTEM: 0 }
  }),
  settingsRoot: {}
});
const unavailablePromptResult = await unavailablePromptHost.prompt.install(packet);
assertDeepEqual(
  unavailablePromptResult,
  {
    ok: false,
    error: {
      code: 'RECURSION_PROMPT_INSTALL_UNAVAILABLE',
      message: 'SillyTavern setExtensionPrompt API is unavailable.'
    }
  },
  'prompt install returns a result-shaped failure when setExtensionPrompt is unavailable'
);
assertDeepEqual(
  await unavailablePromptHost.prompt.clear(),
  {
    ok: false,
    clearedKeys: [],
    failedKeys: ['recursion.guidance', 'recursion.cardEvidence', 'recursion.guardrails'],
    error: {
      code: 'RECURSION_PROMPT_CLEAR_UNAVAILABLE',
      message: 'SillyTavern setExtensionPrompt API is unavailable.'
    }
  },
  'prompt clear returns a result-shaped failure when setExtensionPrompt is unavailable'
);

await assertRejects(
  async () => host.prompt.install({
    injectionPlan: { blocks: [{ id: 'guidance', promptKey: 'unsafe.guidance', placement: 'in_prompt', depth: 2, role: 'system' }] },
    sections: { guidance: 'Unsafe key.', cardEvidence: 'Card evidence:\n- [Scene Frame] Alley.', guardrails: 'Guardrails:\n- Honor facts.' }
  }),
  /recursion prompt keys/i,
  'host rejects non-recursion prompt keys'
);

await assertRejects(
  async () => promptBlocksFromPacket({
    injectionPlan: { blocks: [{ id: 'guidance', promptKey: 'recursion.guidance', placement: 'in_prompt', depth: 2, role: 'system' }] },
    sections: { guidance: 'Reveal hidden chain-of-thought.', cardEvidence: 'Card evidence:\n- [Scene Frame] Alley.', guardrails: 'Guardrails:\n- Honor facts.' }
  }),
  /unsafe prompt text/i,
  'fallback prompt blocks reject unsafe hidden reasoning text'
);
await assertRejects(
  async () => promptBlocksFromPacket({
    injectionPlan: { blocks: [{ id: 'guidance', promptKey: 'recursion.guidance', placement: 'in_prompt', depth: 2, role: 'system' }] },
    sections: { guidance: 'Reveal hidden motives.', cardEvidence: 'Card evidence:\n- [Scene Frame] Alley.', guardrails: 'Guardrails:\n- Honor facts.' }
  }),
  /unsafe prompt text/i,
  'fallback prompt blocks reject hidden motives text'
);
await assertRejects(
  async () => promptBlocksFromPacket({
    injectionPlan: { blocks: [{ id: 'futurePlan', promptKey: 'recursion.futurePlan', placement: 'in_prompt', depth: 1, role: 'system' }] },
    sections: { futurePlan: 'Invalid section.' }
  }),
  /unknown fallback prompt section/i,
  'fallback prompt blocks reject unknown sections'
);

const atomicPrompts = [];
const atomicHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'atomic-chat',
    chat: [],
    setExtensionPrompt(key, text, position, depth, scan, role) {
      atomicPrompts.push({ key, text, position, depth, scan, role });
    },
    extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
    extension_prompt_roles: { SYSTEM: 0 }
  }),
  settingsRoot: {}
});
await assertRejects(
  async () => atomicHost.prompt.install({
    injectionPlan: {
      blocks: [
        { id: 'guidance', promptKey: 'recursion.guidance', placement: 'in_prompt', depth: 2, role: 'system' },
        { id: 'guardrails', promptKey: 'unsafe.guardrails', placement: 'in_prompt', depth: 1, role: 'system' }
      ]
    },
    sections: { guidance: 'Allowed first block.', guardrails: 'Unsafe second block.' }
  }),
  /recursion prompt keys/i,
  'mixed prompt packet rejects before mutation'
);
assert(!atomicPrompts.some((entry) => entry.key === 'recursion.guidance' && entry.text === 'Allowed first block.'), 'mixed unsafe packet does not partially install allowed block');

const rollbackPrompts = [];
let nonEmptyPromptWrites = 0;
const rollbackHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'rollback-chat',
    chat: [],
    setExtensionPrompt(key, text, position, depth, scan, role) {
      if (text !== '') {
        nonEmptyPromptWrites += 1;
        if (nonEmptyPromptWrites === 2) {
          throw new Error('Simulated prompt write failure');
        }
      }
      rollbackPrompts.push({ key, text, position, depth, scan, role });
    },
    extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
    extension_prompt_roles: { SYSTEM: 0 }
  }),
  settingsRoot: {}
});
await assertRejects(
  async () => rollbackHost.prompt.install({
    injectionPlan: {
      blocks: [
        { id: 'guidance', promptKey: 'recursion.guidance', placement: 'in_prompt', depth: 1, role: 'system' },
        { id: 'cardEvidence', promptKey: 'recursion.cardEvidence', placement: 'in_prompt', depth: 2, role: 'system' },
        { id: 'guardrails', promptKey: 'recursion.guardrails', placement: 'in_prompt', depth: 1, role: 'system' }
      ]
    },
    sections: {
      guidance: 'Install first block.',
      cardEvidence: 'Fail on second block.',
      guardrails: 'Never reached block.'
    }
  }),
  /simulated prompt write failure/i,
  'prompt install rejects original write failure'
);
assertEqual(
  rollbackPrompts.filter((entry) => entry.key === 'recursion.guidance').at(-1)?.text,
  '',
  'failed prompt install rolls back prior installed prompt key'
);

const storageFetchCalls = [];
const storageFiles = new Map();
const storageHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'storage-chat',
    chat: [],
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'token-from-context' })
  }),
  settingsRoot: {},
  fetchImpl: async (url, options = {}) => {
    storageFetchCalls.push({ url, options });
    if (url === '/api/files/upload') {
      const body = JSON.parse(options.body);
      storageFiles.set(body.name, JSON.parse(Buffer.from(body.data, 'base64').toString('utf8')));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url === '/api/files/verify') {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => Object.fromEntries((body.urls || []).map((entry) => {
          const name = decodeURIComponent(String(entry).replace('/user/files/', ''));
          return [entry, storageFiles.has(name)];
        }))
      };
    }
    if (url.startsWith('/user/files/')) {
      const name = decodeURIComponent(url.slice('/user/files/'.length));
      if (!storageFiles.has(name)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => storageFiles.get(name) };
    }
    if (url === '/api/files/delete') {
      const body = JSON.parse(options.body);
      const name = body.path.slice('/user/files/'.length);
      if (!storageFiles.has(name)) return { ok: false, status: 404, json: async () => ({}) };
      storageFiles.delete(name);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }
});
await storageHost.storageAdapter.writeJson('recursion-system-index.v1.json', { ok: true });
assertEqual(storageFetchCalls[0]?.url, '/api/files/upload', 'default storage writes through SillyTavern upload API');
assertEqual(JSON.parse(storageFetchCalls[0].options.body).name, 'recursion-system-index.v1.json', 'default storage preserves safe json file name');
assertEqual(storageFetchCalls[0].options.headers['X-CSRF-Token'], 'token-from-context', 'default storage uses context request headers');
assertEqual(storageFetchCalls[0].options.headers['Content-Type'], 'application/json', 'default storage sets json content type');
assertDeepEqual(
  await storageHost.storageAdapter.readJson('recursion-system-index.v1.json'),
  { ok: true },
  'default storage reads through user file API'
);
assert(storageFetchCalls.some((call) => call.url === '/user/files/recursion-system-index.v1.json'), 'default storage reads from user files path');
await storageHost.storageAdapter.deleteJson('recursion-system-index.v1.json');
const deleteCall = storageFetchCalls.find((call) => call.url === '/api/files/delete');
assert(deleteCall, 'default storage deletes through SillyTavern delete API');
assertEqual(JSON.parse(deleteCall.options.body).path, '/user/files/recursion-system-index.v1.json', 'default storage deletes user file path');
const missingReadCountBefore = storageFetchCalls.filter((call) => call.url === '/user/files/recursion-system-index.v1.json').length;
assertEqual(await storageHost.storageAdapter.readJson('recursion-system-index.v1.json'), null, 'default storage returns null for missing user files');
assert(storageFetchCalls.some((call) => call.url === '/api/files/verify'), 'default storage verifies missing user files before GET');
assertEqual(
  storageFetchCalls.filter((call) => call.url === '/user/files/recursion-system-index.v1.json').length,
  missingReadCountBefore,
  'default storage does not issue missing user-file GET after verify says absent'
);
await storageHost.storageAdapter.writeJson('recursion-after-404.v1.json', { ok: 'host' });
assert(storageFetchCalls.some((call) => call.url === '/api/files/upload' && JSON.parse(call.options.body).name === 'recursion-after-404.v1.json'), 'missing user file reads do not force memory fallback');
assertDeepEqual(
  await storageHost.storageAdapter.deleteJson('recursion-missing-delete.v1.json'),
  { ok: true, key: 'recursion-missing-delete.v1.json', missing: true },
  'default storage treats missing deletes as already gone'
);
await storageHost.storageAdapter.writeJson('recursion-after-delete-404.v1.json', { ok: 'host-after-delete' });
assert(
  storageFetchCalls.some((call) => call.url === '/api/files/upload' && JSON.parse(call.options.body).name === 'recursion-after-delete-404.v1.json'),
  'missing user file deletes do not force memory fallback'
);
const storageFetchCountBeforeRejectedKeys = storageFetchCalls.length;
await assertRejects(
  async () => storageHost.storageAdapter.writeJson('../recursion-escape.v1.json', { ok: false }),
  /path traversal/i,
  'default storage rejects traversal keys'
);
await assertRejects(
  async () => storageHost.storageAdapter.writeJson('recursion-not-json.txt', { ok: false }),
  /\.json/i,
  'default storage rejects non-json keys'
);
await assertRejects(
  async () => storageHost.storageAdapter.readJson('recursion/bad.v1.json'),
  /path traversal/i,
  'default storage rejects slash keys'
);
assertEqual(storageFetchCalls.length, storageFetchCountBeforeRejectedKeys, 'default storage rejects unsafe keys before fetch');

const fallbackUploadCalls = [];
let fallbackUploadAttempts = 0;
const fallbackUploadFiles = new Map();
const fallbackUploadHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'fallback-upload-chat',
    chat: [],
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'fallback-token' })
  }),
  settingsRoot: {},
  fetchImpl: async (url, options = {}) => {
    fallbackUploadCalls.push({ url, options });
    if (url === '/api/files/upload') {
      fallbackUploadAttempts += 1;
      if (fallbackUploadAttempts === 1) return { ok: false, status: 500, json: async () => ({ error: 'disk unavailable' }) };
      const body = JSON.parse(options.body);
      fallbackUploadFiles.set(body.name, JSON.parse(Buffer.from(body.data, 'base64').toString('utf8')));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url === '/api/files/verify') {
      const body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => Object.fromEntries((body.urls || []).map((entry) => [entry, fallbackUploadFiles.has(decodeURIComponent(String(entry).split('/').at(-1)))])) };
    }
    if (url.startsWith('/user/files/')) {
      const name = decodeURIComponent(url.slice('/user/files/'.length));
      return fallbackUploadFiles.has(name)
        ? { ok: true, status: 200, json: async () => fallbackUploadFiles.get(name) }
        : { ok: false, status: 404, json: async () => ({}) };
    }
    throw new Error(`Unexpected fallback fetch URL: ${url}`);
  }
});
assertDeepEqual(
  await fallbackUploadHost.storageAdapter.writeJson('recursion-fallback-upload.v1.json', { fallback: true }),
  { ok: true, key: 'recursion-fallback-upload.v1.json' },
  'default storage retries transient upload failures before memory fallback'
);
assertDeepEqual(
  await fallbackUploadHost.storageAdapter.readJson('recursion-fallback-upload.v1.json'),
  { fallback: true },
  'default storage reads the durable value after retry'
);
assertEqual(fallbackUploadAttempts, 2, 'default storage retries durable upload once');
const fallbackUploadCallCountBeforeRejectedKeys = fallbackUploadCalls.length;
await assertRejects(
  async () => fallbackUploadHost.storageAdapter.writeJson('../recursion-fallback-escape.v1.json', { ok: false }),
  /path traversal/i,
  'fallback storage rejects traversal keys before memory fallback'
);
await assertRejects(
  async () => fallbackUploadHost.storageAdapter.readJson('recursion-fallback-not-json.txt'),
  /\.json/i,
  'fallback storage rejects non-json keys before memory fallback'
);
assertEqual(fallbackUploadCalls.length, fallbackUploadCallCountBeforeRejectedKeys, 'fallback storage rejects unsafe keys without extra fetch');

const fallbackThrownUploadCalls = [];
const fallbackThrownUploadHost = createSillyTavernHost({
  contextFactory: () => ({ chatId: 'fallback-thrown-upload-chat', chat: [] }),
  settingsRoot: {},
  fetchImpl: async (url, options = {}) => {
    fallbackThrownUploadCalls.push({ url, options });
    throw new Error('simulated user-file API outage');
  }
});
const circularStorageValue = {};
circularStorageValue.self = circularStorageValue;
await assertRejects(
  async () => fallbackThrownUploadHost.storageAdapter.writeJson('recursion-unserializable.v1.json', circularStorageValue),
  /circular|converting/i,
  'default storage rejects JSON serialization errors before user-file fallback'
);
await assertRejects(
  async () => fallbackThrownUploadHost.storageAdapter.writeJson('recursion-undefined-value.v1.json', undefined),
  /json-serializable/i,
  'default storage rejects top-level undefined before user-file fallback'
);
await assertRejects(
  async () => fallbackThrownUploadHost.storageAdapter.writeJson('recursion-function-value.v1.json', () => {}),
  /json-serializable/i,
  'default storage rejects top-level functions before user-file fallback'
);
await assertRejects(
  async () => fallbackThrownUploadHost.storageAdapter.writeJson('recursion-symbol-value.v1.json', Symbol('storage')),
  /json-serializable/i,
  'default storage rejects top-level symbols before user-file fallback'
);
assertEqual(fallbackThrownUploadCalls.length, 0, 'default storage does not fetch when JSON serialization fails');
assertDeepEqual(
  await fallbackThrownUploadHost.storageAdapter.writeJson('recursion-fallback-thrown-upload.v1.json', { outage: true }),
  {
    ok: true,
    key: 'recursion-fallback-thrown-upload.v1.json',
    fallback: 'memory',
    reason: 'memory-fallback',
    fallbackReason: 'write failed for recursion-fallback-thrown-upload.v1.json: simulated user-file API outage'
  },
  'default storage reports thrown upload failures as memory fallback'
);
assertDeepEqual(
  await fallbackThrownUploadHost.storageAdapter.readJson('recursion-fallback-thrown-upload.v1.json'),
  { outage: true },
  'default storage reads memory value after thrown upload fallback'
);
assertEqual(fallbackThrownUploadCalls.length, 3, 'default storage retries durable reads after thrown upload fallback');

const previousSillyTavern = globalThis.SillyTavern;
const globalHeaderCalls = [];
try {
  globalThis.SillyTavern = {
    getContext: () => ({
      chatId: 'global-storage-chat',
      chat: [],
      getRequestHeaders: () => ({ 'X-CSRF-Token': 'global-token' })
    })
  };
  const globalHeaderHost = createSillyTavernHost({
    settingsRoot: {},
    fetchImpl: async (url, options = {}) => {
      globalHeaderCalls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  await globalHeaderHost.storageAdapter.writeJson('recursion-global-header.v1.json', { ok: true });
  assertEqual(globalHeaderCalls[0].options.headers['X-CSRF-Token'], 'global-token', 'default storage uses global SillyTavern request headers');
} finally {
  if (previousSillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousSillyTavern;
}

{
  let saveCount = 0;
  const contextSettings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  const contextSettingsHost = createSillyTavernHost({
    contextFactory: () => ({
      currentChatId: 'context-settings-chat',
      chat: [],
      extensionSettings: contextSettings,
      saveSettingsDebounced: () => {
        saveCount += 1;
      }
    })
  });
  contextSettingsHost.settingsStore.update({ mode: 'manual' });
  assertEqual(contextSettings.recursion.mode, 'manual', 'host defaults to SillyTavern context extensionSettings');
  assertEqual(saveCount, 1, 'host defaults to SillyTavern context saveSettingsDebounced');
}

{
  const liveContext = {
    currentChatId: 'live-settings-chat',
    chat: [],
    extensionSettings: { memory: {} },
    saveSettingsDebounced: () => {}
  };
  const liveSettingsHost = createSillyTavernHost({
    contextFactory: () => liveContext
  });
  liveContext.extensionSettings = { recursion: { mode: 'manual', reasonerUse: 'off' } };
  assertEqual(liveSettingsHost.settingsStore.get().mode, 'manual', 'host settings root follows late SillyTavern settings replacement');
  liveSettingsHost.settingsStore.update({ mode: 'auto' });
  assertEqual(liveContext.extensionSettings.recursion.mode, 'auto', 'host settings writes target the latest SillyTavern settings root');
}

const quietCalls = [];
const quietHost = createSillyTavernHost({
  contextFactory: () => ({
    currentChatId: 'quiet-chat',
    chat: [],
    generateQuietPrompt: async (prompt) => {
      quietCalls.push(prompt);
      return 'quiet text';
    }
  }),
  settingsRoot: {}
});
const quietResponse = await quietHost.generation.generate({ prompt: 'Fallback prompt' });
assertEqual(quietResponse.text, 'quiet text', 'quiet generation result normalized');
assertEqual(quietCalls[0], 'Fallback prompt', 'quiet fallback receives prompt');

{
  const generateCalls = [];
  const startHost = createSillyTavernHost({
    contextFactory: () => ({
      currentChatId: 'start-chat',
      chat: [],
      generate: async (type, options) => {
        generateCalls.push({ type, options });
        return { native: true };
      }
    }),
    settingsRoot: {}
  });
  assertEqual(typeof startHost.generation.start, 'function', 'host exposes native generation start');
  const startResult = await startHost.generation.start({ type: 'regenerate', source: 'recursion-ui' });
  assertEqual(startResult.ok, true, 'host native generation start succeeds');
  assertEqual(startResult.started, true, 'host native generation start reports started');
  assertEqual(startResult.type, 'regenerate', 'host native generation start reports regenerate type');
  assertEqual(startResult.source, 'context.generate', 'host native generation start uses SillyTavern context Generate');
  assertDeepEqual(generateCalls, [{ type: 'regenerate', options: {} }], 'host native generation start calls SillyTavern Generate once');
}

{
  const unavailableStartHost = createSillyTavernHost({
    contextFactory: () => ({
      currentChatId: 'start-unavailable-chat',
      chat: []
    }),
    settingsRoot: {}
  });
  const startResult = await unavailableStartHost.generation.start({ type: 'regenerate', source: 'recursion-ui' });
  assertEqual(startResult.ok, false, 'host native generation start reports unavailable start support');
  assertEqual(startResult.error.code, 'RECURSION_HOST_GENERATION_UNAVAILABLE', 'host native generation start returns stable unavailable error code');
}

{
  const stopCalls = [];
  const stopHost = createSillyTavernHost({
    contextFactory: () => ({
      currentChatId: 'stop-chat',
      chat: [],
      stopGeneration: () => {
        stopCalls.push('stop');
        return true;
      }
    }),
    settingsRoot: {}
  });
  assertEqual(typeof stopHost.generation.stop, 'function', 'host exposes generation stop');
  const stopResult = await stopHost.generation.stop({ source: 'recursion-ui' });
  assertDeepEqual(
    stopResult,
    { ok: true, stopped: true, eventEmitted: true, source: 'context.stopGeneration' },
    'host stop uses SillyTavern context stopGeneration'
  );
  assertDeepEqual(stopCalls, ['stop'], 'host stop calls SillyTavern generation stop once');
}

{
  const controlCalls = [];
  const controlHost = createSillyTavernHost({
    contextFactory: () => ({
      currentChatId: 'generation-control-chat',
      chat: [],
      deactivateSendButtons: () => controlCalls.push('lock'),
      activateSendButtons: () => controlCalls.push('unlock'),
      swipe: {
        hide: () => controlCalls.push('hide-swipes')
      }
    }),
    settingsRoot: {}
  });
  assertEqual((await controlHost.generation.lockControls({ source: 'editorial' })).ok, true, 'host locks native generation controls');
  assertEqual((await controlHost.generation.unlockControls({ source: 'editorial' })).ok, true, 'host unlocks native generation controls');
  assertDeepEqual(controlCalls, ['lock', 'hide-swipes', 'unlock'], 'host generation control lock uses SillyTavern supported controls');
}

{
  const unavailableStopHost = createSillyTavernHost({
    contextFactory: () => ({
      currentChatId: 'stop-unavailable-chat',
      chat: []
    }),
    settingsRoot: {}
  });
  const stopResult = await unavailableStopHost.generation.stop({ source: 'recursion-ui' });
  assertEqual(stopResult.ok, false, 'host stop reports unavailable stop support');
  assertEqual(stopResult.error.code, 'RECURSION_HOST_STOP_UNAVAILABLE', 'host stop returns stable unavailable error code');
}

{
  const batchCalls = [];
  const batchSlotEvents = [];
  let releaseFirst = null;
  const concurrentBatchHost = createSillyTavernHost({
    contextFactory: () => ({
      currentChatId: 'concurrent-batch-chat',
      chat: [],
      generateRaw: async (request) => {
        batchCalls.push(request.prompt);
        if (request.prompt === 'slow first') {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { text: `batch:${request.prompt}` };
      }
    }),
    settingsRoot: {}
  });
  assertDeepEqual(
    concurrentBatchHost.generation.capabilities?.batch,
    {
      mode: 'concurrent',
      maxConcurrency: 4,
      slotIsolation: true,
      supportsAbortSignal: true,
      source: 'sillytavern-host-adapter'
    },
    'host batch advertises concurrent slot-isolated capability'
  );
  const pendingBatch = concurrentBatchHost.generation.batch([
    { roleId: 'utilityArbiter', prompt: 'slow first', responseSchema: 'recursion.utilityArbiter.v1' },
    { roleId: 'providerTest', prompt: 'fast second', responseSchema: 'recursion.providerTest.v1' }
  ], {
    onSlotSettled: (slot) => batchSlotEvents.push(slot)
  });
  await flushMicrotasks();
  const submittedBeforeFirstSettled = [...batchCalls];
  assertDeepEqual(
    batchSlotEvents.map((slot) => [slot.index, slot.response?.text]),
    [[1, 'batch:fast second']],
    'host batch reports fast slot settlement before the blocked slot resolves'
  );
  releaseFirst();
  const batchResults = await pendingBatch;
  assertDeepEqual(
    submittedBeforeFirstSettled,
    ['slow first', 'fast second'],
    'host batch submits sibling requests before first request settles'
  );
  assertDeepEqual(
    batchResults.map((entry) => entry.text),
    [
      'batch:slow first',
      'batch:fast second'
    ],
    'host batch preserves response order after concurrent submission'
  );

  const isolatedFailureHost = createSillyTavernHost({
    contextFactory: () => ({
      currentChatId: 'isolated-batch-chat',
      chat: [],
      generateRaw: async (request) => {
        if (request.prompt === 'bad second') {
          const error = new Error('isolated host slot failed');
          error.code = 'RECURSION_TEST_HOST_SLOT_FAILED';
          throw error;
        }
        return { text: `batch:${request.prompt}` };
      }
    }),
    settingsRoot: {}
  });
  const isolatedFailureBatch = await isolatedFailureHost.generation.batch([
    { roleId: 'utilityArbiter', prompt: 'good first', responseSchema: 'recursion.utilityArbiter.v1' },
    { roleId: 'providerTest', prompt: 'bad second', responseSchema: 'recursion.providerTest.v1' }
  ]);
  assertEqual(isolatedFailureBatch[0].text, 'batch:good first', 'host batch keeps successful slot when sibling fails');
  assertEqual(isolatedFailureBatch[1].ok, false, 'host batch returns per-slot failure envelope');
  assertEqual(isolatedFailureBatch[1].error.code, 'RECURSION_TEST_HOST_SLOT_FAILED', 'host batch preserves per-slot failure code');
}

const quietProfileHost = createSillyTavernHost({
  contextFactory: () => ({
    currentChatId: 'quiet-profile-chat',
    chat: [],
    generateQuietPrompt: async () => 'quiet profile text'
  }),
  settingsRoot: {
    recursion: {
      providers: {
        utility: {
          source: 'host-connection-profile',
          hostConnectionProfileId: 'quiet-profile-a'
        }
      }
    }
  }
});
const quietProfileResult = await createGenerationRouter({ client: quietProfileHost.providerClient }).generate('utilityArbiter', { prompt: 'Profile should not silently fall back.' });
assertEqual(quietProfileResult.ok, false, 'host profile route fails when only quiet generation is available');
assertEqual(quietProfileResult.error.code, 'RECURSION_HOST_PROFILE_UNSUPPORTED', 'host profile route reports unsupported API instead of current-model fallback');

const connectionProfileCalls = [];
const connectionProfileSignal = new AbortController().signal;
const connectionProfileHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'connection-profile-chat',
    chat: [],
    ConnectionManagerRequestService: {
      async sendRequest(profileId, messages, maxTokens, requestOptions, parameters) {
        connectionProfileCalls.push({ profileId, messages, maxTokens, requestOptions, parameters });
        return { text: '{"schema":"recursion.utilityArbiter.v1","ok":true}' };
      }
    }
  }),
  settingsRoot: {
    recursion: {
      providers: {
        utility: {
          source: 'host-connection-profile',
          hostConnectionProfileId: 'utility-profile-service',
          maxTokens: 512,
          temperature: 0.15,
          topP: 0.7
        }
      }
    }
  }
});
const connectionProfileResult = await createGenerationRouter({ client: connectionProfileHost.providerClient }).generate('utilityArbiter', {
  prompt: 'Use profile service.',
  systemPrompt: 'System profile service.',
  snapshotHash: 'profile-snapshot-hash',
  reasoningCategory: 'final-brief',
  reasoningIntent: 'medium',
  signal: connectionProfileSignal
});
assertEqual(connectionProfileResult.ok, true, 'host connection profile routes through ConnectionManagerRequestService when available');
assertEqual(connectionProfileCalls[0].profileId, 'utility-profile-service', 'connection profile service receives profile id');
assertDeepEqual(
  connectionProfileCalls[0].messages,
  [
    { role: 'system', content: 'System profile service.' },
    { role: 'user', content: 'Use profile service.' }
  ],
  'connection profile service receives system and user messages'
);
assertEqual(connectionProfileCalls[0].maxTokens, 512, 'connection profile service receives configured max tokens');
assertEqual(connectionProfileCalls[0].requestOptions.stream, false, 'connection profile service disables streaming for structured calls');
assertEqual(connectionProfileCalls[0].requestOptions.extractData, false, 'connection profile service preserves raw structured output for Recursion parsing and recovery');
assertEqual(connectionProfileCalls[0].requestOptions.includePreset, false, 'connection profile service skips host preset for machine JSON');
assertEqual(connectionProfileCalls[0].requestOptions.includeInstruct, false, 'connection profile service skips host instruct for machine JSON');
assertEqual(connectionProfileCalls[0].parameters.json_schema.name, 'recursion_utilityArbiter_v1', 'connection profile service receives JSON schema name');
assertEqual(connectionProfileCalls[0].parameters.json_schema.value.properties.schema.const, 'recursion.utilityArbiter.v1', 'connection profile service constrains provider schema');
assertEqual(connectionProfileCalls[0].parameters.json_schema.value.properties.snapshotHash.const, 'profile-snapshot-hash', 'connection profile service constrains snapshot hash');
assert(connectionProfileCalls[0].parameters.json_schema.value.required.includes('snapshotHash'), 'connection profile service requires snapshot hash');
assertDeepEqual(
  connectionProfileCalls[0].parameters.reasoning,
  { intent: 'medium', category: 'final-brief', exclude: true },
  'connection profile service receives sanitized reasoning intent'
);
assertEqual(connectionProfileCalls[0].parameters.temperature, 0.15, 'connection profile service receives configured temperature');
assertEqual(connectionProfileCalls[0].parameters.top_p, 0.7, 'connection profile service receives configured top p');
const cappedConnectionProfileResult = await createGenerationRouter({ client: connectionProfileHost.providerClient }).generate('utilityArbiter', {
  prompt: 'Use the configured profile ceiling.',
  snapshotHash: 'profile-capped-snapshot-hash',
  responseLength: 900
});
assertEqual(cappedConnectionProfileResult.ok, true, 'host connection profile accepts an oversized request budget');
assertEqual(connectionProfileCalls[1].maxTokens, 512, 'host connection profile request cannot exceed configured lane max tokens');
assert(typeof connectionProfileCalls[0].parameters.signal?.addEventListener === 'function', 'connection profile service receives abort-capable provider signal');
assertEqual(connectionProfileCalls[0].parameters.signal.aborted, false, 'connection profile service receives active provider signal');

const currentModelRawCalls = [];
const currentModelProfileCalls = [];
const currentModelHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'current-model-stale-profile-chat',
    chat: [],
    generateRaw: async (request) => {
      currentModelRawCalls.push(request);
      return { text: '{"schema":"recursion.utilityArbiter.v1","ok":true}' };
    },
    ConnectionManagerRequestService: {
      async sendRequest(profileId, messages, maxTokens, requestOptions, parameters) {
        currentModelProfileCalls.push({ profileId, messages, maxTokens, requestOptions, parameters });
        return { text: '{"schema":"recursion.utilityArbiter.v1","ok":true}' };
      }
    }
  }),
  settingsRoot: {
    recursion: {
      providers: {
        utility: {
          source: 'host-current-model',
          hostConnectionProfileId: 'stale-utility-profile',
          maxTokens: 654,
          temperature: 0.33,
          topP: 0.8
        }
      }
    }
  }
});
const currentModelRouted = await createGenerationRouter({ client: currentModelHost.providerClient }).generate('utilityArbiter', { prompt: 'Use current model.' });
assertEqual(currentModelRouted.ok, true, 'host current model routes successfully with stale profile id');
assertEqual(currentModelProfileCalls.length, 0, 'host current model does not call connection profile service with stale profile id');
assertEqual(currentModelRawCalls.length, 1, 'host current model uses generateRaw when available');
assertEqual(currentModelRawCalls[0].providerSource, 'host-current-model', 'host current model source is passed to generateRaw');
assertEqual(
  Object.prototype.hasOwnProperty.call(currentModelRawCalls[0], 'hostConnectionProfileId'),
  false,
  'host current model generateRaw request omits stale profile id'
);

const stableSceneMessages = [{ mesid: 1, is_user: true, mes: 'First turn in the same scene.' }];
const stableSceneHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'stable-scene-chat',
    chat: stableSceneMessages
  }),
  settingsRoot: {}
});
const firstStableScene = await stableSceneHost.snapshot();
stableSceneMessages.push({ mesid: 2, is_user: false, mes: 'Second turn without a scene break.' });
const secondStableScene = await stableSceneHost.snapshot();
assertEqual(secondStableScene.chatKey, firstStableScene.chatKey, 'stable scene regression keeps chat key');
assertEqual(secondStableScene.sceneKey, firstStableScene.sceneKey, 'ordinary new messages reuse the same scene cache key');
assert(secondStableScene.turnFingerprint !== firstStableScene.turnFingerprint, 'turn fingerprint still changes across messages');

const metadataChatHost = createSillyTavernHost({
  contextFactory: () => ({
    chatMetadata: { chat_id: 'Metadata/Chat File.jsonl' },
    chat: []
  }),
  settingsRoot: {}
});
const metadataChatSnapshot = await metadataChatHost.snapshot();
assertEqual(metadataChatSnapshot.chatId, 'Metadata/Chat File.jsonl', 'chatMetadata chat_id is used when direct chat id is missing');
assertEqual(metadataChatSnapshot.chatKey, 'Metadata-Chat-File.jsonl', 'metadata chat id is normalized into chat key');

const entitySceneContext = {
  chatId: 'entity-scene-chat',
  characterId: 'character-a',
  chat: [{ mesid: 1, is_user: true, mes: 'Scene anchor test.' }]
};
const entitySceneHost = createSillyTavernHost({
  contextFactory: () => entitySceneContext,
  settingsRoot: {}
});
const firstEntityScene = await entitySceneHost.snapshot();
entitySceneContext.characterId = 'character-b';
const secondEntityScene = await entitySceneHost.snapshot();
assertEqual(secondEntityScene.chatKey, firstEntityScene.chatKey, 'entity scene anchor keeps chat key stable');
assert(secondEntityScene.sceneFingerprint !== firstEntityScene.sceneFingerprint, 'entity change updates host scene fingerprint');
assert(secondEntityScene.sceneKey !== firstEntityScene.sceneKey, 'entity change updates host scene cache key');

const rawCalls = [];
const rawResponse = await host.generation.generate({
  prompt: 'Return JSON',
  systemPrompt: 'System',
  responseLength: 123,
  jsonSchema: { type: 'object' },
  signal: 'signal-token'
});
assertEqual(rawResponse.text, '{"schema":"x"}', 'raw generation result preserved');
const structuredContent = { schema: 'recursion.utilityArbiter.v1', ok: true };
context.generateRaw = async () => ({ content: structuredContent, reasoning: { hidden: 'not prompt text' } });
const structuredContentResponse = await host.generation.generate({ prompt: 'Return extracted JSON object' });
assertEqual(
  structuredContentResponse.text,
  JSON.stringify(structuredContent),
  'object-shaped host generation content is preserved as parseable JSON text'
);
context.generateRaw = async () => ({
  message: {
    role: 'assistant',
    content: JSON.stringify(structuredContent),
    reasoning: 'hidden provider reasoning must not become visible text',
    reasoning_details: [{ text: 'hidden provider reasoning detail' }]
  }
});
const chatMessageEnvelopeResponse = await host.generation.generate({ prompt: 'Return extracted chat message JSON content' });
assertEqual(
  chatMessageEnvelopeResponse.text,
  JSON.stringify(structuredContent),
  'host generation message envelopes use visible content without serializing reasoning fields'
);
context.generateRaw = async (request) => {
  rawCalls.push(request);
  return { text: '{"schema":"recursion.utilityArbiter.v1","ok":true}' };
};
const routed = await createGenerationRouter({ client: host.providerClient }).generate('utilityArbiter', { prompt: 'Route through provider client' });
assertEqual(routed.ok, true, 'provider client routes through host generation');
assertEqual(rawCalls[0].prompt, 'Route through provider client', 'provider client sends prompt to host');
assertEqual(rawCalls[0].responseLength, 8192, 'provider client default maxTokens pass through to responseLength');
assertEqual(rawCalls[0].temperature, 0.1, 'provider client temperature pass through');
assertEqual(rawCalls[0].topP, 0.95, 'provider client topP pass through');
const reasonedRouted = await createGenerationRouter({ client: host.providerClient }).generate('utilityArbiter', {
  prompt: 'Route through provider client with reasoning metadata',
  reasoningCategory: 'arbiter',
  reasoningIntent: 'high'
});
assertEqual(reasonedRouted.ok, true, 'provider client routes host current model reasoning metadata');
assertEqual(rawCalls[1].reasoningCategory, 'arbiter', 'host generateRaw receives reasoning category');
assertEqual(rawCalls[1].reasoningIntent, 'high', 'host generateRaw receives reasoning intent');

const profileCalls = [];
const profileHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'profile-chat',
    chat: [],
    generateRaw: async (request) => {
      profileCalls.push(request);
      return { text: '{"schema":"recursion.utilityArbiter.v1","ok":true}' };
    }
  }),
  settingsRoot: {
    recursion: {
      providers: {
        utility: {
          source: 'host-connection-profile',
          hostConnectionProfileId: 'utility-profile-a',
          maxTokens: 321,
          temperature: 0.2,
          topP: 0.75
        }
      }
    }
  }
});
const profileRouted = await createGenerationRouter({ client: profileHost.providerClient }).generate('utilityArbiter', { prompt: 'Use profile.' });
assertEqual(profileRouted.ok, true, 'provider client routes host connection profile');
assertEqual(profileCalls[0].providerSource, 'host-connection-profile', 'host connection profile source is passed through');
assertEqual(profileCalls[0].hostConnectionProfileId, 'utility-profile-a', 'host connection profile id is passed through');
assertEqual(profileCalls[0].responseLength, 321, 'host connection profile max tokens are passed through');

const chatKeyHost = createSillyTavernHost({
  contextFactory: () => ({
    chat_id: 'Folder/Chat File.jsonl',
    chat: [
      { id: 'm-1', is_system: true, content: 'System note' },
      { index: 2, name: 'Mara', text: 'Look there.' },
      { mesid: 3, is_user: true, hidden: true, mes: 'Hidden user note.' }
    ]
  }),
  settingsRoot: {}
});
const chatKeySnap = await chatKeyHost.snapshot();
assertEqual(chatKeySnap.chatId, 'Folder/Chat File.jsonl', 'chat_id fallback read');
assertEqual(chatKeySnap.chatKey, 'Folder-Chat-File.jsonl', 'chat key normalized');
assertEqual(chatKeySnap.messages.length, 1, 'snapshot excludes system and hidden rows from source window');
assertEqual(chatKeySnap.messages[0].sender, 'Mara', 'sender name preserved');
assertEqual(chatKeySnap.messages[0].visible, true, 'visible source row stays visible in snapshot');
assertEqual(chatKeySnap.latestMesId, 3, 'latest message id derived');
assert(chatKeySnap.sceneFingerprint, 'scene fingerprint built');
assert(chatKeySnap.sceneKey, 'scene key built');
assert(chatKeySnap.turnFingerprint, 'turn fingerprint built');

console.log('[pass] host');
