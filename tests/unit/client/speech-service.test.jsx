/**
 * Dictation service selection and recognizer plumbing shared by the chat's
 * microphone button and the admin voice-input test panel (issue #2622).
 *
 * A choice is `{ service, modelId }`: the browser, Azure Speech, or any
 * transcription model. "default" follows the platform default (Admin → Voice
 * Input), an explicit choice wins, and a platform default whose backend is
 * switched off — or whose model is not an enabled transcription model — falls
 * back to the browser instead of failing.
 */
jest.mock('../../../client/src/utils/azureRecognitionService', () => ({
  __esModule: true,
  default: class AzureSpeechRecognition {
    usesTextEventShape = true;
    initRecognizer() {}
  }
}));
jest.mock('../../../client/src/utils/modelRecognitionService', () => ({
  __esModule: true,
  default: class ModelSpeechRecognition {
    usesTextEventShape = true;
    constructor(modelId) {
      this.modelId = modelId;
    }
  }
}));

import {
  createSpeechRecognizer,
  fromDictationValue,
  getMicrophoneErrorMessage,
  getPlatformDefaultService,
  getRecognitionErrorMessage,
  parseRecognitionResult,
  resolveSpeechService,
  toDictationValue,
  toRecognitionLang
} from '../../../client/src/features/voice/utils/speechService';
import AzureSpeechRecognition from '../../../client/src/utils/azureRecognitionService';
import ModelSpeechRecognition from '../../../client/src/utils/modelRecognitionService';

const t = (key, fallback) => fallback;
const appWith = (service, modelId) => ({ settings: { speechRecognition: { service, modelId } } });
const platform = speech => ({ speech });
const BROWSER = { service: 'browser', modelId: '' };
const VOXTRAL = { service: 'model', modelId: 'voxtral' };
const ALL_ENABLED = {
  dictation: { modelId: 'voxtral', available: true },
  azure: { enabled: true }
};

describe('resolveSpeechService', () => {
  test('without any configuration it is the browser, as before', () => {
    expect(resolveSpeechService({}, null)).toEqual(BROWSER);
    expect(resolveSpeechService(appWith('default'), platform({}))).toEqual(BROWSER);
  });

  test('"default" and no setting follow the platform default', () => {
    const cfg = platform({ ...ALL_ENABLED, defaultService: 'model' });
    expect(resolveSpeechService(appWith('default'), cfg)).toEqual(VOXTRAL);
    expect(resolveSpeechService({}, cfg)).toEqual(VOXTRAL);
    expect(resolveSpeechService({ settings: {} }, cfg)).toEqual(VOXTRAL);
  });

  test('an explicit choice wins over the platform default', () => {
    const cfg = platform({ ...ALL_ENABLED, defaultService: 'model' });
    expect(resolveSpeechService(appWith('browser'), cfg)).toEqual(BROWSER);
    expect(resolveSpeechService(appWith('azure'), cfg)).toEqual({ service: 'azure', modelId: '' });
    expect(resolveSpeechService(appWith('model', 'gemini-live'), cfg)).toEqual({
      service: 'model',
      modelId: 'gemini-live'
    });
  });

  test('a model choice without a model follows the platform default', () => {
    const cfg = platform({ ...ALL_ENABLED, defaultService: 'azure' });
    expect(resolveSpeechService(appWith('model', ''), cfg)).toEqual({
      service: 'azure',
      modelId: ''
    });
  });

  test('"custom" keeps falling back to the browser', () => {
    const cfg = platform({ ...ALL_ENABLED, defaultService: 'azure' });
    expect(resolveSpeechService(appWith('custom'), cfg)).toEqual(BROWSER);
  });

  test('an explicit model is used even when it is off (the server error then says why)', () => {
    expect(resolveSpeechService(appWith('model', 'voxtral'), platform({}))).toEqual(VOXTRAL);
  });
});

describe('getPlatformDefaultService', () => {
  test('uses the configured backend when it is enabled', () => {
    expect(getPlatformDefaultService({ ...ALL_ENABLED, defaultService: 'azure' })).toEqual({
      service: 'azure',
      modelId: ''
    });
    expect(getPlatformDefaultService({ ...ALL_ENABLED, defaultService: 'model' })).toEqual(VOXTRAL);
  });

  test('falls back to the browser when the configured backend is off', () => {
    expect(
      getPlatformDefaultService({ defaultService: 'azure', azure: { enabled: false } })
    ).toEqual(BROWSER);
    expect(
      getPlatformDefaultService({
        defaultService: 'model',
        dictation: { modelId: 'voxtral', available: false }
      })
    ).toEqual(BROWSER);
    expect(
      getPlatformDefaultService({ defaultService: 'model', dictation: { modelId: '' } })
    ).toEqual(BROWSER);
  });

  test('ignores an unknown value, the retired vllm-realtime included', () => {
    for (const defaultService of ['custom', 'vllm-realtime']) {
      expect(getPlatformDefaultService({ ...ALL_ENABLED, defaultService })).toEqual(BROWSER);
    }
  });
});

describe('dictation choice as one select value', () => {
  test.each([
    [BROWSER, 'browser'],
    [{ service: 'azure', modelId: '' }, 'azure'],
    [VOXTRAL, 'model:voxtral']
  ])('%j ↔ %s', (choice, value) => {
    expect(toDictationValue(choice)).toBe(value);
    expect(fromDictationValue(value)).toEqual(choice);
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

  test('model builds the iHub-proxied recognizer for that model', () => {
    const recognition = createSpeechRecognizer('model', { modelId: 'voxtral' });
    expect(recognition).toBeInstanceOf(ModelSpeechRecognition);
    expect(recognition.modelId).toBe('voxtral');
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

  test('{ text, isFinal } events (Azure, transcription models)', () => {
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
