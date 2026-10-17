/**
 * Voice mode (issue #2868), speech service `azure`: the Azure Speech SDK fed
 * from the session's audio. The SDK is mocked: push streams record what is
 * written, recognizers are driven by hand (results, end of stream).
 *
 * One recognizer per turn: closing the push stream is what ends a turn
 * deterministically, and the SDK cannot reopen a closed stream.
 */

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api${path}`
}));
jest.mock('../../../client/src/utils/azureRecognitionService', () => ({
  __esModule: true,
  default: class {}
}));
jest.mock('../../../client/src/utils/modelRecognitionService', () => ({
  __esModule: true,
  default: class {}
}));

import { createAzureAdapter } from '../../../client/src/features/voice/utils/voiceSession/azureAdapter';

function makeSdk() {
  const streams = [];
  const recognizers = [];
  const sdk = {
    streams,
    recognizers,
    AudioStreamFormat: {
      getWaveFormatPCM: jest.fn((rate, bits, channels) => ({ rate, bits, channels }))
    },
    AudioInputStream: {
      createPushStream: jest.fn(format => {
        const stream = {
          format,
          written: [],
          closed: false,
          write: jest.fn(buffer => {
            if (stream.closed) throw new Error('write after close');
            stream.written.push(buffer);
          }),
          close: jest.fn(() => {
            stream.closed = true;
          })
        };
        streams.push(stream);
        return stream;
      })
    },
    AudioConfig: { fromStreamInput: jest.fn(stream => ({ stream })) },
    SpeechConfig: {
      fromHost: jest.fn(url => ({ kind: 'host', url })),
      fromAuthorizationToken: jest.fn((token, region) => ({ kind: 'token', token, region }))
    },
    SpeechRecognizer: jest.fn(function (config, audioConfig) {
      this.config = config;
      this.audioConfig = audioConfig;
      this.startContinuousRecognitionAsync = jest.fn(ok => ok?.());
      this.stopContinuousRecognitionAsync = jest.fn(ok => ok?.());
      this.close = jest.fn();
      recognizers.push(this);
    }),
    ResultReason: {
      RecognizingSpeech: 'recognizing',
      RecognizedSpeech: 'recognized',
      NoMatch: 'nomatch'
    },
    CancellationReason: { Error: 0, EndOfStream: 1 },
    CancellationErrorCode: {
      NoError: 0,
      ConnectionFailure: 'connection-failure',
      ServiceTimeout: 'service-timeout',
      Forbidden: 'forbidden'
    }
  };
  return sdk;
}

const pcm = (value, length = 160) => new Int16Array(length).fill(value);
const flush = () =>
  Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => Promise.resolve());
const tokenFor = (n = 1) => ({ token: `token-${n}`, region: 'westeurope' });

function setup(options = {}) {
  const sdk = makeSdk();
  const events = [];
  let tokens = 0;
  const fetchToken = jest.fn(async () => tokenFor(++tokens));
  const adapter = createAzureAdapter({
    language: 'de',
    speech: { azure: { enabled: true, keyConfigured: true } },
    emit: event => events.push(event),
    loadSdk: async () => sdk,
    fetchToken,
    finalizeTimeoutMs: 3000,
    ...options
  });
  return { adapter, sdk, events, fetchToken };
}

const rec = (sdk, index = sdk.recognizers.length - 1) => sdk.recognizers[index];
const hear = (recognizer, text, reason = 'recognizing') =>
  recognizer.recognizing?.(recognizer, { result: { reason, text } });
const recognized = (recognizer, text, reason = 'recognized') =>
  recognizer.recognized?.(recognizer, { result: { reason, text } });
const endOfStream = recognizer => recognizer.canceled?.(recognizer, { reason: 1, errorCode: 0 });
const texts = (events, type) => events.filter(event => event.type === type).map(e => e.text);

afterEach(() => jest.useRealTimers());

describe('azure adapter: setup', () => {
  test('loads the SDK and fetches the token before the first turn', async () => {
    const { adapter, fetchToken } = setup();
    await adapter.start();
    expect(fetchToken).toHaveBeenCalledTimes(1);
    adapter.stop();
  });

  test('a failing token request fails start() with the reason', async () => {
    const { adapter } = setup({
      fetchToken: async () => {
        throw new Error('Azure Speech is not enabled');
      }
    });
    await expect(adapter.start()).rejects.toMatchObject({
      code: 'service',
      message: 'Azure Speech is not enabled'
    });
  });

  test('without a subscription key on the server no token is requested (on-premise container)', async () => {
    const { adapter, sdk, fetchToken } = setup({
      speech: { azure: { enabled: true, keyConfigured: false, host: 'ws://speech.internal:5000' } }
    });
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    expect(fetchToken).not.toHaveBeenCalled();
    const config = rec(sdk).config;
    expect(sdk.SpeechConfig.fromHost).toHaveBeenCalledTimes(1);
    expect(sdk.SpeechConfig.fromHost.mock.calls[0][0].host).toBe('speech.internal:5000');
    expect(config.authorizationToken).toBeUndefined();
    expect(config.speechRecognitionLanguage).toBe('de-DE');
    adapter.stop();
  });

  test('keyless without a host cannot recognise: the turn reports a service error', async () => {
    const { adapter, events, sdk } = setup({ speech: { azure: { enabled: true } } });
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    expect(sdk.recognizers).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'service', recoverable: false })
    ]);
  });

  test('with a host and a key the recognizer uses the host and the token', async () => {
    const { adapter, sdk } = setup({
      speech: { azure: { enabled: true, keyConfigured: true, host: 'https://speech.example.com' } }
    });
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    expect(rec(sdk).config).toMatchObject({ kind: 'host', authorizationToken: 'token-1' });
    adapter.stop();
  });

  test('without a host the region of the token response is used', async () => {
    const { adapter, sdk } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    expect(sdk.SpeechConfig.fromAuthorizationToken).toHaveBeenCalledWith('token-1', 'westeurope');
    expect(rec(sdk).config.speechRecognitionLanguage).toBe('de-DE');
    adapter.stop();
  });
});

describe('azure adapter: a turn', () => {
  test('feeds the recognizer through a 16 kHz PCM16 push stream: pre-roll first, then the frames', async () => {
    const { adapter, sdk } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(7, 480));
    // Written at once, before the recognizer exists: the stream buffers it
    expect(sdk.streams).toHaveLength(1);
    expect(sdk.AudioStreamFormat.getWaveFormatPCM).toHaveBeenCalledWith(16000, 16, 1);
    expect(sdk.streams[0].written).toHaveLength(1);
    expect(sdk.streams[0].written[0].byteLength).toBe(960);

    await flush();
    expect(sdk.AudioConfig.fromStreamInput).toHaveBeenCalledWith(sdk.streams[0]);
    expect(rec(sdk).audioConfig).toEqual({ stream: sdk.streams[0] });
    expect(rec(sdk).startContinuousRecognitionAsync).toHaveBeenCalledTimes(1);

    adapter.pushAudio(pcm(8));
    adapter.pushAudio(pcm(9));
    expect(sdk.streams[0].written.map(buffer => new Int16Array(buffer)[0])).toEqual([7, 8, 9]);
    adapter.stop();
  });

  test('interim text comes from the recognizing events and the finished phrases', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    const recognizer = rec(sdk);

    hear(recognizer, 'Wie ist');
    hear(recognizer, 'Wie ist das Wetter');
    recognized(recognizer, 'Wie ist das Wetter heute?');
    hear(recognizer, 'Und morgen');
    expect(texts(events, 'interim')).toEqual([
      'Wie ist',
      'Wie ist das Wetter',
      'Wie ist das Wetter heute?',
      'Wie ist das Wetter heute? Und morgen'
    ]);
    adapter.stop();
  });

  test('the turn ends when the audio ends: the push stream is closed, the final waits for the SDK', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    const recognizer = rec(sdk);
    recognized(recognizer, 'Wie ist das Wetter?');

    adapter.commitTurn();
    expect(sdk.streams[0].close).toHaveBeenCalledTimes(1);
    expect(texts(events, 'final')).toEqual([]);

    // The service delivers the last phrase, the SDK reports the end of the stream
    recognized(recognizer, 'Heute bitte.');
    endOfStream(recognizer);
    expect(texts(events, 'final')).toEqual(['Wie ist das Wetter? Heute bitte.']);

    // The recognizer is released, the stream is not written to any more
    expect(recognizer.stopContinuousRecognitionAsync).toHaveBeenCalled();
    expect(recognizer.close).toHaveBeenCalledTimes(1);
    adapter.pushAudio(pcm(2));
    expect(sdk.streams[0].written).toHaveLength(1);
    adapter.stop();
  });

  test('sessionStopped ends the turn as well', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    recognized(rec(sdk), 'Hallo');
    adapter.commitTurn();
    rec(sdk).sessionStopped();
    expect(texts(events, 'final')).toEqual(['Hallo']);
    adapter.stop();
  });

  test('nothing recognised (NoMatch) gives an empty transcript', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    recognized(rec(sdk), '', 'nomatch');
    adapter.commitTurn();
    endOfStream(rec(sdk));
    expect(texts(events, 'final')).toEqual(['']);
    adapter.stop();
  });

  test('a hypothesis the service never finished is kept when the stream ended', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    hear(rec(sdk), 'Fast fertig');
    adapter.commitTurn();
    endOfStream(rec(sdk));
    expect(texts(events, 'final')).toEqual(['Fast fertig']);
    adapter.stop();
  });

  test('a commit before the recognizer is built still ends the turn once it has run', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    adapter.commitTurn(); // the token/recognizer is still on its way
    await flush();
    expect(sdk.streams[0].closed).toBe(true);
    recognized(rec(sdk), 'Kurz');
    endOfStream(rec(sdk));
    expect(texts(events, 'final')).toEqual(['Kurz']);
    adapter.stop();
  });

  test('a turn the SDK never ends still ends after a timeout', async () => {
    jest.useFakeTimers();
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    recognized(rec(sdk), 'Es hängt');
    adapter.commitTurn();
    jest.advanceTimersByTime(2999);
    expect(texts(events, 'final')).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(texts(events, 'final')).toEqual(['Es hängt']);
    expect(rec(sdk).close).toHaveBeenCalled();
    adapter.stop();
  });

  test('a dropped turn (muted mid-sentence) gives no transcript and frees the SDK', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    hear(rec(sdk), 'Halbfertig');
    adapter.cancelTurn();
    expect(sdk.streams[0].closed).toBe(true);
    expect(rec(sdk).close).toHaveBeenCalled();
    recognized(rec(sdk), 'late');
    endOfStream(rec(sdk));
    expect(texts(events, 'final')).toEqual([]);
    adapter.stop();
  });

  test('muted: no recognizer is opened and no audio is written', async () => {
    const { adapter, sdk } = setup();
    await adapter.start();
    adapter.setMuted(true);
    adapter.beginTurn(pcm(1));
    await flush();
    expect(sdk.streams).toHaveLength(0);
    expect(sdk.recognizers).toHaveLength(0);
    adapter.stop();
  });
});

describe('azure adapter: many turns', () => {
  test('each turn gets its own push stream and recognizer; the token is fetched once', async () => {
    const { adapter, sdk, events, fetchToken } = setup();
    await adapter.start();

    adapter.beginTurn(pcm(1));
    await flush();
    recognized(rec(sdk), 'Eins');
    adapter.commitTurn();
    endOfStream(rec(sdk));

    adapter.beginTurn(pcm(2));
    await flush();
    recognized(rec(sdk), 'Zwei');
    adapter.commitTurn();
    endOfStream(rec(sdk));

    expect(sdk.streams).toHaveLength(2);
    expect(sdk.recognizers).toHaveLength(2);
    expect(texts(events, 'final')).toEqual(['Eins', 'Zwei']);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    adapter.stop();
  });

  test('the token is renewed before it expires', async () => {
    let clock = 0;
    const { adapter, sdk, fetchToken } = setup({ now: () => clock, tokenMaxAgeMs: 60_000 });
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    adapter.commitTurn();
    endOfStream(rec(sdk));

    clock = 61_000;
    adapter.beginTurn(pcm(1));
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(sdk.SpeechConfig.fromAuthorizationToken).toHaveBeenLastCalledWith(
      'token-2',
      'westeurope'
    );
    adapter.stop();
  });

  test('the next turn does not wait for the last one to be finalised', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    const first = rec(sdk);
    recognized(first, 'Eins');
    adapter.commitTurn(); // still waiting for the SDK

    adapter.beginTurn(pcm(2));
    await flush();
    const second = rec(sdk);
    expect(second).not.toBe(first);
    adapter.pushAudio(pcm(3));
    expect(sdk.streams[1].written).toHaveLength(2);
    expect(sdk.streams[0].written).toHaveLength(1);

    endOfStream(first);
    expect(texts(events, 'final')).toEqual(['Eins']);
    adapter.stop();
  });
});

describe('azure adapter: failures', () => {
  test('a recognition error ends the session with the SDK reason', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    rec(sdk).canceled(rec(sdk), {
      reason: 0,
      errorCode: 'connection-failure',
      errorDetails: 'Unable to contact server'
    });
    expect(events).toEqual([
      {
        type: 'error',
        code: 'connection',
        message: 'Unable to contact server',
        recoverable: false
      }
    ]);
    expect(rec(sdk).close).toHaveBeenCalled();
    adapter.stop();
  });

  test('an authorisation error is a service error', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    rec(sdk).canceled(rec(sdk), { reason: 0, errorCode: 'forbidden', errorDetails: 'Forbidden' });
    expect(events[0]).toMatchObject({ type: 'error', code: 'service', recoverable: false });
    adapter.stop();
  });

  test('a recognizer that cannot be started ends the session', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    sdk.SpeechRecognizer.mockImplementationOnce(function () {
      this.startContinuousRecognitionAsync = (_ok, fail) => fail('socket refused');
      this.stopContinuousRecognitionAsync = jest.fn();
      this.close = jest.fn();
    });
    adapter.beginTurn(pcm(1));
    await flush();
    expect(events[0]).toMatchObject({
      type: 'error',
      recoverable: false,
      message: 'socket refused'
    });
    adapter.stop();
  });

  test('stop() closes every open turn and silences the adapter', async () => {
    const { adapter, sdk, events } = setup();
    await adapter.start();
    adapter.beginTurn(pcm(1));
    await flush();
    const first = rec(sdk);
    recognized(first, 'Eins');
    adapter.commitTurn(); // finalising
    adapter.beginTurn(pcm(2)); // active
    await flush();
    const second = rec(sdk);
    const before = events.length;

    adapter.stop();
    expect(sdk.streams.every(stream => stream.closed)).toBe(true);
    expect(first.close).toHaveBeenCalled();
    expect(second.close).toHaveBeenCalled();
    endOfStream(first);
    expect(events).toHaveLength(before); // no final, no error after stop()
    adapter.stop(); // idempotent
    adapter.beginTurn(pcm(3));
    expect(sdk.streams).toHaveLength(2);
  });
});
