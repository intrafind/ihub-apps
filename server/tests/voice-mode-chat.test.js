/**
 * Voice mode on the chat request (issue #2868): `voiceMode: true` adds the
 * localized voice style instruction after the app's system prompt, asks for a
 * low thinking level when that is safe, marks the stored user message as spoken,
 * and is ignored unless the platform allows voice mode.
 *
 * Native ESM: uses `jest.unstable_mockModule` + dynamic imports. Run (from server/):
 * node --experimental-vm-modules node_modules/jest/bin/jest.js tests/voice-mode-chat.test.js
 */

import { jest } from '@jest/globals';

const state = {
  platform: {},
  features: {},
  apps: [],
  models: []
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getApps: () => ({ data: state.apps }),
    getModels: () => ({ data: state.models }),
    getPlatform: () => state.platform,
    getFeatures: () => state.features
  }
}));

jest.unstable_mockModule('../adapters/index.js', () => ({
  createCompletionRequest: async () => ({ url: 'http://example.test', method: 'POST', body: {} })
}));

jest.unstable_mockModule('../toolLoader.js', () => ({
  getToolsForApp: async () => [],
  resolveAppNativeWebSearch: () => false,
  READ_URL_TOOL_ID: 'read_url'
}));

const { default: RequestBuilder } = await import('../services/chat/RequestBuilder.js');
const {
  DEFAULT_VOICE_INSTRUCTIONS,
  isVoiceTurn,
  resolveVoiceInstruction,
  appendVoiceInstruction,
  resolveVoiceThinkingLevel,
  VOICE_INPUT_MODE
} = await import('../services/chat/voiceMode.js');
const { storableMessageExtras } = await import('../services/chat/ChatRepository.js');
const { voiceModeClientConfig } = await import('../routes/chat/dataRoutes.js');

const APP_PROMPT = 'You are the HR assistant.';

const baseApp = {
  id: 'hr-app',
  name: { en: 'HR' },
  system: { en: APP_PROMPT, de: 'Du bist der HR-Assistent.' }
};
// `iassistant-conversation` needs no provider key, which keeps the key check out
// of the way; what the model can do is all these tests read from it.
const thinkingModel = {
  id: 'thinker',
  provider: 'iassistant-conversation',
  default: true,
  thinking: { enabled: true, level: 'high' }
};
const plainModel = { id: 'plain', provider: 'iassistant-conversation', default: true };

/** What `processMessageTemplates` does for the part that matters here: the app's system prompt. */
const withSystemPrompt = async (messages, app, style, outputFormat, language) => [
  { role: 'system', content: app?.system?.[language] || app?.system?.en || '' },
  ...messages
];

const request = overrides => ({
  appId: 'hr-app',
  messages: [{ role: 'user', content: 'How many vacation days do I have?' }],
  language: 'en',
  processMessageTemplates: withSystemPrompt,
  chatId: 'chat-1',
  user: { id: 'u1', permissions: { models: new Set(['*']) } },
  ...overrides
});

const voiceOn = () => {
  state.features = { voiceMode: true };
  state.platform = { speech: { voiceMode: { enabled: true } } };
};

const systemOf = result => result.data.llmMessages.find(m => m.role === 'system').content;

beforeEach(() => {
  state.platform = {};
  state.features = {};
  state.apps = [baseApp];
  state.models = [thinkingModel];
});

describe('isVoiceTurn', () => {
  test('needs the request flag, the feature flag and the platform switch', () => {
    const platform = { speech: { voiceMode: { enabled: true } } };
    expect(isVoiceTurn({ voiceMode: true, platform, features: { voiceMode: true } })).toBe(true);
    expect(isVoiceTurn({ voiceMode: false, platform, features: { voiceMode: true } })).toBe(false);
    expect(isVoiceTurn({ voiceMode: undefined, platform, features: { voiceMode: true } })).toBe(
      false
    );
    expect(isVoiceTurn({ voiceMode: true, platform, features: {} })).toBe(false);
    expect(isVoiceTurn({ voiceMode: true, platform, features: { voiceMode: false } })).toBe(false);
    expect(
      isVoiceTurn({
        voiceMode: true,
        platform: { speech: { voiceMode: { enabled: false } } },
        features: { voiceMode: true }
      })
    ).toBe(false);
    expect(isVoiceTurn({ voiceMode: true, platform: {}, features: { voiceMode: true } })).toBe(
      false
    );
  });

  test('only a literal true counts, and missing input never throws', () => {
    const platform = { speech: { voiceMode: { enabled: true } } };
    expect(isVoiceTurn({ voiceMode: 'true', platform, features: { voiceMode: true } })).toBe(false);
    expect(isVoiceTurn({ voiceMode: 1, platform, features: { voiceMode: true } })).toBe(false);
    expect(isVoiceTurn()).toBe(false);
    expect(isVoiceTurn({ voiceMode: true })).toBe(false);
  });
});

describe('resolveVoiceInstruction', () => {
  test('the built-in text is English and German, and English for any other language', () => {
    expect(resolveVoiceInstruction({ language: 'en' })).toBe(DEFAULT_VOICE_INSTRUCTIONS.en);
    expect(resolveVoiceInstruction({ language: 'de' })).toBe(DEFAULT_VOICE_INSTRUCTIONS.de);
    expect(resolveVoiceInstruction({ language: 'fr' })).toBe(DEFAULT_VOICE_INSTRUCTIONS.en);
    expect(resolveVoiceInstruction({})).toBe(DEFAULT_VOICE_INSTRUCTIONS.en);
    expect(resolveVoiceInstruction()).toBe(DEFAULT_VOICE_INSTRUCTIONS.en);
  });

  test('the English text says what the concept asks for', () => {
    const text = DEFAULT_VOICE_INSTRUCTIONS.en;
    expect(text).toMatch(/by voice and hears your answer read aloud/);
    expect(text).toMatch(/lead with the answer, usually 1-4 sentences/);
    expect(text).toMatch(/tables, code blocks, headings, bullet lists, URLs, or emoji/);
    expect(text).toMatch(/numbers and units the way they are spoken/);
    expect(text).toMatch(/summary and offer details/);
  });

  test('the German text is German and says the same', () => {
    const text = DEFAULT_VOICE_INSTRUCTIONS.de;
    expect(text).toMatch(/per Sprache/);
    expect(text).toMatch(/vorgelesen/);
    expect(text).toMatch(
      /Tabellen, Codeblöcke, Überschriften, Aufzählungslisten, URLs oder Emojis/
    );
    expect(text).not.toMatch(/\bthe\b/);
  });

  test('a regional language tag uses its base language, in any case', () => {
    expect(resolveVoiceInstruction({ language: 'de-DE' })).toBe(DEFAULT_VOICE_INSTRUCTIONS.de);
    expect(resolveVoiceInstruction({ language: 'DE' })).toBe(DEFAULT_VOICE_INSTRUCTIONS.de);
    expect(resolveVoiceInstruction({ language: 'de_AT' })).toBe(DEFAULT_VOICE_INSTRUCTIONS.de);
  });

  test('the platform text overrides the built-in one, for the request language', () => {
    const platform = {
      speech: { voiceMode: { systemPrompt: { en: 'Short answers.', de: 'Kurze Antworten.' } } }
    };
    expect(resolveVoiceInstruction({ platform, language: 'de' })).toBe('Kurze Antworten.');
    expect(resolveVoiceInstruction({ platform, language: 'de-DE' })).toBe('Kurze Antworten.');
    expect(resolveVoiceInstruction({ platform, language: 'en' })).toBe('Short answers.');
  });

  test('a regional platform text wins over the base language one', () => {
    const platform = {
      speech: { voiceMode: { systemPrompt: { 'de-AT': 'Servus.', de: 'Hallo.' } } }
    };
    expect(resolveVoiceInstruction({ platform, language: 'de-AT' })).toBe('Servus.');
    expect(resolveVoiceInstruction({ platform, language: 'de-DE' })).toBe('Hallo.');
  });

  test('the platform English text covers languages it has no text for, before the built-in one', () => {
    const platform = { speech: { voiceMode: { systemPrompt: { en: 'Short answers.' } } } };
    expect(resolveVoiceInstruction({ platform, language: 'de' })).toBe('Short answers.');
    expect(resolveVoiceInstruction({ platform, language: 'fr' })).toBe('Short answers.');
  });

  test('a platform text for another language only does not hide the built-in one', () => {
    const platform = { speech: { voiceMode: { systemPrompt: { fr: 'Réponses courtes.' } } } };
    expect(resolveVoiceInstruction({ platform, language: 'de' })).toBe(
      DEFAULT_VOICE_INSTRUCTIONS.de
    );
    expect(resolveVoiceInstruction({ platform, language: 'en' })).toBe(
      DEFAULT_VOICE_INSTRUCTIONS.en
    );
  });

  test('blank and malformed platform texts fall through to the built-in one', () => {
    for (const systemPrompt of [{}, { en: '', de: '   ' }, { en: 5 }, 'text', ['x'], null]) {
      const platform = { speech: { voiceMode: { systemPrompt } } };
      expect(resolveVoiceInstruction({ platform, language: 'de' })).toBe(
        DEFAULT_VOICE_INSTRUCTIONS.de
      );
    }
  });

  test('a platform text is cut at 4000 characters', () => {
    const platform = { speech: { voiceMode: { systemPrompt: { en: `${'a'.repeat(5000)}` } } } };
    expect(resolveVoiceInstruction({ platform, language: 'en' })).toHaveLength(4000);
  });

  test('a blank text of the request language falls through to the next one in the chain', () => {
    const platform = { speech: { voiceMode: { systemPrompt: { de: ' ', en: 'Short answers.' } } } };
    expect(resolveVoiceInstruction({ platform, language: 'de' })).toBe('Short answers.');
  });
});

describe('appendVoiceInstruction', () => {
  test('goes after the app prompt', () => {
    const messages = [
      { role: 'system', content: APP_PROMPT },
      { role: 'user', content: 'hi' }
    ];
    expect(appendVoiceInstruction(messages, 'Be brief.')).toBe(true);
    expect(messages[0].content).toBe(`${APP_PROMPT}\n\nBe brief.`);
    expect(messages).toHaveLength(2);
  });

  test('is the whole system prompt when the app has none', () => {
    const empty = [
      { role: 'system', content: '' },
      { role: 'user', content: 'hi' }
    ];
    appendVoiceInstruction(empty, 'Be brief.');
    expect(empty[0].content).toBe('Be brief.');

    const bypassed = [{ role: 'user', content: 'hi' }];
    expect(appendVoiceInstruction(bypassed, 'Be brief.')).toBe(true);
    expect(bypassed).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' }
    ]);
  });

  test('is added once', () => {
    const messages = [{ role: 'system', content: APP_PROMPT }];
    appendVoiceInstruction(messages, 'Be brief.');
    expect(appendVoiceInstruction(messages, 'Be brief.')).toBe(false);
    expect(messages[0].content).toBe(`${APP_PROMPT}\n\nBe brief.`);
  });

  test('leaves a system message it cannot append to alone', () => {
    const messages = [{ role: 'system', content: [{ type: 'text', text: 'x' }] }];
    expect(appendVoiceInstruction(messages, 'Be brief.')).toBe(false);
    expect(appendVoiceInstruction(null, 'Be brief.')).toBe(false);
    expect(appendVoiceInstruction([], '')).toBe(false);
  });
});

describe('resolveVoiceThinkingLevel', () => {
  const platform = { speech: { voiceMode: { enabled: true, thinkingLevel: 'low' } } };

  test('asks for the platform level for a model that thinks', () => {
    expect(resolveVoiceThinkingLevel({ platform, model: thinkingModel, app: baseApp })).toBe('low');
    expect(
      resolveVoiceThinkingLevel({
        platform: { speech: { voiceMode: { thinkingLevel: 'minimal' } } },
        model: thinkingModel
      })
    ).toBe('minimal');
  });

  test('is low when the platform says nothing', () => {
    expect(resolveVoiceThinkingLevel({ platform: {}, model: thinkingModel })).toBe('low');
  });

  test('never overrides a level the request carries', () => {
    for (const thinkingLevel of ['high', 'LOW', 'minimal']) {
      expect(resolveVoiceThinkingLevel({ platform, model: thinkingModel, thinkingLevel })).toBe(
        undefined
      );
    }
  });

  test('never overrides a level the app sets', () => {
    const app = { ...baseApp, thinking: { enabled: true, level: 'high' } };
    expect(resolveVoiceThinkingLevel({ platform, model: thinkingModel, app })).toBeUndefined();
  });

  test('never raises the level the model is set to', () => {
    const own = level => ({ ...thinkingModel, thinking: { enabled: true, level } });
    // Voice asks for low: a model at minimal or low keeps its own.
    expect(resolveVoiceThinkingLevel({ platform, model: own('minimal') })).toBeUndefined();
    expect(resolveVoiceThinkingLevel({ platform, model: own('low') })).toBeUndefined();
    // A model above it is brought down.
    expect(resolveVoiceThinkingLevel({ platform, model: own('medium') })).toBe('low');
    expect(resolveVoiceThinkingLevel({ platform, model: own('high') })).toBe('low');
    // No level, or one that is not a level: the voice level.
    expect(resolveVoiceThinkingLevel({ platform, model: own(undefined) })).toBe('low');
    expect(resolveVoiceThinkingLevel({ platform, model: own('turbo') })).toBe('low');
  });

  test('leaves thinking that is turned off alone', () => {
    expect(
      resolveVoiceThinkingLevel({ platform, model: thinkingModel, thinkingEnabled: false })
    ).toBeUndefined();
    expect(
      resolveVoiceThinkingLevel({
        platform,
        model: thinkingModel,
        app: { ...baseApp, thinking: { enabled: false } }
      })
    ).toBeUndefined();
  });

  test('is never asked of a model that does not think', () => {
    expect(resolveVoiceThinkingLevel({ platform, model: plainModel })).toBeUndefined();
    expect(
      resolveVoiceThinkingLevel({
        platform,
        model: { ...plainModel, thinking: { enabled: false } }
      })
    ).toBeUndefined();
    expect(resolveVoiceThinkingLevel({ platform })).toBeUndefined();
  });
});

describe('RequestBuilder with voiceMode', () => {
  let builder;
  beforeEach(() => {
    builder = new RequestBuilder();
  });

  test('adds the English instruction after the app prompt', async () => {
    voiceOn();
    const result = await builder.prepareChatRequest(request({ voiceMode: true }));
    expect(result.success).toBe(true);
    expect(systemOf(result)).toBe(`${APP_PROMPT}\n\n${DEFAULT_VOICE_INSTRUCTIONS.en}`);
  });

  test('adds the German instruction for a German request', async () => {
    voiceOn();
    const result = await builder.prepareChatRequest(request({ voiceMode: true, language: 'de' }));
    expect(systemOf(result)).toBe(`Du bist der HR-Assistent.\n\n${DEFAULT_VOICE_INSTRUCTIONS.de}`);
    // Not the English text as well.
    expect(systemOf(result)).not.toContain(DEFAULT_VOICE_INSTRUCTIONS.en);
  });

  test('a regional request language such as de-DE gets the German text', async () => {
    voiceOn();
    const result = await builder.prepareChatRequest(
      request({ voiceMode: true, language: 'de-DE' })
    );
    expect(systemOf(result)).toContain(DEFAULT_VOICE_INSTRUCTIONS.de);
  });

  test('the platform text replaces the built-in one', async () => {
    voiceOn();
    state.platform = {
      speech: {
        voiceMode: {
          enabled: true,
          systemPrompt: { en: 'Talk like a pirate.', de: 'Sprich wie ein Pirat.' }
        }
      }
    };
    const en = await builder.prepareChatRequest(request({ voiceMode: true }));
    expect(systemOf(en)).toBe(`${APP_PROMPT}\n\nTalk like a pirate.`);
    expect(systemOf(en)).not.toContain(DEFAULT_VOICE_INSTRUCTIONS.en);

    const de = await builder.prepareChatRequest(request({ voiceMode: true, language: 'de' }));
    expect(systemOf(de)).toBe('Du bist der HR-Assistent.\n\nSprich wie ein Pirat.');
  });

  test('an app that answers in JSON does not get the conversational instruction', async () => {
    voiceOn();
    state.apps = [{ ...baseApp, outputSchema: { type: 'object', properties: {} } }];
    const schema = await builder.prepareChatRequest(request({ voiceMode: true }));
    expect(systemOf(schema)).toBe(APP_PROMPT);

    state.apps = [baseApp];
    const json = await builder.prepareChatRequest(
      request({ voiceMode: true, outputFormat: 'json' })
    );
    expect(systemOf(json)).toBe(APP_PROMPT);
    // Reasoning is still kept short.
    expect(json.data.llmOptions.thinkingLevel).toBe('low');
  });

  test('an app without a system prompt still gets the instruction', async () => {
    voiceOn();
    const result = await builder.prepareChatRequest(
      request({ voiceMode: true, bypassAppPrompts: true, processMessageTemplates: async m => m })
    );
    expect(result.data.llmMessages[0]).toEqual({
      role: 'system',
      content: DEFAULT_VOICE_INSTRUCTIONS.en
    });
    expect(result.data.llmMessages.at(-1).role).toBe('user');
  });

  test('without the flag the prompt is the app prompt alone', async () => {
    voiceOn();
    for (const voiceMode of [undefined, false]) {
      const result = await builder.prepareChatRequest(request({ voiceMode }));
      expect(systemOf(result)).toBe(APP_PROMPT);
    }
  });

  test('is ignored, without an error, while the feature flag is off', async () => {
    voiceOn();
    state.features = {};
    const result = await builder.prepareChatRequest(request({ voiceMode: true }));
    expect(result.success).toBe(true);
    expect(systemOf(result)).toBe(APP_PROMPT);
    expect(result.data.llmOptions.thinkingLevel).toBeUndefined();
  });

  test('is ignored, without an error, while the platform switch is off', async () => {
    voiceOn();
    state.platform = { speech: { voiceMode: { enabled: false } } };
    const result = await builder.prepareChatRequest(request({ voiceMode: true }));
    expect(result.success).toBe(true);
    expect(systemOf(result)).toBe(APP_PROMPT);
    expect(result.data.llmOptions.thinkingLevel).toBeUndefined();
  });

  test('is ignored when the platform has no speech settings at all', async () => {
    state.features = { voiceMode: true };
    state.platform = {};
    const result = await builder.prepareChatRequest(request({ voiceMode: true }));
    expect(result.success).toBe(true);
    expect(systemOf(result)).toBe(APP_PROMPT);
  });

  describe('thinking level', () => {
    test('is the platform level for a model that thinks', async () => {
      voiceOn();
      const result = await builder.prepareChatRequest(request({ voiceMode: true }));
      expect(result.data.llmOptions.thinkingLevel).toBe('low');
    });

    test('follows the platform setting', async () => {
      voiceOn();
      state.platform = { speech: { voiceMode: { enabled: true, thinkingLevel: 'medium' } } };
      const result = await builder.prepareChatRequest(request({ voiceMode: true }));
      expect(result.data.llmOptions.thinkingLevel).toBe('medium');
    });

    test('is not applied when the request already carries a level', async () => {
      voiceOn();
      const result = await builder.prepareChatRequest(
        request({ voiceMode: true, thinkingLevel: 'high' })
      );
      expect(result.data.llmOptions.thinkingLevel).toBe('high');
    });

    test('is not applied when the request turned thinking off', async () => {
      voiceOn();
      const result = await builder.prepareChatRequest(
        request({ voiceMode: true, thinkingEnabled: false })
      );
      expect(result.data.llmOptions.thinkingLevel).toBeUndefined();
      expect(result.data.llmOptions.thinkingEnabled).toBe(false);
    });

    test('is not applied when the app sets its own level', async () => {
      voiceOn();
      state.apps = [{ ...baseApp, thinking: { enabled: true, level: 'high' } }];
      const result = await builder.prepareChatRequest(request({ voiceMode: true }));
      expect(result.data.llmOptions.thinkingLevel).toBeUndefined();
    });

    test('is never sent to a model that does not think', async () => {
      voiceOn();
      state.models = [plainModel];
      const result = await builder.prepareChatRequest(request({ voiceMode: true }));
      expect(result.success).toBe(true);
      expect(result.data.llmOptions.thinkingLevel).toBeUndefined();
      // The instruction still applies.
      expect(systemOf(result)).toContain(DEFAULT_VOICE_INSTRUCTIONS.en);
    });

    test('is untouched on a typed turn', async () => {
      voiceOn();
      const result = await builder.prepareChatRequest(request({ thinkingLevel: undefined }));
      expect(result.data.llmOptions.thinkingLevel).toBeUndefined();
    });
  });
});

describe('the stored user message', () => {
  test('keeps the voice marker', () => {
    expect(storableMessageExtras({ metadata: { inputMode: VOICE_INPUT_MODE } })).toEqual({
      metadata: { inputMode: 'voice' }
    });
    expect(VOICE_INPUT_MODE).toBe('voice');
  });

  test('keeps nothing else of a metadata field', () => {
    expect(storableMessageExtras({ metadata: { inputMode: 'telepathy' } })).toEqual({});
    expect(storableMessageExtras({ metadata: { inputMode: 'voice', secret: 'x' } })).toEqual({
      metadata: { inputMode: 'voice' }
    });
    expect(storableMessageExtras({ metadata: 'voice' })).toEqual({});
    expect(storableMessageExtras({ metadata: null })).toEqual({});
    expect(storableMessageExtras({})).toEqual({});
  });
});

describe('platform config for the client', () => {
  test('carries the non-secret settings, clamped', () => {
    const config = voiceModeClientConfig({
      enabled: true,
      appDefault: true,
      ttsModelId: ' voxtral-mini-tts ',
      listeningStyle: 'push-to-talk',
      bargeIn: false,
      endOfTurnSilenceMs: 50,
      thinkingLevel: 'MEDIUM',
      maxSessionMinutes: 9999,
      systemPrompt: { en: 'Internal wording.' }
    });
    expect(config).toEqual({
      enabled: true,
      appDefault: true,
      ttsModelId: 'voxtral-mini-tts',
      listeningStyle: 'push-to-talk',
      bargeIn: false,
      endOfTurnSilenceMs: 300,
      thinkingLevel: 'medium',
      maxSessionMinutes: 240
    });
    // The instruction stays on the server.
    expect(config).not.toHaveProperty('systemPrompt');
  });

  test('is switched off and complete for an empty block', () => {
    expect(voiceModeClientConfig({})).toEqual({
      enabled: false,
      appDefault: false,
      ttsModelId: '',
      listeningStyle: 'hands-free',
      bargeIn: true,
      endOfTurnSilenceMs: 800,
      thinkingLevel: 'low',
      maxSessionMinutes: 30
    });
  });
});
