/**
 * When a chat offers voice mode (issue #2868): the feature flag and the
 * platform switch are on, the app allows voice input and voice mode (or
 * follows `appDefault`), a text-to-speech model is configured and permitted,
 * the app's speech service works here, and the browser has a microphone and
 * AudioWorklet.
 */
import { renderHook, waitFor } from '@testing-library/react';

let mockPlatformConfig = {};
let mockFlags = {};
let mockTtsModels = [];

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockPlatformConfig })
}));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: key => mockFlags[key] === true })
}));
jest.mock('../../../client/src/features/voice/hooks/useReadAloud', () => ({
  loadTtsModels: jest.fn(() => Promise.resolve(mockTtsModels))
}));
jest.mock('../../../client/src/utils/azureRecognitionService', () => ({
  __esModule: true,
  default: class {}
}));
jest.mock('../../../client/src/utils/modelRecognitionService', () => ({
  __esModule: true,
  default: class {}
}));

import useVoiceModeAvailability from '../../../client/src/features/voice/hooks/useVoiceModeAvailability';

const platform = (voiceMode = {}, speech = {}) => ({
  speech: {
    defaultService: 'browser',
    tts: { enabled: true, defaultModelId: 'tts-default' },
    voiceMode: { enabled: true, appDefault: true, ...voiceMode },
    ...speech
  }
});

const installBrowser = ({ mic = true, worklet = true, recognition = true } = {}) => {
  Object.defineProperty(global.navigator, 'mediaDevices', {
    configurable: true,
    value: mic ? { getUserMedia: jest.fn() } : undefined
  });
  class FakeAudioContext {}
  if (worklet) FakeAudioContext.prototype.audioWorklet = {};
  window.AudioContext = FakeAudioContext;
  if (recognition) window.SpeechRecognition = class {};
  else delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
};

const run = async app => {
  const hook = renderHook(() => useVoiceModeAvailability(app));
  await waitFor(() => expect(hook.result.current.reason).not.toBe('tts-not-permitted'));
  return hook.result.current;
};

beforeEach(() => {
  mockFlags = { voiceMode: true };
  mockPlatformConfig = platform();
  mockTtsModels = [{ id: 'tts-default' }];
  installBrowser();
});

describe('useVoiceModeAvailability', () => {
  test('is available when everything holds', async () => {
    const hook = renderHook(() => useVoiceModeAvailability({ id: 'a' }));
    await waitFor(() => expect(hook.result.current.available).toBe(true));
    expect(hook.result.current.reason).toBeNull();
    expect(hook.result.current.ttsModelId).toBe('tts-default');
    expect(hook.result.current.speech).toEqual({ service: 'browser', modelId: '' });
  });

  test('the feature flag and the platform switch both have to be on', async () => {
    mockFlags = {};
    expect((await run({ id: 'a' })).reason).toBe('feature-off');
    mockFlags = { voiceMode: true };
    mockPlatformConfig = platform({ enabled: false });
    expect((await run({ id: 'a' })).reason).toBe('platform-off');
  });

  test('an app follows appDefault unless it says otherwise', async () => {
    mockPlatformConfig = platform({ appDefault: false });
    expect((await run({ id: 'a' })).reason).toBe('app-off');
    expect(
      (await waitForAvailable({ id: 'a', inputMode: { voiceMode: { enabled: true } } })).available
    ).toBe(true);
    mockPlatformConfig = platform({ appDefault: true });
    expect((await run({ id: 'a', inputMode: { voiceMode: { enabled: false } } })).reason).toBe(
      'app-off'
    );
  });

  test('an app without voice input has no voice mode', async () => {
    const result = await run({ id: 'a', inputMode: { microphone: { enabled: false } } });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('app-off');
  });

  test('needs a text-to-speech model, and one this user may use', async () => {
    mockPlatformConfig = platform({}, { tts: { enabled: true, defaultModelId: '' } });
    expect((await run({ id: 'a' })).reason).toBe('no-tts-model');

    mockPlatformConfig = platform();
    mockTtsModels = [{ id: 'some-other-model' }];
    const hook = renderHook(() => useVoiceModeAvailability({ id: 'a' }));
    await waitFor(() => expect(hook.result.current.reason).toBe('tts-not-permitted'));
    expect(hook.result.current.available).toBe(false);
  });

  test('an app can use its own text-to-speech model', async () => {
    mockTtsModels = [{ id: 'german-voice' }];
    const hook = renderHook(() =>
      useVoiceModeAvailability({
        id: 'a',
        inputMode: { voiceMode: { ttsModelId: 'german-voice' } }
      })
    );
    await waitFor(() => expect(hook.result.current.available).toBe(true));
    expect(hook.result.current.ttsModelId).toBe('german-voice');
  });

  test('the speech service the app resolves to has to work here', async () => {
    installBrowser({ recognition: false });
    expect((await run({ id: 'a' })).reason).toBe('speech-service-unavailable');

    installBrowser({ recognition: false });
    mockPlatformConfig = platform({}, { azure: { enabled: false } });
    const azureApp = { id: 'a', settings: { speechRecognition: { service: 'azure' } } };
    expect((await run(azureApp)).reason).toBe('speech-service-unavailable');

    mockPlatformConfig = platform({}, { azure: { enabled: true } });
    const hook = renderHook(() => useVoiceModeAvailability(azureApp));
    await waitFor(() => expect(hook.result.current.available).toBe(true));
    expect(hook.result.current.speech.service).toBe('azure');
  });

  test('needs a microphone and AudioWorklet', async () => {
    installBrowser({ mic: false });
    expect((await run({ id: 'a' })).reason).toBe('browser-unsupported');
    installBrowser({ worklet: false });
    expect((await run({ id: 'a' })).reason).toBe('browser-unsupported');
  });
});

async function waitForAvailable(app) {
  const hook = renderHook(() => useVoiceModeAvailability(app));
  await waitFor(() => expect(hook.result.current.available).toBe(true));
  return hook.result.current;
}
