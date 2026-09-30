/**
 * Dictation service selection and recognizer plumbing shared by the chat's
 * microphone button and the admin voice-input test panel (issue #2622).
 *
 * "default" follows the platform default (Admin → Voice Input), an explicit
 * service wins, and a platform default whose backend is switched off falls
 * back to the browser instead of failing.
 */
jest.mock('../../../client/src/utils/azureRecognitionService', () => ({
  __esModule: true,
  default: class AzureSpeechRecognition {
    usesTextEventShape = true;
    initRecognizer() {}
  }
}));
jest.mock('../../../client/src/utils/vllmRealtimeRecognitionService', () => ({
  __esModule: true,
  default: class VllmRealtimeRecognition {
    usesTextEventShape = true;
  }
}));

import {
  createSpeechRecognizer,
  getMicrophoneErrorMessage,
  getPlatformDefaultService,
  getRecognitionErrorMessage,
  parseRecognitionResult,
  resolveSpeechService,
  toRecognitionLang
} from '../../../client/src/features/voice/utils/speechService';
import AzureSpeechRecognition from '../../../client/src/utils/azureRecognitionService';
import VllmRealtimeRecognition from '../../../client/src/utils/vllmRealtimeRecognitionService';

const t = (key, fallback) => fallback;
const appWith = service => ({ settings: { speechRecognition: { service } } });
const platform = speech => ({ speech });
const ALL_ENABLED = { realtime: { enabled: true }, azure: { enabled: true } };

describe('resolveSpeechService', () => {
  test('without any configuration it is the browser, as before', () => {
    expect(resolveSpeechService({}, null)).toBe('browser');
    expect(resolveSpeechService(appWith('default'), platform({}))).toBe('browser');
  });

  test('"default" and no setting follow the platform default', () => {
    const cfg = platform({ ...ALL_ENABLED, defaultService: 'vllm-realtime' });
    expect(resolveSpeechService(appWith('default'), cfg)).toBe('vllm-realtime');
    expect(resolveSpeechService({}, cfg)).toBe('vllm-realtime');
    expect(resolveSpeechService({ settings: {} }, cfg)).toBe('vllm-realtime');
  });

  test('an explicit service wins over the platform default', () => {
    const cfg = platform({ ...ALL_ENABLED, defaultService: 'vllm-realtime' });
    expect(resolveSpeechService(appWith('browser'), cfg)).toBe('browser');
    expect(resolveSpeechService(appWith('azure'), cfg)).toBe('azure');
  });

  test('"custom" keeps falling back to the browser', () => {
    const cfg = platform({ ...ALL_ENABLED, defaultService: 'azure' });
    expect(resolveSpeechService(appWith('custom'), cfg)).toBe('browser');
  });

  test('an explicit service is used even when its backend is off (the error then says why)', () => {
    expect(resolveSpeechService(appWith('vllm-realtime'), platform({}))).toBe('vllm-realtime');
  });
});

describe('getPlatformDefaultService', () => {
  test('uses the configured backend when it is enabled', () => {
    expect(getPlatformDefaultService({ ...ALL_ENABLED, defaultService: 'azure' })).toBe('azure');
  });

  test('falls back to the browser when the configured backend is off', () => {
    expect(getPlatformDefaultService({ defaultService: 'vllm-realtime' })).toBe('browser');
    expect(getPlatformDefaultService({ defaultService: 'azure', azure: { enabled: false } })).toBe(
      'browser'
    );
  });

  test('ignores an unknown value', () => {
    expect(getPlatformDefaultService({ ...ALL_ENABLED, defaultService: 'custom' })).toBe('browser');
  });
});

describe('createSpeechRecognizer', () => {
  afterEach(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });

  test('azure: per-app host first, then the platform host; token only with a server key', () => {
    const speech = { azure: { enabled: true, keyConfigured: true, host: 'https://platform' } };
    const own = createSpeechRecognizer('azure', { host: 'https://app', speech });
    expect(own).toBeInstanceOf(AzureSpeechRecognition);
    expect(own.host).toBe('https://app');
    expect(own.useServerToken).toBe(true);

    const inherited = createSpeechRecognizer('azure', { speech });
    expect(inherited.host).toBe('https://platform');

    const keyless = createSpeechRecognizer('azure', {
      speech: { azure: { enabled: true, keyConfigured: false } }
    });
    expect(keyless.useServerToken).toBe(false);
  });

  test('vllm-realtime builds the iHub-proxied recognizer', () => {
    expect(createSpeechRecognizer('vllm-realtime')).toBeInstanceOf(VllmRealtimeRecognition);
  });

  test('browser uses the (prefixed) Web Speech API', () => {
    window.webkitSpeechRecognition = function WebkitSpeechRecognition() {};
    expect(createSpeechRecognizer('browser')).toBeInstanceOf(window.webkitSpeechRecognition);
  });

  test('browser without the Web Speech API throws not-supported', () => {
    expect(() => createSpeechRecognizer('browser')).toThrow(
      expect.objectContaining({ code: 'not-supported' })
    );
  });
});

describe('toRecognitionLang', () => {
  test.each([
    ['de', 'de-DE'],
    ['EN', 'en-US'],
    ['de-AT', 'de-AT'],
    ['xx', 'en-US'],
    [undefined, 'en-US']
  ])('%s → %s', (input, expected) => {
    expect(toRecognitionLang(input)).toBe(expected);
  });
});

describe('parseRecognitionResult', () => {
  test('browser SpeechRecognition events: splits final and interim segments', () => {
    const segment = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });
    const event = {
      resultIndex: 1,
      results: [segment('old ', true), segment('hello ', true), segment('wor', false)]
    };
    expect(parseRecognitionResult(event, false)).toEqual({ final: 'hello ', interim: 'wor' });
  });

  test('{ text, isFinal } events (Azure, vLLM realtime)', () => {
    expect(parseRecognitionResult({ text: 'partial', isFinal: false }, true)).toEqual({
      interim: 'partial',
      final: ''
    });
    expect(parseRecognitionResult({ text: 'done', isFinal: true }, true)).toEqual({
      interim: '',
      final: 'done'
    });
  });
});

describe('error messages', () => {
  test('recognizer errors: a backend message wins', () => {
    expect(getRecognitionErrorMessage({ error: 'service', message: 'upstream down' }, t)).toBe(
      'upstream down'
    );
    expect(getRecognitionErrorMessage({ error: 'not-allowed' }, t)).toMatch(/allow microphone/);
  });

  describe('microphone errors', () => {
    afterEach(() => {
      delete navigator.mediaDevices;
    });

    test('tell permission, missing device and busy device apart', () => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: () => {} },
        configurable: true
      });
      expect(getMicrophoneErrorMessage({ name: 'NotAllowedError' }, t)).toMatch(/allow microphone/);
      expect(getMicrophoneErrorMessage({ name: 'NotFoundError' }, t)).toMatch(/No microphone/);
      expect(getMicrophoneErrorMessage({ name: 'NotReadableError' }, t)).toMatch(/in use/);
    });

    test('without getUserMedia (plain http) the fix is a secure connection', () => {
      expect(getMicrophoneErrorMessage({ name: 'NotAllowedError' }, t)).toMatch(/HTTPS/);
    });
  });
});
