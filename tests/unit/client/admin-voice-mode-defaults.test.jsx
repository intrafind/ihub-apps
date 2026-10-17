/**
 * The admin pages show what the server does when nothing is configured. These
 * checks keep their copies of the voice mode defaults and of the built-in voice
 * style instruction equal to the server's.
 */
import { DEFAULT_VOICE_INSTRUCTIONS } from '../../../server/services/chat/voiceMode.js';
import {
  BUILT_IN_VOICE_PROMPTS,
  DEFAULT_VOICE_MODE,
  toFormVoiceMode,
  toSavedVoiceMode,
  withVoiceModeSettings
} from '../../../client/src/features/admin/utils/voiceMode';
import platformDefaults from '../../../server/defaults/config/platform.json';

test('the built-in instruction hint is the text the server uses', () => {
  expect(BUILT_IN_VOICE_PROMPTS.en).toBe(DEFAULT_VOICE_INSTRUCTIONS.en);
  expect(BUILT_IN_VOICE_PROMPTS.de).toBe(DEFAULT_VOICE_INSTRUCTIONS.de);
});

test('the form defaults are the platform defaults that ship', () => {
  expect(DEFAULT_VOICE_MODE).toEqual(platformDefaults.speech.voiceMode);
  expect(toFormVoiceMode(undefined)).toEqual(platformDefaults.speech.voiceMode);
});

test('toFormVoiceMode copies the prompts, so editing the form never touches the stored object', () => {
  const stored = { systemPrompt: { en: 'Be brief.' } };
  const form = toFormVoiceMode(stored);
  form.systemPrompt.en = 'Changed';
  expect(stored.systemPrompt.en).toBe('Be brief.');
});

test('toFormVoiceMode and toSavedVoiceMode tolerate garbage', () => {
  expect(toFormVoiceMode('nonsense')).toEqual(DEFAULT_VOICE_MODE);
  expect(toFormVoiceMode({ systemPrompt: ['x'] }).systemPrompt).toEqual({});
  const saved = toSavedVoiceMode(
    {
      ...DEFAULT_VOICE_MODE,
      listeningStyle: 'shouting',
      thinkingLevel: 'extreme',
      endOfTurnSilenceMs: 'abc'
    },
    'garbage'
  );
  expect(saved).toEqual(DEFAULT_VOICE_MODE);
});

test('withVoiceModeSettings leaves no empty values behind', () => {
  expect(withVoiceModeSettings(undefined, { enabled: undefined })).toEqual({});
  expect(withVoiceModeSettings({ type: 'multiline' }, { voice: '', ttsModelId: null })).toEqual({
    type: 'multiline'
  });
  expect(withVoiceModeSettings({ voiceMode: { enabled: false } }, { enabled: undefined })).toEqual(
    {}
  );
  expect(withVoiceModeSettings({ voiceMode: { enabled: false } }, { voice: 'x' })).toEqual({
    voiceMode: { enabled: false, voice: 'x' }
  });
});
