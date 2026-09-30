/**
 * Schema specs for the platform-wide voice-input defaults (issue #2622):
 * platform.speech.defaultService / speech.transcription.defaultModelId, and
 * the app-level "browser" service that pins the Web Speech API now that
 * "default" follows the platform default.
 */

import { platformConfigSchema } from '../validators/platformConfigSchema.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';

const baseApp = {
  id: 'voice-app',
  name: { en: 'Voice' },
  description: { en: 'Voice' },
  color: '#4F46E5',
  icon: 'microphone',
  system: { en: 'You are helpful.' }
};

describe('platform speech defaults', () => {
  test('default to the browser and no transcription model', () => {
    const { speech } = platformConfigSchema.parse({});
    expect(speech.defaultService).toBe('browser');
    expect(speech.transcription).toEqual({ defaultModelId: '' });
  });

  test('accept every dictation backend', () => {
    for (const service of ['browser', 'azure', 'vllm-realtime']) {
      const parsed = platformConfigSchema.parse({ speech: { defaultService: service } });
      expect(parsed.speech.defaultService).toBe(service);
    }
  });

  test('reject an unknown service', () => {
    const result = platformConfigSchema.safeParse({ speech: { defaultService: 'custom' } });
    expect(result.success).toBe(false);
  });

  test('keep the default transcription model', () => {
    const parsed = platformConfigSchema.parse({
      speech: { transcription: { defaultModelId: 'voxtral-mini-realtime' } }
    });
    expect(parsed.speech.transcription.defaultModelId).toBe('voxtral-mini-realtime');
  });
});

describe('app speechRecognition.service', () => {
  test.each(['default', 'browser', 'azure', 'custom', 'vllm-realtime'])('accepts %s', service => {
    const result = appConfigSchema.safeParse({
      ...baseApp,
      settings: { speechRecognition: { service } }
    });
    expect(result.success).toBe(true);
    expect(result.data.settings.speechRecognition.service).toBe(service);
  });

  test('defaults to following the platform default', () => {
    const result = appConfigSchema.safeParse({ ...baseApp, settings: { speechRecognition: {} } });
    expect(result.success).toBe(true);
    expect(result.data.settings.speechRecognition.service).toBe('default');
  });
});
