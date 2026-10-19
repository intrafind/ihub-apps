// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Voice mode configuration (issue #2868): the shared resolver the server and the
 * client both use, the platform and app schemas that hold the settings, and the
 * feature flag that gates the whole thing.
 *
 * Run (from server/): node --experimental-vm-modules node_modules/jest/bin/jest.js tests/voice-mode-settings.test.js
 */

import {
  VOICE_MODE_DEFAULTS,
  VOICE_LISTENING_STYLES,
  VOICE_THINKING_LEVELS,
  resolveVoiceModeSettings
} from '../../shared/voiceMode.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import { chatPostSchema } from '../validators/index.js';
import { featureRegistry, isFeatureEnabled } from '../featureRegistry.js';

const platformWith = (voiceMode, extra = {}) => ({
  speech: { voiceMode: { enabled: true, ...voiceMode }, ...extra }
});

describe('resolveVoiceModeSettings', () => {
  test('without any config it returns the shipped defaults, switched off', () => {
    const resolved = resolveVoiceModeSettings({ platform: {}, app: {} });
    expect(resolved).toEqual({
      platformEnabled: false,
      enabled: false,
      listeningStyle: 'hands-free',
      ttsModelId: '',
      voice: '',
      bargeIn: true,
      endOfTurnSilenceMs: 800,
      thinkingLevel: 'low',
      maxSessionMinutes: 30
    });
  });

  test('the defaults object carries the platform defaults and cannot be changed', () => {
    expect(VOICE_MODE_DEFAULTS).toEqual({
      enabled: false,
      appDefault: false,
      ttsModelId: '',
      listeningStyle: 'hands-free',
      bargeIn: true,
      endOfTurnSilenceMs: 800,
      thinkingLevel: 'low',
      maxSessionMinutes: 30,
      systemPrompt: {}
    });
    expect(Object.isFrozen(VOICE_MODE_DEFAULTS)).toBe(true);
    expect(VOICE_LISTENING_STYLES).toEqual(['hands-free', 'push-to-talk']);
    expect(VOICE_THINKING_LEVELS).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  describe('enabled', () => {
    test('the platform switch is required', () => {
      const app = { inputMode: { voiceMode: { enabled: true } } };
      const off = resolveVoiceModeSettings({
        platform: { speech: { voiceMode: { enabled: false, appDefault: true } } },
        app
      });
      expect(off.platformEnabled).toBe(false);
      expect(off.enabled).toBe(false);
      expect(resolveVoiceModeSettings({ platform: platformWith({}), app }).enabled).toBe(true);
    });

    test('an app that says nothing follows appDefault', () => {
      expect(resolveVoiceModeSettings({ platform: platformWith({}), app: {} }).enabled).toBe(false);
      expect(
        resolveVoiceModeSettings({ platform: platformWith({ appDefault: false }), app: {} }).enabled
      ).toBe(false);
      expect(
        resolveVoiceModeSettings({ platform: platformWith({ appDefault: true }), app: {} }).enabled
      ).toBe(true);
    });

    test('an explicit app setting beats appDefault, both ways', () => {
      const optIn = resolveVoiceModeSettings({
        platform: platformWith({ appDefault: false }),
        app: { inputMode: { voiceMode: { enabled: true } } }
      });
      const optOut = resolveVoiceModeSettings({
        platform: platformWith({ appDefault: true }),
        app: { inputMode: { voiceMode: { enabled: false } } }
      });
      expect(optIn.enabled).toBe(true);
      expect(optOut.enabled).toBe(false);
      // The platform switch is still on for the opted-out app.
      expect(optOut.platformEnabled).toBe(true);
    });

    test('an app with its microphone off has no voice mode, even when it asks for it', () => {
      const app = {
        inputMode: { microphone: { enabled: false }, voiceMode: { enabled: true } }
      };
      expect(resolveVoiceModeSettings({ platform: platformWith({}), app }).enabled).toBe(false);
      expect(
        resolveVoiceModeSettings({ platform: platformWith({ appDefault: true }), app: {} }).enabled
      ).toBe(true);
    });

    test('the older top-level microphone setting counts too, and inputMode wins over it', () => {
      const platform = platformWith({ appDefault: true });
      expect(
        resolveVoiceModeSettings({ platform, app: { microphone: { enabled: false } } }).enabled
      ).toBe(false);
      expect(
        resolveVoiceModeSettings({
          platform,
          app: { microphone: { enabled: false }, inputMode: { microphone: { enabled: true } } }
        }).enabled
      ).toBe(true);
    });

    test('a microphone that says nothing is on', () => {
      const app = { inputMode: { microphone: { mode: 'manual' }, voiceMode: { enabled: true } } };
      expect(resolveVoiceModeSettings({ platform: platformWith({}), app }).enabled).toBe(true);
    });
  });

  describe('listening style, TTS model and voice', () => {
    test('listening style: app, then platform, then hands-free', () => {
      const platform = platformWith({ listeningStyle: 'push-to-talk' });
      expect(resolveVoiceModeSettings({ platform, app: {} }).listeningStyle).toBe('push-to-talk');
      expect(
        resolveVoiceModeSettings({
          platform,
          app: { inputMode: { voiceMode: { listeningStyle: 'hands-free' } } }
        }).listeningStyle
      ).toBe('hands-free');
      expect(resolveVoiceModeSettings({ platform: platformWith({}), app: {} }).listeningStyle).toBe(
        'hands-free'
      );
    });

    test('an unknown listening style is skipped for the next one in the chain', () => {
      const resolved = resolveVoiceModeSettings({
        platform: platformWith({ listeningStyle: 'push-to-talk' }),
        app: { inputMode: { voiceMode: { listeningStyle: 'shouting' } } }
      });
      expect(resolved.listeningStyle).toBe('push-to-talk');
      expect(
        resolveVoiceModeSettings({
          platform: platformWith({ listeningStyle: 'nope' }),
          app: {}
        }).listeningStyle
      ).toBe('hands-free');
    });

    test('TTS model: app, then voice mode, then the read-aloud model, then none', () => {
      const speechTts = { tts: { defaultModelId: 'read-aloud-model' } };
      const app = { inputMode: { voiceMode: { ttsModelId: 'app-model' } } };

      expect(
        resolveVoiceModeSettings({
          platform: platformWith({ ttsModelId: 'voice-model' }, speechTts),
          app
        }).ttsModelId
      ).toBe('app-model');
      expect(
        resolveVoiceModeSettings({
          platform: platformWith({ ttsModelId: 'voice-model' }, speechTts),
          app: {}
        }).ttsModelId
      ).toBe('voice-model');
      expect(
        resolveVoiceModeSettings({ platform: platformWith({ ttsModelId: '' }, speechTts), app: {} })
          .ttsModelId
      ).toBe('read-aloud-model');
      expect(
        resolveVoiceModeSettings({
          platform: platformWith({}, speechTts),
          app: { inputMode: { voiceMode: { ttsModelId: '   ' } } }
        }).ttsModelId
      ).toBe('read-aloud-model');
      expect(resolveVoiceModeSettings({ platform: platformWith({}), app: {} }).ttsModelId).toBe('');
    });

    test('voice comes from the app and is empty without one', () => {
      expect(
        resolveVoiceModeSettings({
          platform: platformWith({}),
          app: { inputMode: { voiceMode: { voice: ' en_paul_neutral ' } } }
        }).voice
      ).toBe('en_paul_neutral');
      expect(resolveVoiceModeSettings({ platform: platformWith({}), app: {} }).voice).toBe('');
    });
  });

  describe('platform values', () => {
    test('are passed through when valid', () => {
      const resolved = resolveVoiceModeSettings({
        platform: platformWith({
          bargeIn: false,
          endOfTurnSilenceMs: 1200,
          thinkingLevel: 'high',
          maxSessionMinutes: 90
        })
      });
      expect(resolved.bargeIn).toBe(false);
      expect(resolved.endOfTurnSilenceMs).toBe(1200);
      expect(resolved.thinkingLevel).toBe('high');
      expect(resolved.maxSessionMinutes).toBe(90);
    });

    test('numbers are clamped into their ranges and rounded', () => {
      const at = voiceMode => resolveVoiceModeSettings({ platform: platformWith(voiceMode) });
      expect(at({ endOfTurnSilenceMs: 5 }).endOfTurnSilenceMs).toBe(300);
      expect(at({ endOfTurnSilenceMs: 99999 }).endOfTurnSilenceMs).toBe(3000);
      expect(at({ endOfTurnSilenceMs: 800.6 }).endOfTurnSilenceMs).toBe(801);
      expect(at({ maxSessionMinutes: 0 }).maxSessionMinutes).toBe(1);
      expect(at({ maxSessionMinutes: -10 }).maxSessionMinutes).toBe(1);
      expect(at({ maxSessionMinutes: 100000 }).maxSessionMinutes).toBe(240);
    });

    test('anything that is not a finite number falls back to the default', () => {
      const at = voiceMode => resolveVoiceModeSettings({ platform: platformWith(voiceMode) });
      for (const bad of ['900', NaN, Infinity, -Infinity, null, {}, [], true]) {
        expect(at({ endOfTurnSilenceMs: bad }).endOfTurnSilenceMs).toBe(800);
        expect(at({ maxSessionMinutes: bad }).maxSessionMinutes).toBe(30);
      }
    });

    test('thinking level is accepted in either case and an unknown one falls back', () => {
      const at = thinkingLevel =>
        resolveVoiceModeSettings({ platform: platformWith({ thinkingLevel }) }).thinkingLevel;
      expect(at('MEDIUM')).toBe('medium');
      expect(at('minimal')).toBe('minimal');
      expect(at('extreme')).toBe('low');
      expect(at(3)).toBe('low');
    });

    test('bargeIn needs a boolean', () => {
      const at = bargeIn => resolveVoiceModeSettings({ platform: platformWith({ bargeIn }) });
      expect(at('false').bargeIn).toBe(true);
      expect(at(0).bargeIn).toBe(true);
      expect(at(false).bargeIn).toBe(false);
    });

    test('only a literal true switches things on', () => {
      for (const truthy of ['true', 1, 'yes', {}]) {
        expect(
          resolveVoiceModeSettings({ platform: { speech: { voiceMode: { enabled: truthy } } } })
            .platformEnabled
        ).toBe(false);
        expect(
          resolveVoiceModeSettings({
            platform: platformWith({ appDefault: truthy }),
            app: {}
          }).enabled
        ).toBe(false);
      }
    });
  });

  describe('garbage input', () => {
    const defaults = resolveVoiceModeSettings({ platform: {}, app: {} });

    test.each([
      ['nothing', undefined],
      ['null', null],
      ['a string', 'voice'],
      ['a number', 42],
      ['an array', []],
      ['an empty object', {}]
    ])('%s as the argument returns the defaults', (_label, options) => {
      expect(resolveVoiceModeSettings(options)).toEqual(defaults);
    });

    test.each([
      ['strings', { platform: 'x', app: 'y' }],
      ['nulls', { platform: null, app: null }],
      ['arrays', { platform: [], app: [] }],
      ['speech not an object', { platform: { speech: 'on' }, app: {} }],
      ['voiceMode not an object', { platform: { speech: { voiceMode: 'on' } }, app: {} }],
      ['voiceMode an array', { platform: { speech: { voiceMode: [true] } }, app: {} }],
      ['inputMode not an object', { platform: {}, app: { inputMode: 'voice' } }],
      ['inputMode.voiceMode a string', { platform: {}, app: { inputMode: { voiceMode: 'on' } } }],
      ['microphone a string', { platform: {}, app: { inputMode: { microphone: 'off' } } }]
    ])('%s still return the defaults and never throw', (_label, options) => {
      expect(resolveVoiceModeSettings(options)).toEqual(defaults);
    });

    test('garbage inside valid objects is ignored field by field', () => {
      const resolved = resolveVoiceModeSettings({
        platform: platformWith({
          ttsModelId: 7,
          listeningStyle: ['push-to-talk'],
          systemPrompt: 'be brief'
        }),
        app: { inputMode: { voiceMode: { enabled: 'yes', voice: 12, ttsModelId: {} } } }
      });
      expect(resolved.enabled).toBe(false);
      expect(resolved.ttsModelId).toBe('');
      expect(resolved.voice).toBe('');
      expect(resolved.listeningStyle).toBe('hands-free');
    });
  });
});

describe('platform schema: speech.voiceMode', () => {
  test('defaults to the shipped values', () => {
    const { speech } = platformConfigSchema.parse({});
    expect(speech.voiceMode).toEqual({ ...VOICE_MODE_DEFAULTS, systemPrompt: {} });
  });

  test('keeps what an admin set, with a localized system prompt', () => {
    const voiceMode = {
      enabled: true,
      appDefault: true,
      ttsModelId: 'voxtral-mini-tts',
      listeningStyle: 'push-to-talk',
      bargeIn: false,
      endOfTurnSilenceMs: 1500,
      thinkingLevel: 'minimal',
      maxSessionMinutes: 60,
      systemPrompt: { en: 'Be brief.', de: 'Fasse dich kurz.' }
    };
    const parsed = platformConfigSchema.parse({ speech: { voiceMode } });
    expect(parsed.speech.voiceMode).toEqual(voiceMode);
  });

  test('keeps fields it does not know, like its neighbours', () => {
    const parsed = platformConfigSchema.parse({ speech: { voiceMode: { custom: 1 } } });
    expect(parsed.speech.voiceMode.custom).toBe(1);
  });

  test.each([
    ['an unknown listening style', { listeningStyle: 'shouting' }],
    ['an unknown thinking level', { thinkingLevel: 'extreme' }],
    ['a silence below 300 ms', { endOfTurnSilenceMs: 299 }],
    ['a silence above 3000 ms', { endOfTurnSilenceMs: 3001 }],
    ['a fractional silence', { endOfTurnSilenceMs: 800.5 }],
    ['a session of 0 minutes', { maxSessionMinutes: 0 }],
    ['a session above 240 minutes', { maxSessionMinutes: 241 }],
    ['a non-boolean switch', { enabled: 'yes' }],
    ['a system prompt that is not a record', { systemPrompt: 'Be brief.' }],
    ['a system prompt that is not text', { systemPrompt: { en: 5 } }],
    ['a system prompt for a malformed language', { systemPrompt: { 'not a language': 'x' } }],
    ['a system prompt that is far too long', { systemPrompt: { en: 'x'.repeat(4001) } }]
  ])('rejects %s', (_label, voiceMode) => {
    expect(platformConfigSchema.safeParse({ speech: { voiceMode } }).success).toBe(false);
  });

  test.each([
    ['at the lowest values', { endOfTurnSilenceMs: 300, maxSessionMinutes: 1 }],
    ['at the highest values', { endOfTurnSilenceMs: 3000, maxSessionMinutes: 240 }],
    ['with a regional language key', { systemPrompt: { 'en-US': 'Be brief.' } }],
    ['with a blank prompt', { systemPrompt: { de: '' } }]
  ])('accepts %s', (_label, voiceMode) => {
    expect(platformConfigSchema.safeParse({ speech: { voiceMode } }).success).toBe(true);
  });
});

describe('app schema: inputMode.voiceMode', () => {
  const baseApp = {
    id: 'voice-app',
    name: { en: 'Voice' },
    description: { en: 'Voice' },
    color: '#4F46E5',
    icon: 'microphone',
    system: { en: 'You are helpful.' }
  };
  const parse = inputMode => appConfigSchema.safeParse({ ...baseApp, inputMode });

  test('an app without it stays without it: it follows the platform', () => {
    const none = parse(undefined);
    expect(none.success).toBe(true);
    expect(none.data.inputMode).toBeUndefined();

    const micOnly = parse({ microphone: { enabled: true } });
    expect(micOnly.success).toBe(true);
    expect(micOnly.data.inputMode.voiceMode).toBeUndefined();
  });

  test('keeps every field, next to the microphone settings', () => {
    const result = parse({
      microphone: { enabled: true, mode: 'manual', showTranscript: true },
      voiceMode: {
        enabled: true,
        listeningStyle: 'push-to-talk',
        ttsModelId: 'voxtral-mini-tts',
        voice: 'de_marie_neutral'
      }
    });
    expect(result.success).toBe(true);
    expect(result.data.inputMode.voiceMode).toEqual({
      enabled: true,
      listeningStyle: 'push-to-talk',
      ttsModelId: 'voxtral-mini-tts',
      voice: 'de_marie_neutral'
    });
    expect(result.data.inputMode.microphone.enabled).toBe(true);
  });

  test('every field is optional and none is defaulted', () => {
    for (const voiceMode of [{}, { enabled: false }, { listeningStyle: 'hands-free' }]) {
      const result = parse({ voiceMode });
      expect(result.success).toBe(true);
      expect(result.data.inputMode.voiceMode).toEqual(voiceMode);
    }
  });

  test.each([
    ['an unknown listening style', { listeningStyle: 'shouting' }],
    ['a non-boolean enabled', { enabled: 'yes' }],
    ['a model id that is not text', { ttsModelId: 5 }],
    ['a voice that is not text', { voice: ['x'] }]
  ])('rejects %s', (_label, voiceMode) => {
    expect(parse({ voiceMode }).success).toBe(false);
  });

  test('a voice mode that is not an object is rejected', () => {
    expect(parse({ voiceMode: true }).success).toBe(false);
  });

  test('settings it does not know are dropped, as everywhere in inputMode', () => {
    const result = parse({ voiceMode: { enabled: true, volume: 11 } });
    expect(result.success).toBe(true);
    expect(result.data.inputMode.voiceMode).toEqual({ enabled: true });
  });
});

describe('chat request: voiceMode', () => {
  const body = voiceMode =>
    chatPostSchema.body.safeParse({ messages: [{ role: 'user', content: 'hi' }], voiceMode });

  test('is an optional boolean', () => {
    expect(body(undefined).success).toBe(true);
    expect(body(true).success).toBe(true);
    expect(body(false).success).toBe(true);
    expect(body(true).data.voiceMode).toBe(true);
  });

  test('rejects anything else', () => {
    expect(body('true').success).toBe(false);
    expect(body(1).success).toBe(false);
  });
});

describe('feature flag voiceMode', () => {
  const entry = featureRegistry.find(feature => feature.id === 'voiceMode');

  test('is a preview feature that is off by default', () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe('preview');
    expect(entry.preview).toBe(true);
    expect(entry.default).toBe(false);
  });

  test('has an English and a German label and description', () => {
    for (const field of [entry.name, entry.description]) {
      expect(field.en).toBeTruthy();
      expect(field.de).toBeTruthy();
    }
  });

  test('is off until an admin turns it on', () => {
    expect(isFeatureEnabled('voiceMode', {})).toBe(false);
    expect(isFeatureEnabled('voiceMode', { voiceMode: true })).toBe(true);
    expect(isFeatureEnabled('voiceMode', { voiceMode: false })).toBe(false);
  });
});
