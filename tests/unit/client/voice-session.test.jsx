/**
 * Voice mode (issue #2868): `createVoiceSession`, the microphone half of voice
 * mode. Browser audio is faked: the microphone stream, the AudioContext and the
 * capture graph (the test pushes frames by hand), the Silero detector (driven by
 * hand, behind the same factory as the real one) and the speech adapter.
 * What is under test is the session's own job: one stream and one context, audio
 * only flows during a turn, the pre-roll, barge-in, push-to-talk, mute, losing
 * the microphone and a clean, idempotent `stop()`.
 */

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api${path}`,
  buildWsUrl: path => `ws://localhost${path}`,
  buildAssetUrl: path => path
}));
jest.mock('../../../client/src/utils/azureRecognitionService', () => ({
  __esModule: true,
  default: class {}
}));
jest.mock('../../../client/src/utils/modelRecognitionService', () => ({
  __esModule: true,
  default: class {}
}));

const mockCaptures = [];
jest.mock('../../../client/src/features/voice/utils/voiceSession/capture', () => ({
  createCapture: jest.fn(async ({ onFrame, audioContext }) => {
    const capture = { onFrame, audioContext, stop: jest.fn(), sampleRate: 16000 };
    mockCaptures.push(capture);
    return capture;
  })
}));

import { createVoiceSession } from '../../../client/src/features/voice/utils/voiceSession';
import { createCapture } from '../../../client/src/features/voice/utils/voiceSession/capture';

// --- fakes ---

class FakeTrack {
  constructor() {
    this.readyState = 'live';
    this.stop = jest.fn(() => {
      this.readyState = 'ended';
    });
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= new Set()).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type]?.delete(fn);
  }
  fire(type) {
    for (const fn of [...(this.listeners[type] || [])]) fn();
  }
  listenerCount() {
    return Object.values(this.listeners).reduce((sum, set) => sum + set.size, 0);
  }
}

class FakeStream {
  constructor() {
    this.track = new FakeTrack();
  }
  getAudioTracks() {
    return [this.track];
  }
  getTracks() {
    return [this.track];
  }
}

const contexts = [];
class FakeAudioContext {
  constructor(options) {
    this.options = options;
    this.sampleRate = options?.sampleRate || 48000;
    this.state = 'running';
    this.resume = jest.fn(async () => {});
    this.close = jest.fn(async () => {
      this.state = 'closed';
    });
    contexts.push(this);
  }
}

function fakeVadFactory() {
  const created = [];
  const factory = jest.fn(async options => {
    const vad = {
      options,
      setOptions: jest.fn(),
      start: jest.fn(async () => {}),
      pause: jest.fn(async () => {}),
      destroy: jest.fn(async () => {})
    };
    created.push(vad);
    return vad;
  });
  return { factory, created, last: () => created[created.length - 1] };
}

function fakeAdapterFactory({ startError, startGate } = {}) {
  const instances = [];
  const create = ({ emit, ...rest }) => {
    const adapter = {
      emit,
      args: rest,
      start: jest.fn(async () => {
        await startGate;
        if (startError) throw startError;
      }),
      beginTurn: jest.fn(),
      pushAudio: jest.fn(),
      commitTurn: jest.fn(),
      cancelTurn: jest.fn(),
      setAgentState: jest.fn(),
      setListeningStyle: jest.fn(),
      setMuted: jest.fn(),
      stop: jest.fn()
    };
    instances.push(adapter);
    return adapter;
  };
  return { create, instances, last: () => instances[instances.length - 1] };
}

/** `ms` milliseconds of 16 kHz audio at one constant amplitude. */
const audio = (ms, amplitude = 0.1) => new Float32Array((ms / 1000) * 16000).fill(amplitude);
const FRAME_MS = 32;

async function start(options = {}) {
  const stream = new FakeStream();
  const getUserMedia = jest.fn(async () => stream);
  const vad = fakeVadFactory();
  const adapter = fakeAdapterFactory(options.adapter);
  const events = [];
  let clock = 10_000;
  const session = await createVoiceSession({
    service: 'browser',
    language: 'de',
    listeningStyle: 'hands-free',
    bargeIn: true,
    endOfTurnSilenceMs: 800,
    onEvent: event => events.push(event),
    ...options.session,
    overrides: {
      AudioContext: FakeAudioContext,
      getUserMedia,
      createVad: vad.factory,
      createAdapter: adapter.create,
      pttTailMs: 0,
      now: () => clock,
      ...options.overrides
    }
  });
  const readyNow = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const capture = () => mockCaptures[mockCaptures.length - 1];
  /** Microphone audio, in 32 ms frames. */
  const hear = (ms, amplitude) => {
    for (let t = 0; t < ms; t += FRAME_MS) capture().onFrame(audio(FRAME_MS, amplitude), 16000);
  };
  return {
    session,
    stream,
    getUserMedia,
    vad,
    adapter,
    events,
    readyNow,
    capture,
    hear,
    advance: ms => {
      clock += ms;
    },
    ofType: type => events.filter(event => event.type === type),
    types: () => events.filter(event => event.type !== 'level').map(event => event.type)
  };
}

/** The detector confirms speech that began `speechMs` ago, then ends it. */
const detectSpeech = (h, speechMs = 250) => {
  const { options } = h.vad.last();
  options.onSpeechStart();
  h.advance(speechMs);
  options.onSpeechRealStart();
};
const detectSilence = h => h.vad.last().options.onSpeechEnd();

beforeEach(() => {
  mockCaptures.length = 0;
  contexts.length = 0;
  createCapture.mockClear();
});

// --- tests ---

describe('starting a session', () => {
  test('opens one echo-cancelled stream and one AudioContext, and shares them with the detector', async () => {
    const h = await start();
    await h.readyNow();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    expect(contexts).toHaveLength(1);
    // 16 kHz where the browser allows it
    expect(contexts[0].options).toEqual({ sampleRate: 16000 });
    expect(contexts[0].resume).toHaveBeenCalled();
    // Capture and detector both run on that stream and context
    expect(createCapture).toHaveBeenCalledTimes(1);
    expect(h.capture().audioContext).toBe(contexts[0]);
    expect(h.vad.factory).toHaveBeenCalledTimes(1);
    expect(h.vad.last().options.stream).toBe(h.stream);
    expect(h.vad.last().options.audioContext).toBe(contexts[0]);
    h.session.stop();
  });

  test('the AudioContext exists before the microphone prompt is answered (it must be created in the click)', async () => {
    let release;
    const stream = new FakeStream();
    const getUserMedia = jest.fn(
      () =>
        new Promise(resolve => {
          release = () => resolve(stream);
        })
    );
    contexts.length = 0;
    const pending = createVoiceSession({
      service: 'browser',
      onEvent: () => {},
      overrides: {
        AudioContext: FakeAudioContext,
        getUserMedia,
        createVad: fakeVadFactory().factory,
        createAdapter: fakeAdapterFactory().create
      }
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resume).toHaveBeenCalled();
    release();
    (await pending).stop();
  });

  test('retries with the default sample rate when the engine refuses a 16 kHz context', async () => {
    createCapture.mockImplementationOnce(async () => {
      throw new Error('NotSupportedError: different sample rate');
    });
    const h = await start();
    expect(contexts).toHaveLength(2);
    expect(contexts[0].close).toHaveBeenCalled();
    expect(contexts[1].options).toBeUndefined();
    expect(h.capture().audioContext).toBe(contexts[1]);
    h.session.stop();
  });

  test('resolves once the microphone is open; `ready` follows when detector and adapter are up', async () => {
    const h = await start();
    expect(h.types()).toEqual([]);
    await h.readyNow();
    expect(h.types()).toEqual(['ready']);
    expect(h.adapter.last().start).toHaveBeenCalledTimes(1);
    h.session.stop();
  });

  test('hands-free needs the detector; push-to-talk never loads it', async () => {
    const hands = await start();
    await hands.readyNow();
    expect(hands.vad.factory).toHaveBeenCalledTimes(1);
    hands.session.stop();

    const ptt = await start({ session: { listeningStyle: 'push-to-talk' } });
    await ptt.readyNow();
    expect(ptt.vad.factory).not.toHaveBeenCalled();
    expect(ptt.types()).toEqual(['ready']);
    ptt.session.stop();
  });

  test('passes the end-of-turn silence to the detector, within sane bounds', async () => {
    const custom = await start({ session: { endOfTurnSilenceMs: 1200 } });
    await custom.readyNow();
    expect(custom.vad.last().options.redemptionMs).toBe(1200);
    custom.session.stop();

    const tooShort = await start({ session: { endOfTurnSilenceMs: 50 } });
    await tooShort.readyNow();
    expect(tooShort.vad.last().options.redemptionMs).toBe(300);
    tooShort.session.stop();
  });

  test('hands the adapter what it needs to know', async () => {
    const h = await start({
      session: { service: 'azure', modelId: 'm', language: 'de', speech: { azure: { host: 'h' } } }
    });
    expect(h.adapter.last().args).toMatchObject({
      service: 'azure',
      language: 'de',
      listeningStyle: 'hands-free',
      speech: { azure: { host: 'h' } }
    });
    h.session.stop();
  });

  test('a denied microphone rejects with a code and releases the AudioContext', async () => {
    contexts.length = 0;
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    await expect(
      createVoiceSession({
        service: 'browser',
        onEvent: () => {},
        overrides: {
          AudioContext: FakeAudioContext,
          getUserMedia: async () => {
            throw denied;
          }
        }
      })
    ).rejects.toMatchObject({ code: 'mic-denied', name: 'NotAllowedError' });
    expect(contexts[0].close).toHaveBeenCalled();
  });

  test.each([
    ['NotFoundError', 'mic-missing'],
    ['NotReadableError', 'mic-busy'],
    ['SomethingElse', 'start-failed']
  ])('a %s microphone failure is reported as %s', async (name, code) => {
    await expect(
      createVoiceSession({
        service: 'browser',
        onEvent: () => {},
        overrides: {
          AudioContext: FakeAudioContext,
          getUserMedia: async () => {
            throw Object.assign(new Error('x'), { name });
          }
        }
      })
    ).rejects.toMatchObject({ code });
  });

  test('the model service needs a model', async () => {
    await expect(
      createVoiceSession({
        service: 'model',
        onEvent: () => {},
        overrides: { AudioContext: FakeAudioContext }
      })
    ).rejects.toMatchObject({ code: 'no-model' });
  });

  test('a browser without Web Audio cannot start', async () => {
    await expect(
      createVoiceSession({
        service: 'browser',
        onEvent: () => {},
        overrides: { AudioContext: null, getUserMedia: async () => new FakeStream() }
      })
    ).rejects.toMatchObject({ code: 'audio-unsupported' });
  });
});

describe('hands-free turns', () => {
  test('audio stays in the pre-roll buffer until speech is confirmed, then the turn starts with it', async () => {
    const h = await start();
    await h.readyNow();

    h.hear(1000);
    expect(h.adapter.last().pushAudio).not.toHaveBeenCalled();
    expect(h.adapter.last().beginTurn).not.toHaveBeenCalled();

    // Confirmed 250 ms after the detector first saw speech
    detectSpeech(h, 250);
    expect(h.types()).toEqual(['ready', 'speech-start']);
    expect(h.adapter.last().beginTurn).toHaveBeenCalledTimes(1);
    const [preRoll, info] = h.adapter.last().beginTurn.mock.calls[0];
    expect(info).toEqual({ source: 'vad' });
    // 300 ms pre-roll + the 250 ms before confirmation + 64 ms margin, at 16 kHz
    expect(preRoll).toBeInstanceOf(Int16Array);
    expect(preRoll.length).toBe(Math.round(((300 + 250 + 64) / 1000) * 16000));
    // The pre-roll is real audio, not silence
    expect(preRoll[0]).not.toBe(0);

    // From now on the frames go straight to the adapter
    h.hear(96, 0.2);
    expect(h.adapter.last().pushAudio).toHaveBeenCalledTimes(3);
    expect(h.adapter.last().pushAudio.mock.calls[0][0]).toBeInstanceOf(Int16Array);
    expect(h.adapter.last().pushAudio.mock.calls[0][0].length).toBe(512);
    h.session.stop();
  });

  test('the pre-roll never holds more than the buffer, however long the user has been quiet', async () => {
    const h = await start();
    await h.readyNow();
    h.hear(10_000);
    detectSpeech(h, 250);
    const [preRoll] = h.adapter.last().beginTurn.mock.calls[0];
    expect(preRoll.length).toBeLessThanOrEqual(2000 * 16);
    h.session.stop();
  });

  test('silence ends the turn: turn-end first, then the adapter commits, then its final is passed on', async () => {
    const h = await start();
    await h.readyNow();
    detectSpeech(h);
    h.hear(320);
    detectSilence(h);

    expect(h.types()).toEqual(['ready', 'speech-start', 'turn-end']);
    expect(h.adapter.last().commitTurn).toHaveBeenCalledTimes(1);

    h.adapter.last().emit({ type: 'interim', text: 'Wie ist' });
    h.adapter.last().emit({ type: 'final', text: 'Wie ist das Wetter?' });
    expect(h.ofType('interim')).toEqual([{ type: 'interim', text: 'Wie ist' }]);
    expect(h.ofType('final')).toEqual([{ type: 'final', text: 'Wie ist das Wetter?' }]);

    // After the turn the audio goes back into the buffer, not to the adapter
    const pushed = h.adapter.last().pushAudio.mock.calls.length;
    h.hear(320);
    expect(h.adapter.last().pushAudio).toHaveBeenCalledTimes(pushed);
    h.session.stop();
  });

  test('a second turn after the first works the same', async () => {
    const h = await start();
    await h.readyNow();
    for (let turn = 1; turn <= 2; turn++) {
      h.hear(500);
      detectSpeech(h);
      h.hear(200);
      detectSilence(h);
      expect(h.adapter.last().beginTurn).toHaveBeenCalledTimes(turn);
      expect(h.adapter.last().commitTurn).toHaveBeenCalledTimes(turn);
    }
    h.session.stop();
  });

  test('speech is ignored until the session is ready (the speech service is not connected yet)', async () => {
    let connected;
    const startGate = new Promise(resolve => {
      connected = resolve;
    });
    const h = await start({ adapter: { startGate } });
    await h.readyNow();
    // The detector is up, the speech service is not
    expect(h.vad.last()).toBeDefined();
    detectSpeech(h);
    detectSilence(h);
    expect(h.adapter.last().beginTurn).not.toHaveBeenCalled();
    expect(h.types()).toEqual([]);

    connected();
    await h.readyNow();
    expect(h.types()).toEqual(['ready']);
    detectSpeech(h);
    expect(h.adapter.last().beginTurn).toHaveBeenCalledTimes(1);
    h.session.stop();
  });

  test('the app speaking and the user interrupting: barge-in replaces speech-start', async () => {
    const h = await start();
    await h.readyNow();
    h.session.setAgentState('speaking');
    expect(h.vad.last().setOptions).toHaveBeenLastCalledWith({
      positiveSpeechThreshold: 0.65,
      negativeSpeechThreshold: 0.5,
      minSpeechMs: 350
    });
    expect(h.adapter.last().setAgentState).toHaveBeenCalledWith('speaking');

    h.hear(400);
    detectSpeech(h, 350);
    expect(h.types()).toEqual(['ready', 'barge-in']);
    expect(h.adapter.last().beginTurn).toHaveBeenCalledTimes(1);

    // The caller stops playback and tells the session
    h.session.setAgentState('idle');
    expect(h.vad.last().setOptions).toHaveBeenLastCalledWith({
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      minSpeechMs: 250
    });
    detectSilence(h);
    expect(h.types()).toEqual(['ready', 'barge-in', 'turn-end']);
    h.session.stop();
  });

  test('with interruptions off, speech while the app speaks starts nothing', async () => {
    const h = await start({ session: { bargeIn: false } });
    await h.readyNow();
    h.session.setAgentState('speaking');
    detectSpeech(h);
    detectSilence(h);
    expect(h.types()).toEqual(['ready']);
    expect(h.adapter.last().beginTurn).not.toHaveBeenCalled();

    h.session.setBargeIn(true);
    detectSpeech(h);
    expect(h.types()).toEqual(['ready', 'barge-in']);
    h.session.stop();
  });

  test('speech while the app thinks is an ordinary speech-start (the caller decides what it means)', async () => {
    const h = await start();
    await h.readyNow();
    h.session.setAgentState('thinking');
    detectSpeech(h);
    expect(h.types()).toEqual(['ready', 'speech-start']);
    h.session.stop();
  });

  test('ignores agent states it does not know', async () => {
    const h = await start();
    await h.readyNow();
    h.session.setAgentState('dancing');
    expect(h.adapter.last().setAgentState).not.toHaveBeenCalled();
    h.session.stop();
  });

  test('before the detector is up the app state is still applied to it', async () => {
    const h = await start();
    h.session.setAgentState('speaking');
    await h.readyNow();
    expect(h.vad.last().options).toMatchObject({ minSpeechMs: 350 });
    h.session.stop();
  });
});

describe('mic level', () => {
  test('is reported while audio comes in, about 15 times a second', async () => {
    const h = await start();
    await h.readyNow();
    let clockMs = 0;
    for (let i = 0; i < 30; i++) {
      h.capture().onFrame(audio(FRAME_MS, 0.15), 16000);
      clockMs += FRAME_MS;
      h.advance(FRAME_MS);
    }
    const levels = h.ofType('level');
    expect(levels.length).toBeGreaterThan(10);
    expect(levels.length).toBeLessThanOrEqual(16);
    expect(levels.every(event => event.level >= 0 && event.level <= 1)).toBe(true);
    expect(Math.max(...levels.map(event => event.level))).toBeGreaterThan(0.3);
    expect(clockMs).toBe(960);
    h.session.stop();
  });
});

describe('push-to-talk', () => {
  const ptt = async (extra = {}) => {
    const h = await start({
      session: { listeningStyle: 'push-to-talk', ...extra.session },
      ...extra
    });
    await h.readyNow();
    return h;
  };

  test('pressing starts a turn with 300 ms of pre-roll, releasing ends it', async () => {
    const h = await ptt();
    h.hear(1000);
    h.session.pushToTalkStart();
    expect(h.types()).toEqual(['ready', 'speech-start']);
    const [preRoll, info] = h.adapter.last().beginTurn.mock.calls[0];
    expect(info).toEqual({ source: 'ptt' });
    expect(preRoll.length).toBe(Math.round(((300 + 64) / 1000) * 16000));

    h.hear(320);
    expect(h.adapter.last().pushAudio).toHaveBeenCalledTimes(10);

    h.session.pushToTalkEnd();
    expect(h.types()).toEqual(['ready', 'speech-start', 'turn-end']);
    expect(h.adapter.last().commitTurn).toHaveBeenCalledTimes(1);
    h.session.stop();
  });

  test('releasing without pressing, or pressing twice, does nothing odd', async () => {
    const h = await ptt();
    h.session.pushToTalkEnd();
    expect(h.types()).toEqual(['ready']);
    h.session.pushToTalkStart();
    h.session.pushToTalkStart();
    expect(h.adapter.last().beginTurn).toHaveBeenCalledTimes(1);
    h.session.stop();
  });

  test('pressing while the app speaks interrupts it', async () => {
    const h = await ptt();
    h.session.setAgentState('speaking');
    h.session.pushToTalkStart();
    expect(h.types()).toEqual(['ready', 'barge-in']);
    h.session.stop();
  });

  test('with interruptions off, a press while the app speaks is ignored', async () => {
    const h = await ptt({ session: { bargeIn: false, listeningStyle: 'push-to-talk' } });
    h.session.setAgentState('speaking');
    h.session.pushToTalkStart();
    expect(h.types()).toEqual(['ready']);
    h.session.stop();
  });

  test('the detector does not decide turns in push-to-talk', async () => {
    const h = await ptt();
    expect(h.vad.factory).not.toHaveBeenCalled();
    h.session.stop();
  });

  test('push-to-talk is ignored in hands-free', async () => {
    const h = await start();
    await h.readyNow();
    h.session.pushToTalkStart();
    expect(h.types()).toEqual(['ready']);
    h.session.stop();
  });

  test('the turn goes on a little after the key is released, so the last word is not cut', async () => {
    jest.useFakeTimers();
    try {
      const h = await start({
        session: { listeningStyle: 'push-to-talk' },
        overrides: { pttTailMs: 150 }
      });
      await jest.advanceTimersByTimeAsync(10);
      h.session.pushToTalkStart();
      h.session.pushToTalkEnd();
      expect(h.adapter.last().commitTurn).not.toHaveBeenCalled();

      h.hear(64); // still recording during the tail
      expect(h.adapter.last().pushAudio).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(150);
      expect(h.adapter.last().commitTurn).toHaveBeenCalledTimes(1);
      expect(h.types()).toEqual(['ready', 'speech-start', 'turn-end']);
      h.session.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('pressing again within the tail ends the old turn and starts a new one', async () => {
    jest.useFakeTimers();
    try {
      const h = await start({
        session: { listeningStyle: 'push-to-talk' },
        overrides: { pttTailMs: 150 }
      });
      await jest.advanceTimersByTimeAsync(10);
      h.session.pushToTalkStart();
      h.session.pushToTalkEnd();
      h.session.pushToTalkStart();
      expect(h.adapter.last().commitTurn).toHaveBeenCalledTimes(1);
      expect(h.adapter.last().beginTurn).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(1000);
      expect(h.adapter.last().commitTurn).toHaveBeenCalledTimes(1); // the old timer is gone
      h.session.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('muting', () => {
  test('muting drops the turn in progress, stops all audio and silences the detector', async () => {
    const h = await start();
    await h.readyNow();
    detectSpeech(h);
    h.hear(96);
    const pushed = h.adapter.last().pushAudio.mock.calls.length;

    h.session.setMuted(true);
    expect(h.adapter.last().cancelTurn).toHaveBeenCalledTimes(1);
    expect(h.adapter.last().setMuted).toHaveBeenCalledWith(true);
    expect(h.vad.last().pause).toHaveBeenCalledTimes(1);
    // No turn-end: the turn was dropped, not finished
    expect(h.types()).toEqual(['ready', 'speech-start']);
    expect(h.ofType('level').slice(-1)[0]).toEqual({ type: 'level', level: 0 });

    // Nothing is recorded while muted
    h.hear(500);
    expect(h.adapter.last().pushAudio).toHaveBeenCalledTimes(pushed);

    // Speech reported by a detector that was still working is not a turn
    detectSpeech(h);
    expect(h.adapter.last().beginTurn).toHaveBeenCalledTimes(1);
    h.session.stop();
  });

  test('audio from before the mute is not sent after the unmute', async () => {
    const h = await start();
    await h.readyNow();
    h.hear(500, 0.3);
    h.session.setMuted(true);
    h.session.setMuted(false);
    expect(h.vad.last().start).toHaveBeenCalledTimes(1);
    expect(h.adapter.last().setMuted).toHaveBeenLastCalledWith(false);
    h.hear(100, 0.05);
    detectSpeech(h, 0);
    const [preRoll] = h.adapter.last().beginTurn.mock.calls[0];
    // Only the 100 ms recorded after the unmute (plus the margin), none of the loud audio
    expect(preRoll.length).toBeLessThanOrEqual(Math.round((100 / 1000) * 16000) + 512);
    expect(Math.max(...preRoll.map(Math.abs))).toBeLessThan(0.1 * 32768);
    h.session.stop();
  });

  test('the keepalive of the speech service is the adapter business: muting does not stop the session', async () => {
    const h = await start();
    await h.readyNow();
    h.session.setMuted(true);
    expect(h.adapter.last().stop).not.toHaveBeenCalled();
    expect(h.stream.track.stop).not.toHaveBeenCalled();
    h.session.stop();
  });

  test('push-to-talk is ignored while muted', async () => {
    const h = await start({ session: { listeningStyle: 'push-to-talk' } });
    await h.readyNow();
    h.session.setMuted(true);
    h.session.pushToTalkStart();
    expect(h.adapter.last().beginTurn).not.toHaveBeenCalled();
    h.session.stop();
  });
});

describe('changing the listening style', () => {
  test('hands-free to push-to-talk pauses the detector and ends a turn in progress', async () => {
    const h = await start();
    await h.readyNow();
    detectSpeech(h);
    h.session.setListeningStyle('push-to-talk');
    expect(h.types()).toEqual(['ready', 'speech-start', 'turn-end']);
    expect(h.adapter.last().commitTurn).toHaveBeenCalledTimes(1);
    expect(h.adapter.last().setListeningStyle).toHaveBeenCalledWith('push-to-talk');
    expect(h.vad.last().pause).toHaveBeenCalledTimes(1);

    h.session.pushToTalkStart();
    expect(h.adapter.last().beginTurn).toHaveBeenCalledTimes(2);
    h.session.stop();
  });

  test('push-to-talk to hands-free loads the detector on demand', async () => {
    const h = await start({ session: { listeningStyle: 'push-to-talk' } });
    await h.readyNow();
    expect(h.vad.factory).not.toHaveBeenCalled();

    h.session.setListeningStyle('hands-free');
    await h.readyNow();
    expect(h.vad.factory).toHaveBeenCalledTimes(1);
    expect(h.vad.last().pause).not.toHaveBeenCalled();
    detectSpeech(h);
    expect(h.types()).toEqual(['ready', 'speech-start']);
    h.session.stop();
  });

  test('an unknown or unchanged style does nothing', async () => {
    const h = await start();
    await h.readyNow();
    h.session.setListeningStyle('hands-free');
    h.session.setListeningStyle('whisper');
    expect(h.adapter.last().setListeningStyle).not.toHaveBeenCalled();
    h.session.stop();
  });

  test('a detector that cannot load after the switch is a recoverable error', async () => {
    const h = await start({ session: { listeningStyle: 'push-to-talk' } });
    await h.readyNow();
    h.vad.factory.mockRejectedValueOnce(new Error('404'));
    h.session.setListeningStyle('hands-free');
    await h.readyNow();
    expect(h.ofType('error')).toEqual([
      expect.objectContaining({ code: 'vad-unavailable', recoverable: true })
    ]);
    h.session.stop();
  });
});

describe('stop()', () => {
  test('releases everything exactly once and is idempotent', async () => {
    const h = await start();
    await h.readyNow();
    const context = contexts[0];
    const capture = h.capture();

    h.session.stop();
    h.session.stop();

    expect(h.adapter.last().stop).toHaveBeenCalledTimes(1);
    expect(h.vad.last().destroy).toHaveBeenCalledTimes(1);
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(h.stream.track.listenerCount()).toBe(0);
  });

  test('is silent: no events afterwards, not even `closed`', async () => {
    const h = await start();
    await h.readyNow();
    const before = h.events.length;
    h.session.stop();
    h.adapter.last().emit({ type: 'final', text: 'late' });
    h.capture().onFrame(audio(32), 16000);
    expect(h.events).toHaveLength(before);
  });

  test('setters after stop() are harmless', async () => {
    const h = await start();
    await h.readyNow();
    h.session.stop();
    expect(() => {
      h.session.setAgentState('speaking');
      h.session.setMuted(true);
      h.session.setBargeIn(false);
      h.session.setListeningStyle('push-to-talk');
      h.session.pushToTalkStart();
      h.session.pushToTalkEnd();
    }).not.toThrow();
  });

  test('before the session was ready: nothing is left behind and `ready` never comes', async () => {
    const h = await start();
    h.session.stop();
    await h.readyNow();
    expect(h.types()).toEqual([]);
    expect(h.adapter.last().start).not.toHaveBeenCalled();
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  test('while the detector is still loading: it is destroyed as soon as it arrives', async () => {
    let finishLoading;
    const detector = {
      setOptions: jest.fn(),
      start: jest.fn(),
      pause: jest.fn(async () => {}),
      destroy: jest.fn(async () => {})
    };
    const h = await start({
      overrides: {
        createVad: jest.fn(
          () =>
            new Promise(resolve => {
              finishLoading = () => resolve(detector);
            })
        )
      }
    });
    await h.readyNow();
    h.session.stop();
    finishLoading();
    await h.readyNow();
    expect(detector.destroy).toHaveBeenCalledTimes(1);
    expect(h.types()).toEqual([]);
  });

  test('a handler that throws does not break the session', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const h = await start({
      session: {
        onEvent: () => {
          throw new Error('handler bug');
        }
      }
    });
    await h.readyNow();
    expect(() => detectSpeech(h)).not.toThrow();
    h.session.stop();
    error.mockRestore();
  });
});

describe('failures', () => {
  test('an unrecoverable adapter error is reported, the session shuts down and says so', async () => {
    const h = await start();
    await h.readyNow();
    h.adapter.last().emit({
      type: 'error',
      code: 'connection',
      message: 'The speech connection was lost',
      recoverable: false
    });
    expect(h.types()).toEqual(['ready', 'error', 'closed']);
    expect(h.ofType('error')[0]).toEqual({
      type: 'error',
      code: 'connection',
      message: 'The speech connection was lost',
      recoverable: false
    });
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(h.adapter.last().stop).toHaveBeenCalledTimes(1);
    h.session.stop(); // the caller stops it too
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
  });

  test('an adapter that cannot start is an error event with its code, not a silent session', async () => {
    const startError = Object.assign(new Error('Speech recognition is not supported'), {
      code: 'unsupported'
    });
    const h = await start({ adapter: { startError } });
    await h.readyNow();
    expect(h.types()).toEqual(['error', 'closed']);
    expect(h.ofType('error')[0]).toMatchObject({
      code: 'unsupported',
      message: 'Speech recognition is not supported',
      recoverable: false
    });
    expect(h.stream.track.stop).toHaveBeenCalled();
  });

  test('a detector that cannot load is unrecoverable in hands-free', async () => {
    const h = await start({
      overrides: {
        createVad: jest.fn(async () => {
          throw new Error('404 silero_vad_v5.onnx');
        })
      }
    });
    await h.readyNow();
    expect(h.types()).toEqual(['error', 'closed']);
    expect(h.ofType('error')[0]).toMatchObject({ code: 'vad-unavailable', recoverable: false });
  });

  test('only one error is reported, however many things fail', async () => {
    const h = await start();
    await h.readyNow();
    h.adapter.last().emit({ type: 'error', code: 'service', message: 'a' });
    h.adapter.last().emit({ type: 'error', code: 'service', message: 'b' });
    expect(h.ofType('error')).toHaveLength(1);
  });
});

describe('losing the microphone', () => {
  const setHidden = hidden => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  afterEach(() => setHidden(false));

  test('a hidden tab stops the capture at once and is reported as mic-lost, recoverable', async () => {
    jest.useFakeTimers();
    try {
      const h = await start();
      await jest.advanceTimersByTimeAsync(10);
      detectSpeech(h);
      setHidden(true);
      // Nothing is recorded in the background, not even for a moment
      expect(h.adapter.last().cancelTurn).toHaveBeenCalledTimes(1);
      h.hear(320);
      expect(h.adapter.last().pushAudio).not.toHaveBeenCalled();
      expect(h.vad.last().pause).toHaveBeenCalled();

      jest.advanceTimersByTime(0);
      expect(h.ofType('error')).toEqual([
        expect.objectContaining({ code: 'mic-lost', recoverable: true })
      ]);
      expect(h.stream.track.stop).not.toHaveBeenCalled(); // the session lives on
      h.session.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a caller that mutes the session when the tab is hidden is not sent an error', async () => {
    jest.useFakeTimers();
    try {
      const h = await start();
      await jest.advanceTimersByTimeAsync(10);
      // What voice mode does on `visibilitychange`
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) h.session.setMuted(true);
      });
      setHidden(true);
      jest.advanceTimersByTime(0);
      expect(h.ofType('error')).toEqual([]);

      // Back on the page: still muted until the user unmutes
      setHidden(false);
      h.hear(320);
      expect(h.adapter.last().pushAudio).not.toHaveBeenCalled();
      h.session.setMuted(false);
      expect(h.adapter.last().setMuted).toHaveBeenLastCalledWith(false);
      expect(h.ofType('error')).toEqual([]);
      h.session.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('after an error for a hidden tab, unmuting brings the session back once the tab is visible', async () => {
    jest.useFakeTimers();
    try {
      const h = await start();
      await jest.advanceTimersByTimeAsync(10);
      setHidden(true);
      jest.advanceTimersByTime(0);
      expect(h.ofType('error')).toHaveLength(1);

      setHidden(false);
      // Still suspended: the user has not asked for the microphone back
      detectSpeech(h);
      expect(h.adapter.last().beginTurn).not.toHaveBeenCalled();

      h.session.setMuted(false);
      expect(h.ofType('error')).toHaveLength(1);
      detectSpeech(h);
      expect(h.adapter.last().beginTurn).toHaveBeenCalledTimes(1);
      h.session.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('unmuting while the tab is still hidden does not resume', async () => {
    jest.useFakeTimers();
    try {
      const h = await start();
      await jest.advanceTimersByTimeAsync(10);
      setHidden(true);
      jest.advanceTimersByTime(0);
      h.session.setMuted(false);
      expect(h.ofType('error')).toHaveLength(2); // told again
      h.hear(100);
      expect(h.adapter.last().pushAudio).not.toHaveBeenCalled();
      h.session.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('the microphone track ending (unplugged, permission revoked) is reported as mic-lost', async () => {
    const h = await start();
    await h.readyNow();
    h.stream.track.readyState = 'ended';
    h.stream.track.fire('ended');
    expect(h.ofType('error')).toEqual([
      expect.objectContaining({ code: 'mic-lost', recoverable: true })
    ]);
    h.hear(320);
    expect(h.adapter.last().pushAudio).not.toHaveBeenCalled();

    // Unmuting cannot bring a dead microphone back
    h.session.setMuted(false);
    expect(h.ofType('error')).toHaveLength(2);
    h.session.stop();
  });

  test('the browser muting the track (a call comes in) is reported as mic-lost', async () => {
    const h = await start();
    await h.readyNow();
    h.stream.track.fire('mute');
    expect(h.ofType('error')).toEqual([
      expect.objectContaining({ code: 'mic-lost', recoverable: true })
    ]);
    h.session.stop();
  });

  test('a recovered microphone resumes on unmute', async () => {
    const h = await start();
    await h.readyNow();
    h.stream.track.fire('mute'); // the track stays `live`
    h.session.setMuted(false);
    expect(h.ofType('error')).toHaveLength(1);
    detectSpeech(h);
    expect(h.adapter.last().beginTurn).toHaveBeenCalledTimes(1);
    h.session.stop();
  });

  test('listeners are removed when the session stops', async () => {
    const h = await start();
    await h.readyNow();
    expect(h.stream.track.listenerCount()).toBeGreaterThan(0);
    h.session.stop();
    expect(h.stream.track.listenerCount()).toBe(0);
    setHidden(true);
    expect(h.ofType('error')).toHaveLength(0);
  });
});
