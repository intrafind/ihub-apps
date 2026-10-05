/**
 * Schema specs for the platform-wide voice-input defaults (issue #2622):
 * platform.speech.defaultService / speech.transcription.defaultModelId, and
 * the app-level "browser" service that pins the Web Speech API now that
 * "default" follows the platform default, and "model" dictation, which names a
 * transcription model (`speech.dictation.modelId`, app `speechRecognition.modelId`).
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
    expect(speech.dictation).toEqual({ modelId: '' });
    expect(speech.transcription).toEqual({ defaultModelId: '' });
  });

  test('accept every dictation backend', () => {
    for (const service of ['browser', 'azure', 'model']) {
      const parsed = platformConfigSchema.parse({ speech: { defaultService: service } });
      expect(parsed.speech.defaultService).toBe(service);
    }
  });

  test('reject an unknown service, and the retired vllm-realtime', () => {
    for (const service of ['custom', 'vllm-realtime']) {
      const result = platformConfigSchema.safeParse({ speech: { defaultService: service } });
      expect(result.success).toBe(false);
    }
  });

  test('keep the dictation model', () => {
    const parsed = platformConfigSchema.parse({
      speech: { defaultService: 'model', dictation: { modelId: 'gemini-3.5-transcribe-live' } }
    });
    expect(parsed.speech.dictation.modelId).toBe('gemini-3.5-transcribe-live');
  });

  test('keep the default transcription model', () => {
    const parsed = platformConfigSchema.parse({
      speech: { transcription: { defaultModelId: 'voxtral-mini-realtime' } }
    });
    expect(parsed.speech.transcription.defaultModelId).toBe('voxtral-mini-realtime');
  });
});

describe('app speechRecognition.service', () => {
  test.each(['default', 'browser', 'azure', 'custom', 'model'])('accepts %s', service => {
    const result = appConfigSchema.safeParse({
      ...baseApp,
      settings: { speechRecognition: { service } }
    });
    expect(result.success).toBe(true);
    expect(result.data.settings.speechRecognition.service).toBe(service);
  });

  test('a model service names its transcription model', () => {
    const result = appConfigSchema.safeParse({
      ...baseApp,
      settings: { speechRecognition: { service: 'model', modelId: 'voxtral-mini-realtime' } }
    });
    expect(result.success).toBe(true);
    expect(result.data.settings.speechRecognition.modelId).toBe('voxtral-mini-realtime');
  });

  test('rejects the retired vllm-realtime', () => {
    const result = appConfigSchema.safeParse({
      ...baseApp,
      settings: { speechRecognition: { service: 'vllm-realtime' } }
    });
    expect(result.success).toBe(false);
  });

  test('defaults to following the platform default', () => {
    const result = appConfigSchema.safeParse({ ...baseApp, settings: { speechRecognition: {} } });
    expect(result.success).toBe(true);
    expect(result.data.settings.speechRecognition.service).toBe('default');
  });
});
