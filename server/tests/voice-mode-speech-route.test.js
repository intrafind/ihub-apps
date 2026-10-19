// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `POST /api/voice/speech` for voice mode (issue #2868): an answer is read in
 * several requests, one per speakable chunk. `languageFixed` keeps the language
 * the first chunk's response named, so a short chunk is never given another
 * voice by detection, and `voice` picks a configured voice of the model.
 *
 * Read aloud itself (neither field sent) is covered by tts-speech-route.test.js
 * and must not change; the first test here repeats the one thing that would
 * show it.
 *
 * Native ESM: uses `jest.unstable_mockModule` + dynamic imports. Run (from server/):
 * node --experimental-vm-modules node_modules/jest/bin/jest.js tests/voice-mode-speech-route.test.js
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const ttsModel = {
  id: 'voxtral-mini-tts',
  modelId: 'voxtral-mini-tts-latest',
  provider: 'mistral',
  modelType: 'tts',
  enabled: true,
  tts: { voice: 'en_paul_neutral', voices: { de: 'de_marie_neutral', fr: 'fr_marie_neutral' } }
};
const otherTtsModel = { ...ttsModel, id: 'other-tts', tts: { voice: 'other_voice' } };

const state = {
  platform: {},
  models: [],
  apps: [],
  visibleApps: null,
  permissions: new Set(['*']),
  userId: 'u1',
  calls: [],
  resolved: [],
  hold: null
};

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => {
    req.user = { id: state.userId, permissions: { models: state.permissions } };
    next();
  }
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    getModels: () => ({ data: state.models }),
    getApps: () => ({ data: state.apps }),
    // What the caller may use: every app, unless a test narrows it.
    getAppsForUser: async () => ({ data: state.visibleApps ?? state.apps })
  }
}));

// Like the real providers: the voice comes from the model by language, unless
// the route replaces it.
jest.unstable_mockModule('../tts/mistralTtsProvider.js', () => ({
  default: {
    id: 'mistral',
    sampleRate: 24000,
    resolveUpstream: (model, { language } = {}) => {
      state.resolved.push(language);
      return {
        model: model.modelId,
        voice: (language && model.tts?.voices?.[language]) || model.tts?.voice || 'default'
      };
    },
    synthesize: async ({ cfg, text, onAudio }) => {
      state.calls.push({ text, voice: cfg.voice });
      if (state.hold) await state.hold;
      await onAudio(Buffer.from([1, 0, 2, 0]));
      return { usage: null };
    }
  }
}));

const { default: registerVoiceRoutes } = await import('../routes/voiceRoutes.js');

const app = express();
// As a deployment behind a proxy: the client address comes from X-Forwarded-For.
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
registerVoiceRoutes(app);

const GERMAN = 'Die Sprachausgabe liest Antworten vor. Das ist praktisch, wenn man unterwegs ist.';
// Too short for detection to decide on its own.
const SHORT = 'Okay, danke.';

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const speak = body => request(app).post('/api/voice/speech').send(body).buffer(true).parse(binary);

beforeEach(() => {
  state.platform = { speech: { tts: { enabled: true, defaultModelId: 'voxtral-mini-tts' } } };
  state.models = [ttsModel, otherTtsModel];
  state.apps = [];
  state.visibleApps = null;
  state.permissions = new Set(['*']);
  state.userId = 'u1';
  state.calls = [];
  state.resolved = [];
  state.hold = null;
});

describe('languageFixed', () => {
  test('without it the language is still detected from the text', async () => {
    const res = await speak({ text: GERMAN, language: 'en' });
    expect(res.status).toBe(200);
    expect(res.headers['x-speech-language']).toBe('de');
    expect(state.resolved).toEqual(['de']);
    expect(state.calls[0].voice).toBe('de_marie_neutral');
  });

  test('languageFixed: false detects as before', async () => {
    const res = await speak({ text: GERMAN, language: 'en', languageFixed: false });
    expect(res.status).toBe(200);
    expect(res.headers['x-speech-language']).toBe('de');
    expect(state.resolved).toEqual(['de']);
  });

  test('languageFixed: true uses the language as given and detects nothing', async () => {
    // German text, English fixed: detection would say German.
    const res = await speak({ text: GERMAN, language: 'en', languageFixed: true });
    expect(res.status).toBe(200);
    expect(res.headers['x-speech-language']).toBe('en');
    expect(state.resolved).toEqual(['en']);
    expect(state.calls[0].voice).toBe('en_paul_neutral');
  });

  test('every chunk of an answer gets the voice of the first one', async () => {
    const first = await speak({ text: GERMAN, language: 'en' });
    const language = first.headers['x-speech-language'];
    expect(language).toBe('de');

    // A short follow-up chunk the detector cannot place on its own.
    const detected = await speak({ text: SHORT, language: 'en' });
    expect(detected.headers['x-speech-language']).toBe('en');

    const fixed = await speak({ text: SHORT, language, languageFixed: true });
    expect(fixed.headers['x-speech-language']).toBe('de');
    expect(state.calls.map(call => call.voice)).toEqual([
      'de_marie_neutral',
      'en_paul_neutral',
      'de_marie_neutral'
    ]);
  });

  test('a regional language tag is fixed to its base language', async () => {
    const res = await speak({ text: SHORT, language: 'fr-FR', languageFixed: true });
    expect(res.status).toBe(200);
    expect(res.headers['x-speech-language']).toBe('fr');
    expect(state.calls[0].voice).toBe('fr_marie_neutral');
  });

  test('a language the speech models do not list gets the model voice and no header', async () => {
    const res = await speak({ text: SHORT, language: 'ja', languageFixed: true });
    expect(res.status).toBe(200);
    expect(res.headers['x-speech-language']).toBeUndefined();
    expect(state.resolved).toEqual([null]);
    expect(state.calls[0].voice).toBe('en_paul_neutral');
  });

  test('a language that cannot be a header is never echoed into one', async () => {
    const res = await speak({ text: SHORT, language: 'de\r\nX-Evil: 1', languageFixed: true });
    expect(res.status).toBe(200);
    expect(res.headers['x-evil']).toBeUndefined();
  });

  test('languageFixed must be a boolean', async () => {
    for (const languageFixed of ['true', 1, 0, null, {}, []]) {
      const res = await request(app)
        .post('/api/voice/speech')
        .send({ text: SHORT, language: 'de', languageFixed });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid-language');
    }
    expect(state.calls).toHaveLength(0);
  });

  test('languageFixed: true needs a language that is text', async () => {
    for (const body of [{}, { language: null }, { language: 5 }, { language: ['de'] }]) {
      const res = await request(app)
        .post('/api/voice/speech')
        .send({ text: SHORT, languageFixed: true, ...body });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid-language');
    }
    expect(state.calls).toHaveLength(0);
  });

  test('a language without languageFixed is only a hint, whatever it is', async () => {
    const res = await speak({ text: SHORT, language: 5 });
    expect(res.status).toBe(200);
  });

  test('the other checks still come first', async () => {
    const noText = await request(app)
      .post('/api/voice/speech')
      .send({ text: ' ', languageFixed: true, language: 'de' });
    expect(noText.status).toBe(400);
    expect(noText.body.code).toBe('invalid-text');

    state.permissions = new Set(['some-chat-model']);
    const denied = await request(app)
      .post('/api/voice/speech')
      .send({ text: SHORT, languageFixed: true, language: 'de' });
    expect(denied.status).toBe(403);
  });
});

describe('voice', () => {
  test('without it the voice follows the language, as before', async () => {
    await speak({ text: GERMAN });
    expect(state.calls[0].voice).toBe('de_marie_neutral');
  });

  test('a voice configured on the model is used', async () => {
    const res = await speak({ text: GERMAN, voice: 'fr_marie_neutral' });
    expect(res.status).toBe(200);
    expect(state.calls[0].voice).toBe('fr_marie_neutral');
    // The language is still the answer's.
    expect(res.headers['x-speech-language']).toBe('de');
  });

  test('the model default voice is allowed too', async () => {
    const res = await speak({ text: GERMAN, voice: 'en_paul_neutral' });
    expect(res.status).toBe(200);
    expect(state.calls[0].voice).toBe('en_paul_neutral');
  });

  test('it works together with languageFixed', async () => {
    const res = await speak({
      text: SHORT,
      language: 'de',
      languageFixed: true,
      voice: 'fr_marie_neutral'
    });
    expect(res.status).toBe(200);
    expect(state.calls[0].voice).toBe('fr_marie_neutral');
  });

  test('a blank voice is ignored', async () => {
    for (const voice of ['', '   ']) {
      const res = await speak({ text: GERMAN, voice });
      expect(res.status).toBe(200);
    }
    expect(state.calls.map(call => call.voice)).toEqual(['de_marie_neutral', 'de_marie_neutral']);
  });

  test('a voice the admin did not configure is refused before anything is synthesized', async () => {
    const res = await request(app)
      .post('/api/voice/speech')
      .send({ text: GERMAN, voice: 'someone_elses_voice' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid-voice');
    expect(state.calls).toHaveLength(0);
  });

  test('a voice of another model is not one of this model', async () => {
    const res = await request(app)
      .post('/api/voice/speech')
      .send({ text: GERMAN, voice: 'other_voice' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid-voice');

    const own = await speak({ text: GERMAN, modelId: 'other-tts', voice: 'other_voice' });
    expect(own.status).toBe(200);
    expect(state.calls.at(-1).voice).toBe('other_voice');
  });

  test('a voice must be a string of reasonable length', async () => {
    for (const voice of [5, true, null, {}, ['de_marie_neutral'], 'x'.repeat(201)]) {
      const res = await request(app).post('/api/voice/speech').send({ text: GERMAN, voice });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid-voice');
    }
    expect(state.calls).toHaveLength(0);
  });

  describe('the voice an app names for voice mode', () => {
    const appWithVoice = (id, inputModeVoice) => ({
      id,
      inputMode: { voiceMode: { enabled: true, ...inputModeVoice } }
    });

    // An app's voice counts only while voice mode is on for the instance.
    beforeEach(() => {
      state.platform = {
        speech: {
          tts: { enabled: true, defaultModelId: 'voxtral-mini-tts' },
          voiceMode: { enabled: true }
        }
      };
    });

    test('is allowed when that app speaks with this model', async () => {
      state.apps = [appWithVoice('hr', { ttsModelId: 'voxtral-mini-tts', voice: 'hr_voice_id' })];
      const res = await speak({ text: GERMAN, voice: 'hr_voice_id' });
      expect(res.status).toBe(200);
      expect(state.calls[0].voice).toBe('hr_voice_id');
    });

    test('is allowed when the app follows the platform and the platform picks this model', async () => {
      state.apps = [appWithVoice('hr', { voice: 'hr_voice_id' })];
      // speech.tts.defaultModelId is voxtral-mini-tts
      expect((await speak({ text: GERMAN, voice: 'hr_voice_id' })).status).toBe(200);

      state.platform = {
        speech: {
          tts: { enabled: true, defaultModelId: 'voxtral-mini-tts' },
          voiceMode: { enabled: true, ttsModelId: 'other-tts' }
        }
      };
      const moved = await request(app)
        .post('/api/voice/speech')
        .send({ text: GERMAN, voice: 'hr_voice_id' });
      expect(moved.status).toBe(400);
    });

    test('is not allowed on a model the app does not speak with', async () => {
      state.apps = [appWithVoice('hr', { ttsModelId: 'other-tts', voice: 'hr_voice_id' })];
      const res = await request(app)
        .post('/api/voice/speech')
        .send({ text: GERMAN, voice: 'hr_voice_id' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid-voice');
    });

    test('is not allowed when the app is not one the caller may use', async () => {
      state.apps = [appWithVoice('hr', { ttsModelId: 'voxtral-mini-tts', voice: 'hr_voice_id' })];
      state.visibleApps = [];
      const res = await request(app)
        .post('/api/voice/speech')
        .send({ text: GERMAN, voice: 'hr_voice_id' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid-voice');
    });

    test('is not allowed when voice mode is off for the app or for the instance', async () => {
      state.apps = [
        appWithVoice('hr', { enabled: false, ttsModelId: 'voxtral-mini-tts', voice: 'hr_voice_id' })
      ];
      expect(
        (await request(app).post('/api/voice/speech').send({ text: GERMAN, voice: 'hr_voice_id' }))
          .status
      ).toBe(400);

      state.apps = [appWithVoice('hr', { ttsModelId: 'voxtral-mini-tts', voice: 'hr_voice_id' })];
      state.platform = { speech: { tts: { enabled: true, defaultModelId: 'voxtral-mini-tts' } } };
      expect(
        (await request(app).post('/api/voice/speech').send({ text: GERMAN, voice: 'hr_voice_id' }))
          .status
      ).toBe(400);
    });

    test('apps that name no voice add nothing', async () => {
      state.apps = [{ id: 'plain' }, appWithVoice('mute', { enabled: true, voice: '' })];
      const res = await request(app)
        .post('/api/voice/speech')
        .send({ text: GERMAN, voice: 'anything' });
      expect(res.status).toBe(400);
    });
  });
});

describe('syntheses at once', () => {
  const until = async predicate => {
    for (let i = 0; i < 200 && !predicate(); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(predicate()).toBe(true);
  };

  test('one user cannot have more than six running; a finished one frees its slot', async () => {
    let release;
    state.hold = new Promise(resolve => {
      release = resolve;
    });
    const running = Array.from({ length: 6 }, () => speak({ text: GERMAN }).then(res => res));
    await until(() => state.calls.length === 6);

    const refused = await request(app).post('/api/voice/speech').send({ text: GERMAN });
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('too-many-requests');

    release();
    const done = await Promise.all(running);
    expect(done.map(res => res.status)).toEqual([200, 200, 200, 200, 200, 200]);

    state.hold = null;
    expect((await speak({ text: GERMAN })).status).toBe(200);
  });

  /**
   * A synthesis request as visitor `from` that stays running until the hold is
   * released. (A supertest request only starts once something waits for it.)
   */
  const speakAs = from =>
    Promise.resolve(
      request(app)
        .post('/api/voice/speech')
        .set('X-Forwarded-For', from)
        .send({ text: GERMAN })
        .buffer(true)
        .parse(binary)
    );

  /** Fill the six slots of `from`, run `during` while they are held, then let them finish. */
  async function withSixHeldBy(from, during) {
    let release;
    state.hold = new Promise(resolve => {
      release = resolve;
    });
    const running = Array.from({ length: 6 }, () => speakAs(from));
    await until(() => state.calls.length === 6);
    const later = [];
    try {
      await during(request => later.push(request));
    } finally {
      release();
      await Promise.all([...running, ...later]);
    }
  }

  test('anonymous visitors do not share slots: one address is capped, another is not', async () => {
    state.userId = 'anonymous';
    await withSixHeldBy('10.0.0.1', async started => {
      const sameAddress = await request(app)
        .post('/api/voice/speech')
        .set('X-Forwarded-For', '10.0.0.1')
        .send({ text: GERMAN });
      expect(sameAddress.status).toBe(429);

      // Another visitor is served, although the first one has used all six.
      started(speakAs('10.0.0.2'));
      await until(() => state.calls.length === 7);
    });
  });

  test('a signed-in user is not counted with the anonymous visitors of the same address', async () => {
    state.userId = 'anonymous';
    await withSixHeldBy('10.0.0.1', async started => {
      state.userId = 'u1';
      started(speakAs('10.0.0.1'));
      await until(() => state.calls.length === 7);
    });
  });

  test('a user id that looks like an address does not use the slots of that address', async () => {
    state.userId = 'anonymous';
    await withSixHeldBy('10.0.0.1', async started => {
      state.userId = '10.0.0.1';
      started(speakAs('10.0.0.9'));
      await until(() => state.calls.length === 7);
    });
  });
});
