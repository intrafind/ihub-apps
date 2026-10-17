/**
 * Realtime speech-to-text bridge, conversation mode (voice mode, issue #2868).
 *
 * A conversation is many user turns over one socket: `start{conversation:true}`,
 * PCM only while the user speaks, `commit` per turn, `keepalive` while the app
 * thinks or speaks, one `final{turn:n}` back per commit. These tests drive the
 * bridge with fake sockets for the three streaming providers (vLLM, Mistral,
 * Gemini Live) and with a faked `transcribe()` for a batch provider. The
 * one-utterance protocol is covered by realtimeTranscription.test.js and must
 * stay as it is.
 */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import {
  bridgeConnection,
  ConnectionLimiter,
  CONVERSATION_TIMINGS,
  getConversationGate
} from '../websocket/realtimeTranscription.js';
import { getTranscriptionProvider } from '../transcription/index.js';
import configCache from '../configCache.js';

const CONFIG_KEYS = ['config/platform.json', 'config/models.json', 'config/features.json'];

afterAll(() => {
  // setCacheEntry schedules a TTL refresh timer; cancel it so it cannot fire
  // after Jest tears the environment down.
  for (const key of CONFIG_KEYS) {
    const timer = configCache.refreshTimers?.get(key);
    if (timer) clearTimeout(timer);
    configCache.refreshTimers?.delete(key);
  }
});

/** Minimal ws-compatible fake: the socket surface the bridge touches. */
class FakeWs extends EventEmitter {
  constructor(readyState = WebSocket.OPEN) {
    super();
    this.readyState = readyState;
    this.sent = [];
    this.bufferedAmount = 0;
    this.pings = 0;
    this.terminated = false;
  }
  send(data) {
    this.sent.push(typeof data === 'string' ? data : Buffer.from(data).toString());
  }
  close() {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate() {
    this.terminated = true;
    this.close();
  }
  ping() {
    this.pings += 1;
  }
  pause() {}
  resume() {}
  frames() {
    return this.sent
      .map(s => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  framesOfType(type) {
    return this.frames().filter(m => m.type === type);
  }
}

const user = {
  id: 'u1',
  name: 'u1',
  permissions: { models: new Set(['vllm', 'mistral', 'gemini-live', 'whisper']) }
};

const vllmModel = {
  id: 'vllm',
  modelId: 'fake-model',
  url: 'ws://fake-upstream:9/v1/realtime',
  provider: 'vllm-realtime',
  modelType: 'transcription',
  enabled: true
};
const mistralModel = {
  id: 'mistral',
  modelId: 'voxtral-mini-transcribe-realtime-2602',
  url: 'wss://api.mistral.ai/v1/audio/transcriptions/realtime',
  provider: 'mistral',
  modelType: 'transcription',
  apiKey: 'mistral-test-key',
  enabled: true
};
const geminiModel = {
  id: 'gemini-live',
  modelId: 'gemini-3.5-transcribe-live',
  url: 'wss://generativelanguage.example/ws',
  provider: 'google-live',
  modelType: 'transcription',
  apiKey: 'google-test-key',
  enabled: true
};
const batchModel = {
  id: 'whisper',
  modelId: 'whisper-1',
  url: 'https://api.example.com/v1',
  provider: 'openai',
  modelType: 'transcription',
  enabled: true
};

const BASE_PLATFORM = {
  jwt: { algorithm: 'HS256' },
  auth: { jwtSecret: 'realtime-stt-test-secret' }
};

/** Platform config: voice mode on by default, `realtime` limits optional. */
const usePlatform = ({ voiceMode = { enabled: true }, realtime } = {}) =>
  configCache.setCacheEntry('config/platform.json', {
    ...BASE_PLATFORM,
    speech: { voiceMode, ...(realtime ? { realtime } : {}) }
  });
const useFeatures = features => configCache.setCacheEntry('config/features.json', features);
const useModel = model => configCache.setCacheEntry('config/models.json', [model]);

const tick = (ms = 0) => jest.advanceTimersByTimeAsync(ms);
const sendJson = (ws, obj) => ws.emit('message', JSON.stringify(obj), false);
const sendAudio = (ws, bytes = 4, fill = 1) => ws.emit('message', Buffer.alloc(bytes, fill), true);
const upstreamSend = (ws, obj) => ws.emit('message', JSON.stringify(obj));

const START = { type: 'start', conversation: true };

beforeEach(() => {
  jest.useFakeTimers();
  usePlatform();
  useFeatures({ voiceMode: true });
});

afterEach(() => {
  jest.useRealTimers();
});

/** A bridge connection with fake sockets; every upstream it dials is collected. */
function setup(model, { autoPong = true } = {}) {
  useModel(model);
  const client = new FakeWs();
  // A browser answers the keepalive ping by itself (RFC 6455); without this the
  // dead-peer check, not the idle timer, would end the long-running tests.
  if (autoPong) {
    client.ping = () => {
      client.pings += 1;
      client.emit('pong');
    };
  }
  const upstreams = [];
  const limiter = new ConnectionLimiter({ maxTotal: 5, maxPerUser: 5 });
  limiter.tryAcquire(user.id);
  const createUpstream = jest.fn(() => {
    const ws = new FakeWs(WebSocket.CONNECTING);
    upstreams.push(ws);
    return ws;
  });
  bridgeConnection(client, user, limiter, { createUpstream });
  return { client, upstreams, limiter, createUpstream };
}

const startSession = async (client, modelId, extra = {}) => {
  sendJson(client, { ...START, modelId, ...extra });
  await tick();
};

/** Open an upstream socket and send the frame that says its session exists. */
const openSession = async (ws, readyMessage) => {
  ws.readyState = WebSocket.OPEN;
  ws.emit('open');
  upstreamSend(ws, readyMessage);
  await tick();
};
const VLLM_READY = { type: 'session.created' };
const MISTRAL_READY = { type: 'session.created', session: { request_id: 'r1' } };
const GEMINI_READY = { setupComplete: {} };

const finals = client => client.framesOfType('final').map(f => ({ turn: f.turn, text: f.text }));
const countOf = (ws, predicate) => ws.frames().filter(predicate).length;
const isCommit = f => f.type === 'input_audio_buffer.commit';
const isAppend = f => f.type === 'input_audio_buffer.append';

describe('conversation mode: frames that are not a control message', () => {
  test.each([['null'], ['[]'], ['1'], ['"start"'], ['true']])(
    'the text frame %s is ignored: no crash, the session goes on',
    async frame => {
      const { client, upstreams } = setup(vllmModel);
      await startSession(client, 'vllm');
      await openSession(upstreams[0], VLLM_READY);

      expect(() => client.emit('message', frame, false)).not.toThrow();
      sendAudio(client);
      sendJson(client, { type: 'commit' });
      await tick();

      expect(client.framesOfType('error')).toHaveLength(0);
      expect(client.readyState).toBe(WebSocket.OPEN);
      expect(countOf(upstreams[0], isAppend)).toBe(1);
    }
  );

  test('a control frame over 8 KB is not parsed', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    sendJson(client, { type: 'commit', padding: 'x'.repeat(9_000) });
    await tick();

    // Had it been taken for a commit, the turn would have an (empty) final.
    expect(finals(client)).toEqual([]);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  test('a malformed frame from the upstream is ignored too', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    expect(() => upstreams[0].emit('message', 'null')).not.toThrow();
    expect(client.readyState).toBe(WebSocket.OPEN);
  });
});

describe('conversation mode: who may start one', () => {
  test('the feature flag is off by default: an error frame, a close, nothing dialled', async () => {
    useFeatures({});
    const { client, createUpstream, limiter } = setup(vllmModel);

    await startSession(client, 'vllm');

    const [error] = client.framesOfType('error');
    expect(error.code).toBe('feature-disabled');
    expect(error.message).toBeTruthy();
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(createUpstream).not.toHaveBeenCalled();
    expect(limiter.total).toBe(0);
  });

  test('the feature flag switched off explicitly is refused too', async () => {
    useFeatures({ voiceMode: false });
    const { client, createUpstream } = setup(vllmModel);

    await startSession(client, 'vllm');

    expect(client.framesOfType('error')[0].code).toBe('feature-disabled');
    expect(createUpstream).not.toHaveBeenCalled();
  });

  test('voice mode switched off on the platform is refused with its own code', async () => {
    usePlatform({ voiceMode: { enabled: false } });
    const { client, createUpstream, limiter } = setup(vllmModel);

    await startSession(client, 'vllm');

    expect(client.framesOfType('error')[0].code).toBe('voice-mode-disabled');
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(createUpstream).not.toHaveBeenCalled();
    expect(limiter.total).toBe(0);
  });

  test('a platform that never configured voice mode is refused', async () => {
    configCache.setCacheEntry('config/platform.json', BASE_PLATFORM);
    const { client } = setup(vllmModel);

    await startSession(client, 'vllm');

    expect(client.framesOfType('error')[0].code).toBe('voice-mode-disabled');
  });

  test('the flag and the platform switch do not affect a one-utterance session', async () => {
    useFeatures({});
    usePlatform({ voiceMode: { enabled: false } });
    const { client, createUpstream } = setup(vllmModel);

    sendJson(client, { type: 'start', modelId: 'vllm' });
    await tick();

    expect(client.framesOfType('error')).toHaveLength(0);
    expect(createUpstream).toHaveBeenCalledTimes(1);
  });

  test('getConversationGate reports the session cap of voice mode in seconds', () => {
    usePlatform({ voiceMode: { enabled: true, maxSessionMinutes: 5 } });
    expect(getConversationGate()).toEqual({ ok: true, maxSessionSeconds: 300 });
    usePlatform({ voiceMode: { enabled: true } });
    expect(getConversationGate()).toEqual({ ok: true, maxSessionSeconds: 30 * 60 });
  });

  test('only the first start decides: a later one cannot turn a session into a conversation', async () => {
    const { client, upstreams } = setup(vllmModel);
    sendJson(client, { type: 'start', modelId: 'vllm' });
    await tick();
    sendJson(client, { ...START, modelId: 'vllm' });
    await openSession(upstreams[0], VLLM_READY);

    expect(client.framesOfType('ready')[0].conversation).toBeUndefined();
    sendAudio(client);
    sendJson(client, { type: 'commit' });
    await tick(5_000);
    expect(client.framesOfType('final')).toHaveLength(0);
  });
});

describe('conversation mode: the one-utterance protocol is unchanged', () => {
  test('ready carries no conversation field, commit and keepalive are ignored', async () => {
    const { client, upstreams } = setup(vllmModel);
    sendJson(client, { type: 'start', modelId: 'vllm' });
    sendAudio(client);
    await tick();
    await openSession(upstreams[0], VLLM_READY);

    expect(client.framesOfType('ready')[0]).toEqual({
      type: 'ready',
      mode: 'stream',
      knowledgeSources: ['audio']
    });
    const commitsBefore = countOf(upstreams[0], isCommit);

    sendJson(client, { type: 'commit' });
    sendJson(client, { type: 'keepalive' });
    await tick();

    expect(countOf(upstreams[0], isCommit)).toBe(commitsBefore);
    expect(client.framesOfType('error')).toHaveLength(0);
    expect(client.framesOfType('final')).toHaveLength(0);
  });

  test('a keepalive does not keep a one-utterance session open', async () => {
    const { client, upstreams, limiter } = setup(vllmModel);
    sendJson(client, { type: 'start', modelId: 'vllm' });
    sendAudio(client);
    await tick();
    await openSession(upstreams[0], VLLM_READY);

    await tick(50_000);
    sendJson(client, { type: 'keepalive' });
    await tick(11_000);

    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
  });

  test('a one-utterance session still closes without audio after the grace window', async () => {
    const { client, limiter } = setup(vllmModel);
    sendJson(client, { type: 'start', modelId: 'vllm' });
    await tick(16_000);

    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
  });
});

describe('conversation mode: streaming provider, vLLM', () => {
  test('ready announces the conversation, once, after the upstream session exists', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    expect(client.framesOfType('ready')).toHaveLength(0);

    await openSession(upstreams[0], VLLM_READY);

    expect(client.framesOfType('ready')).toEqual([
      { type: 'ready', mode: 'stream', knowledgeSources: ['audio'], conversation: true }
    ]);
    // The session was armed for the first turn by the provider's ready frames.
    expect(upstreams[0].framesOfType('session.update')[0].model).toBe('fake-model');
    expect(countOf(upstreams[0], isCommit)).toBe(1);
  });

  test('several commits over one socket: finals 1, 2, 3 in order, one upstream session', async () => {
    const { client, upstreams, createUpstream, limiter } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    for (const [turn, spoken] of [
      [1, 'hello there'],
      [2, 'what is the weather'],
      [3, 'thank you']
    ]) {
      sendAudio(client, 8, turn);
      await tick();
      upstreamSend(upstreams[0], { type: 'transcription.delta', delta: spoken.slice(0, 5) });
      sendJson(client, { type: 'commit' });
      await tick();
      // The turn ends on the upstream: a commit with `final`, answered by `done`.
      const commits = upstreams[0].frames().filter(isCommit);
      expect(commits[commits.length - 1].final).toBe(true);
      upstreamSend(upstreams[0], { type: 'transcription.done', text: spoken });
      await tick(250);
      expect(finals(client)).toHaveLength(turn);
    }

    expect(finals(client)).toEqual([
      { turn: 1, text: 'hello there' },
      { turn: 2, text: 'what is the weather' },
      { turn: 3, text: 'thank you' }
    ]);
    // No `done`: the session goes on. One upstream socket served every turn.
    expect(client.framesOfType('done')).toHaveLength(0);
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(createUpstream).toHaveBeenCalledTimes(1);
    expect(upstreams[0].readyState).toBe(WebSocket.OPEN);
    expect(limiter.total).toBe(1);
  });

  test('every turn after the first re-arms the upstream before its audio', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    sendAudio(client);
    sendJson(client, { type: 'commit' });
    await tick();
    upstreamSend(upstreams[0], { type: 'transcription.done', text: 'one' });
    await tick(250);
    const framesAfterTurn1 = upstreams[0].frames().length;

    // Nothing is sent while the user does not speak.
    await tick(30_000);
    expect(upstreams[0].frames()).toHaveLength(framesAfterTurn1);

    sendAudio(client);
    await tick();
    const next = upstreams[0].frames().slice(framesAfterTurn1);
    expect(next.map(f => f.type)).toEqual([
      'input_audio_buffer.commit',
      'input_audio_buffer.append'
    ]);
    expect(next[0].final).toBeUndefined(); // a plain commit starts the next generation
  });

  test('interim deltas flow for the current turn and name it', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    sendAudio(client);
    await tick();
    upstreamSend(upstreams[0], { type: 'transcription.delta', delta: 'hel' });
    await tick();
    sendJson(client, { type: 'commit' });
    upstreamSend(upstreams[0], { type: 'transcription.done', text: 'hello' });
    await tick(250);
    sendAudio(client);
    await tick();
    upstreamSend(upstreams[0], { type: 'transcription.delta', delta: 'wor' });
    await tick();

    expect(client.framesOfType('delta')).toEqual([
      { type: 'delta', text: 'hel', turn: 1 },
      { type: 'delta', text: 'wor', turn: 2 }
    ]);
  });

  test('text that arrives after the commit still belongs to the turn that was committed', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    sendAudio(client);
    sendJson(client, { type: 'commit' });
    await tick();
    upstreamSend(upstreams[0], { type: 'transcription.delta', delta: 'late' });
    await tick();

    expect(client.framesOfType('delta')).toEqual([{ type: 'delta', text: 'late', turn: 1 }]);
  });

  test('a commit after stop starts no new turn', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    sendAudio(client);
    sendJson(client, { type: 'commit' });
    sendJson(client, { type: 'stop' });
    sendJson(client, { type: 'commit' });
    upstreamSend(upstreams[0], { type: 'transcription.done', text: 'said' });
    await tick(250);

    expect(finals(client)).toEqual([{ turn: 1, text: 'said' }]);
  });

  test('a commit with no audio since the last one answers at once with an empty final', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);
    const framesBefore = upstreams[0].frames().length;

    sendJson(client, { type: 'commit' });
    await tick();

    expect(finals(client)).toEqual([{ turn: 1, text: '' }]);
    // Nothing was said, so nothing goes upstream either.
    expect(upstreams[0].frames()).toHaveLength(framesBefore);

    sendAudio(client);
    sendJson(client, { type: 'commit' });
    await tick();
    upstreamSend(upstreams[0], { type: 'transcription.done', text: 'later' });
    await tick(250);
    sendJson(client, { type: 'commit' });
    await tick();
    expect(finals(client)).toEqual([
      { turn: 1, text: '' },
      { turn: 2, text: 'later' },
      { turn: 3, text: '' }
    ]);
  });

  test('an empty commit behind a turn that is still settling does not overtake it', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    sendAudio(client);
    sendJson(client, { type: 'commit' }); // turn 1, answered later
    sendJson(client, { type: 'commit' }); // turn 2, nothing said
    await tick(100);
    expect(client.framesOfType('final')).toHaveLength(0);

    upstreamSend(upstreams[0], { type: 'transcription.done', text: 'first' });
    await tick(250);
    expect(finals(client)).toEqual([
      { turn: 1, text: 'first' },
      { turn: 2, text: '' }
    ]);
  });

  test('the next turn’s audio is held until the previous turn settled', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    sendAudio(client, 4, 1);
    sendJson(client, { type: 'commit' });
    await tick();
    const appendsBefore = countOf(upstreams[0], isAppend);

    sendAudio(client, 4, 2); // the user speaks again before the final of turn 1
    await tick(100);
    expect(countOf(upstreams[0], isAppend)).toBe(appendsBefore);

    upstreamSend(upstreams[0], { type: 'transcription.done', text: 'one' });
    await tick(250);
    expect(finals(client)).toEqual([{ turn: 1, text: 'one' }]);
    // Now it goes out, after the re-arming commit.
    const tail = upstreams[0].frames().slice(-2);
    expect(tail.map(f => f.type)).toEqual([
      'input_audio_buffer.commit',
      'input_audio_buffer.append'
    ]);
  });

  test('a commit whose upstream never answers ends at the wait limit and gets a fresh session', async () => {
    const { client, upstreams, createUpstream } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    sendAudio(client);
    await tick();
    upstreamSend(upstreams[0], { type: 'transcription.delta', delta: 'partial' });
    sendJson(client, { type: 'commit' });
    await tick(CONVERSATION_TIMINGS.turnExplicitWaitMs - 100);
    expect(client.framesOfType('final')).toHaveLength(0);
    await tick(200);
    expect(finals(client)).toEqual([{ turn: 1, text: 'partial' }]);

    // What the first session is doing is unknown, so the next turn gets a new one.
    await tick(1_600);
    expect(createUpstream).toHaveBeenCalledTimes(2);
    sendAudio(client);
    await tick();
    await openSession(upstreams[1], VLLM_READY);
    expect(countOf(upstreams[1], isAppend)).toBe(1);
    expect(client.framesOfType('error')).toHaveLength(0);
    expect(client.framesOfType('ready')).toHaveLength(1);
  });

  test('stop after committed turns: their finals, then done and close', async () => {
    const { client, upstreams, limiter } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    sendAudio(client);
    sendJson(client, { type: 'commit' });
    sendAudio(client); // a turn the client never ended
    sendJson(client, { type: 'stop' });
    await tick(100);
    expect(client.framesOfType('done')).toHaveLength(0);

    upstreamSend(upstreams[0], { type: 'transcription.done', text: 'said' });
    await tick(250);

    expect(finals(client)).toEqual([{ turn: 1, text: 'said' }]);
    expect(client.framesOfType('done')).toHaveLength(1);
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(upstreams[0].readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
  });

  test('stop with nothing in flight ends at once, without flushing the upstream', async () => {
    const { client, upstreams, limiter } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);
    sendAudio(client);
    await tick();

    sendJson(client, { type: 'stop' });
    await tick();

    expect(client.framesOfType('done')).toHaveLength(1);
    expect(client.framesOfType('final')).toHaveLength(0);
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
  });

  test('turns and audio sent before the upstream is ready are not lost', async () => {
    const { client, upstreams } = setup(vllmModel);
    sendJson(client, { ...START, modelId: 'vllm' });
    sendAudio(client, 4, 1);
    sendJson(client, { type: 'commit' });
    sendAudio(client, 4, 2);
    sendJson(client, { type: 'commit' });
    await tick();
    await openSession(upstreams[0], VLLM_READY);

    // Turn 1 went out and is waiting; turn 2 waits behind it.
    expect(countOf(upstreams[0], isAppend)).toBe(1);
    upstreamSend(upstreams[0], { type: 'transcription.done', text: 'one' });
    await tick(250);
    expect(countOf(upstreams[0], isAppend)).toBe(2);
    upstreamSend(upstreams[0], { type: 'transcription.done', text: 'two' });
    await tick(250);
    expect(finals(client)).toEqual([
      { turn: 1, text: 'one' },
      { turn: 2, text: 'two' }
    ]);
  });

  test('a backlog of turns that cannot be worked off ends the session', async () => {
    const { client, limiter } = setup(vllmModel);
    sendJson(client, { ...START, modelId: 'vllm' });
    await tick();
    // The upstream never becomes ready, so no turn can start.
    for (let turn = 1; turn <= 40; turn += 1) {
      sendAudio(client);
      sendJson(client, { type: 'commit' });
    }
    await tick();

    expect(client.framesOfType('error')[0].code).toBe('turn-backlog');
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
  });

  test('an upstream that closes in the middle of a conversation is reported, even with a normal code', async () => {
    const { client, upstreams, limiter } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    upstreams[0].emit('close', 1000, Buffer.from(''));
    await tick();

    const [error] = client.framesOfType('error');
    expect(error.code).toBe('upstream-closed');
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
  });

  test('an upstream that closes normally after stop, with a turn still waiting, is reported', async () => {
    const { client, upstreams, limiter } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    sendAudio(client);
    sendJson(client, { type: 'commit' });
    sendJson(client, { type: 'stop' });
    upstreams[0].emit('close', 1000, Buffer.from(''));
    await tick();

    // The turn will not get its text any more: say so instead of a bare close.
    expect(client.framesOfType('error')[0].code).toBe('upstream-closed');
    expect(limiter.total).toBe(0);
  });

  test('an upstream error frame ends the session with an error', async () => {
    const { client, upstreams, limiter } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    upstreamSend(upstreams[0], { type: 'error', error: 'boom' });
    await tick();

    expect(client.framesOfType('error')[0].code).toBe('upstream-error');
    expect(limiter.total).toBe(0);
  });

  test('a conversation is never a stored chat turn: chat fields in start are ignored', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm', { chatId: 'c1', appId: 'a1', source: 'file' });
    await openSession(upstreams[0], VLLM_READY);

    // Microphone audio is never paced like a file, and nothing fails on a chat.
    sendAudio(client);
    await tick();
    expect(countOf(upstreams[0], isAppend)).toBe(1);
    expect(client.framesOfType('error')).toHaveLength(0);
    expect(client.framesOfType('ready')[0].realtimeFactor).toBeUndefined();
  });
});

describe('conversation mode: streaming provider, Mistral realtime', () => {
  test('commit flushes the upstream without ending the stream; the turn settles on quiet', async () => {
    const { client, upstreams } = setup(mistralModel);
    await startSession(client, 'mistral');
    await openSession(upstreams[0], MISTRAL_READY);

    sendAudio(client);
    await tick();
    upstreamSend(upstreams[0], { type: 'transcription.text.delta', text: 'Hallo ' });
    sendJson(client, { type: 'commit' });
    await tick();
    expect(upstreams[0].framesOfType('input_audio.flush')).toHaveLength(1);
    expect(upstreams[0].framesOfType('input_audio.end')).toHaveLength(0);

    upstreamSend(upstreams[0], { type: 'transcription.text.delta', text: 'Welt' });
    await tick(CONVERSATION_TIMINGS.turnQuietMs - 100);
    expect(client.framesOfType('final')).toHaveLength(0);
    // Another delta moves the end of the window.
    upstreamSend(upstreams[0], { type: 'transcription.text.delta', text: '!' });
    await tick(CONVERSATION_TIMINGS.turnQuietMs - 100);
    expect(client.framesOfType('final')).toHaveLength(0);
    await tick(200);

    expect(finals(client)).toEqual([{ turn: 1, text: 'Hallo Welt!' }]);
  });

  test('late text of an ended turn does not leak into the next one', async () => {
    const { client, upstreams } = setup(mistralModel);
    await startSession(client, 'mistral');
    await openSession(upstreams[0], MISTRAL_READY);

    sendAudio(client);
    await tick();
    upstreamSend(upstreams[0], { type: 'transcription.text.delta', text: 'first' });
    sendJson(client, { type: 'commit' });
    await tick(CONVERSATION_TIMINGS.turnQuietMs + 100);
    expect(finals(client)).toEqual([{ turn: 1, text: 'first' }]);

    // The upstream answers late. Nothing of turn 2 has been sent, so this is
    // turn 1's: not shown, not kept.
    upstreamSend(upstreams[0], { type: 'transcription.text.delta', text: ' LATE' });
    await tick();
    expect(client.framesOfType('delta').map(f => f.text)).toEqual(['first']);

    sendAudio(client);
    await tick();
    upstreamSend(upstreams[0], { type: 'transcription.text.delta', text: 'second' });
    sendJson(client, { type: 'commit' });
    await tick(CONVERSATION_TIMINGS.turnQuietMs + 100);

    expect(finals(client)).toEqual([
      { turn: 1, text: 'first' },
      { turn: 2, text: 'second' }
    ]);
    expect(client.framesOfType('delta').map(f => [f.turn, f.text])).toEqual([
      [1, 'first'],
      [2, 'second']
    ]);
  });

  test('text that arrives while a turn settles is that turn’s, not the next turn’s', async () => {
    const { client, upstreams } = setup(mistralModel);
    await startSession(client, 'mistral');
    await openSession(upstreams[0], MISTRAL_READY);

    sendAudio(client, 4, 1);
    await tick();
    upstreamSend(upstreams[0], { type: 'transcription.text.delta', text: 'one' });
    sendJson(client, { type: 'commit' });
    await tick(50);

    // The user speaks again at once. Their audio waits, so the text that is
    // still coming for turn 1 cannot be mistaken for turn 2.
    sendAudio(client, 4, 2);
    await tick(50);
    expect(countOf(upstreams[0], f => f.type === 'input_audio.append')).toBe(1);
    upstreamSend(upstreams[0], { type: 'transcription.text.delta', text: ' and more' });
    await tick(CONVERSATION_TIMINGS.turnQuietMs + 100);

    expect(finals(client)).toEqual([{ turn: 1, text: 'one and more' }]);
    // Turn 1 is final: the held audio goes out now.
    expect(countOf(upstreams[0], f => f.type === 'input_audio.append')).toBe(2);

    upstreamSend(upstreams[0], { type: 'transcription.text.delta', text: 'two' });
    sendJson(client, { type: 'commit' });
    await tick(CONVERSATION_TIMINGS.turnQuietMs + 100);
    expect(finals(client)[1]).toEqual({ turn: 2, text: 'two' });
  });

  test('a turn with audio and no text waits a little longer, then answers empty', async () => {
    const { client, upstreams } = setup(mistralModel);
    await startSession(client, 'mistral');
    await openSession(upstreams[0], MISTRAL_READY);

    sendAudio(client); // a cough
    sendJson(client, { type: 'commit' });
    await tick(CONVERSATION_TIMINGS.turnEmptyWaitMs - 100);
    expect(client.framesOfType('final')).toHaveLength(0);
    await tick(200);

    expect(finals(client)).toEqual([{ turn: 1, text: '' }]);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  test('an upstream that never stops talking is cut at the hard limit', async () => {
    const { client, upstreams } = setup(mistralModel);
    await startSession(client, 'mistral');
    await openSession(upstreams[0], MISTRAL_READY);

    sendAudio(client);
    sendJson(client, { type: 'commit' });
    for (let ms = 0; ms < CONVERSATION_TIMINGS.turnMaxWaitMs + 500; ms += 500) {
      upstreamSend(upstreams[0], { type: 'transcription.text.delta', text: 'x' });
      await tick(500);
    }

    const [first] = finals(client);
    expect(first.turn).toBe(1);
    expect(first.text.length).toBeGreaterThan(0);
    // Whatever came after the limit was dropped: the turn had ended.
    expect(first.text.length).toBeLessThan(CONVERSATION_TIMINGS.turnMaxWaitMs / 500 + 2);
    expect(finals(client)).toHaveLength(1);
  });

  test('a provider without commit frames is safe: nothing is sent, the turn settles on quiet', async () => {
    const provider = getTranscriptionProvider('mistral');
    const { commitFrames } = provider;
    delete provider.commitFrames;
    try {
      const { client, upstreams } = setup(mistralModel);
      await startSession(client, 'mistral');
      await openSession(upstreams[0], MISTRAL_READY);
      const framesBefore = upstreams[0].frames().length;

      sendAudio(client);
      await tick();
      upstreamSend(upstreams[0], { type: 'transcription.text.delta', text: 'ok' });
      sendJson(client, { type: 'commit' });
      await tick(CONVERSATION_TIMINGS.turnQuietMs + 100);

      expect(upstreams[0].frames()).toHaveLength(framesBefore + 1); // only the audio
      expect(finals(client)).toEqual([{ turn: 1, text: 'ok' }]);
      expect(client.framesOfType('error')).toHaveLength(0);
    } finally {
      provider.commitFrames = commitFrames;
    }
  });
});

describe('conversation mode: streaming provider, Gemini Live', () => {
  const segment = text => ({ serverContent: { inputTranscription: { text } } });
  const interim = text => ({ serverContent: { interimInputTranscription: { text } } });
  const streamEnds = ws => ws.frames().filter(m => m.realtimeInput?.audioStreamEnd).length;

  test('commit sends the end-of-activity signal; the turn is the segments that follow', async () => {
    const { client, upstreams } = setup(geminiModel);
    await startSession(client, 'gemini-live');
    await openSession(upstreams[0], GEMINI_READY);

    sendAudio(client);
    await tick();
    upstreamSend(upstreams[0], interim('How is'));
    upstreamSend(upstreams[0], segment('How is the'));
    sendJson(client, { type: 'commit' });
    await tick();
    expect(streamEnds(upstreams[0])).toBe(1);

    upstreamSend(upstreams[0], segment('weather today'));
    await tick(CONVERSATION_TIMINGS.turnFinalQuietMs + 50);

    // Segments are not turns: one final for the commit, text in order.
    expect(finals(client)).toEqual([{ turn: 1, text: 'How is the weather today' }]);
    expect(client.framesOfType('delta').map(f => f.text)).toEqual(['How is']);
  });

  test('the same session takes the next turn without re-arming', async () => {
    const { client, upstreams, createUpstream } = setup(geminiModel);
    await startSession(client, 'gemini-live');
    await openSession(upstreams[0], GEMINI_READY);

    sendAudio(client);
    sendJson(client, { type: 'commit' });
    await tick();
    upstreamSend(upstreams[0], segment('one'));
    await tick(300);
    const framesAfterTurn1 = upstreams[0].frames().length;

    sendAudio(client);
    await tick();
    expect(upstreams[0].frames()).toHaveLength(framesAfterTurn1 + 1);
    expect(upstreams[0].frames().pop().realtimeInput.audio).toBeTruthy();
    sendJson(client, { type: 'commit' });
    await tick();
    upstreamSend(upstreams[0], segment('two'));
    await tick(300);

    expect(finals(client)).toEqual([
      { turn: 1, text: 'one' },
      { turn: 2, text: 'two' }
    ]);
    expect(streamEnds(upstreams[0])).toBe(2);
    expect(createUpstream).toHaveBeenCalledTimes(1);
  });

  test('a session at its lifetime cap is replaced between turns, not at the next words', async () => {
    const { client, upstreams, createUpstream } = setup({
      ...geminiModel,
      config: { maxSessionSeconds: 2 }
    });
    await startSession(client, 'gemini-live');
    await openSession(upstreams[0], GEMINI_READY);

    sendAudio(client);
    await tick(2_100); // the session is now older than its cap
    sendJson(client, { type: 'commit' });
    upstreamSend(upstreams[0], segment('one'));
    await tick(CONVERSATION_TIMINGS.turnFinalQuietMs + 50);
    expect(finals(client)).toEqual([{ turn: 1, text: 'one' }]);

    // The user is listening: the fresh session is dialled now.
    await tick(1_700);
    expect(createUpstream).toHaveBeenCalledTimes(2);
    await openSession(upstreams[1], GEMINI_READY);

    sendAudio(client);
    await tick();
    const audioFrames = ws => ws.frames().filter(m => m.realtimeInput?.audio).length;
    expect(audioFrames(upstreams[0])).toBe(1);
    expect(audioFrames(upstreams[1])).toBe(1);
    expect(client.framesOfType('ready')).toHaveLength(1);
    expect(client.framesOfType('error')).toHaveLength(0);
  });

  test('stop ends the session with done', async () => {
    const { client, upstreams } = setup(geminiModel);
    await startSession(client, 'gemini-live');
    await openSession(upstreams[0], GEMINI_READY);

    sendJson(client, { type: 'stop' });
    await tick();

    expect(client.framesOfType('done')).toHaveLength(1);
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(upstreams[0].readyState).toBe(WebSocket.CLOSED);
  });
});

describe('conversation mode: timeouts and limits', () => {
  test('a long wait for the first words does not close the session: keepalives are enough', async () => {
    const { client, upstreams, limiter } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    // Far beyond the 15 s no-audio grace and the 60 s idle timeout of a
    // one-utterance session; the client sends a keepalive every 20 s.
    for (let i = 0; i < 15; i += 1) {
      await tick(20_000);
      sendJson(client, { type: 'keepalive' });
    }

    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(limiter.total).toBe(1);
    expect(client.framesOfType('error')).toHaveLength(0);
  });

  test('keepalives alone do not hold a session open for ever: no-speech ends it', async () => {
    const { client, upstreams, limiter } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    // 31 keepalives, 20 s apart: past the ten minutes without audio or commit.
    for (let i = 0; i < 31 && client.readyState === WebSocket.OPEN; i += 1) {
      await tick(20_000);
      sendJson(client, { type: 'keepalive' });
    }

    expect(client.framesOfType('error')[0].code).toBe('no-speech');
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(upstreams[0].readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
  });

  test('a commit starts the no-speech window over', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    for (let i = 0; i < 27; i += 1) {
      await tick(20_000);
      sendJson(client, { type: 'keepalive' });
    }
    sendAudio(client);
    sendJson(client, { type: 'commit' }); // nine minutes in
    for (let i = 0; i < 27; i += 1) {
      await tick(20_000);
      sendJson(client, { type: 'keepalive' });
    }

    expect(client.framesOfType('error')).toHaveLength(0);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  test('without keepalive, audio or commit the session closes after the idle timeout', async () => {
    const { client, upstreams, limiter } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    await tick(CONVERSATION_TIMINGS.idleMs - 1_000);
    expect(client.readyState).toBe(WebSocket.OPEN);
    await tick(2_000);

    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(upstreams[0].readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
  });

  test('audio, a commit and a keepalive each reset the idle timeout', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    await tick(50_000);
    sendAudio(client);
    await tick(50_000);
    sendJson(client, { type: 'commit' });
    await tick(50_000);
    sendJson(client, { type: 'keepalive' });
    await tick(50_000);

    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  test('what the upstream says does not keep an abandoned conversation open', async () => {
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    for (let i = 0; i < 3; i += 1) {
      await tick(25_000);
      upstreamSend(upstreams[0], { type: 'session.updated' });
    }

    expect(client.readyState).toBe(WebSocket.CLOSED);
  });

  test('the idle timeout applies to a batch conversation too', async () => {
    useModel(batchModel);
    const { client } = setup(batchModel);
    await startSession(client, 'whisper');
    expect(client.framesOfType('ready')).toHaveLength(1);

    await tick(50_000);
    sendJson(client, { type: 'keepalive' });
    await tick(50_000);
    expect(client.readyState).toBe(WebSocket.OPEN);
    await tick(11_000);
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });

  test('the session cap is voiceMode.maxSessionMinutes', async () => {
    usePlatform({ voiceMode: { enabled: true, maxSessionMinutes: 1 } });
    const { client, upstreams, limiter } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    await tick(30_000);
    sendJson(client, { type: 'keepalive' });
    await tick(29_000);
    expect(client.readyState).toBe(WebSocket.OPEN);
    await tick(2_000);

    const [error] = client.framesOfType('error');
    expect(error.code).toBe('session-limit');
    expect(limiter.total).toBe(0);
  });

  test('the session cap never exceeds the existing hard cap', async () => {
    usePlatform({
      voiceMode: { enabled: true, maxSessionMinutes: 30 },
      realtime: { maxSessionSeconds: 30 }
    });
    const { client, upstreams } = setup(vllmModel);
    await startSession(client, 'vllm');
    await openSession(upstreams[0], VLLM_READY);

    await tick(29_000);
    expect(client.readyState).toBe(WebSocket.OPEN);
    await tick(2_000);

    expect(client.framesOfType('error')[0].code).toBe('session-limit');
  });

  test('the cap counts from the connection, not from the start frame', async () => {
    usePlatform({ voiceMode: { enabled: true, maxSessionMinutes: 1 } });
    const { client } = setup(vllmModel);
    await tick(10_000); // connected, `start` comes late
    // Ten seconds of fake time let the config cache's refresh timer run, which
    // reloads the configs from disk: put the test's models back before `start`.
    useModel(vllmModel);
    usePlatform({ voiceMode: { enabled: true, maxSessionMinutes: 1 } });
    useFeatures({ voiceMode: true });
    await startSession(client, 'vllm');

    await tick(49_000);
    sendJson(client, { type: 'keepalive' });
    expect(client.readyState).toBe(WebSocket.OPEN);
    await tick(2_000);

    expect(client.framesOfType('error')[0].code).toBe('session-limit');
  });

  test('a conversation session keeps the keepalive ping of the socket', async () => {
    const { client } = setup(vllmModel, { autoPong: false });
    await startSession(client, 'vllm');
    sendJson(client, { type: 'keepalive' });

    await tick(25_000);
    expect(client.pings).toBe(1);
    sendJson(client, { type: 'keepalive' });
    await tick(25_000);

    // A browser that never answers the ping is a dead peer, conversation or not.
    expect(client.terminated).toBe(true);
  });
});

describe('conversation mode: batch provider', () => {
  const provider = getTranscriptionProvider('openai');
  let transcribe;

  beforeEach(() => {
    useModel(batchModel);
    transcribe = jest.spyOn(provider, 'transcribe');
  });

  afterEach(() => {
    transcribe.mockRestore();
  });

  const PCM = 4_000; // above the 100 ms minimum a batch provider is asked to transcribe
  const turnAudio = (client, fill, bytes = PCM) => sendAudio(client, bytes, fill);

  test('ready names the conversation and no socket is dialled', async () => {
    const { client, createUpstream } = setup(batchModel);
    await startSession(client, 'whisper');

    expect(client.framesOfType('ready')).toEqual([
      { type: 'ready', mode: 'batch', knowledgeSources: ['audio'], conversation: true }
    ]);
    expect(createUpstream).not.toHaveBeenCalled();
  });

  test('every commit transcribes the audio since the previous one', async () => {
    transcribe
      .mockResolvedValueOnce({ text: 'first turn' })
      .mockResolvedValueOnce({ text: ' second   turn ' });
    const { client, limiter } = setup(batchModel);
    await startSession(client, 'whisper');

    turnAudio(client, 1, 3_000);
    turnAudio(client, 1, 2_000);
    await tick();
    expect(transcribe).not.toHaveBeenCalled(); // nothing until the turn ends
    sendJson(client, { type: 'commit' });
    await tick();

    expect(transcribe).toHaveBeenCalledTimes(1);
    const first = transcribe.mock.calls[0][0];
    expect(first.pcm).toEqual(Buffer.alloc(5_000, 1));
    expect(first.sampleRate).toBe(16000);
    expect(first.cfg.model).toBe('whisper-1');
    expect(finals(client)).toEqual([{ turn: 1, text: 'first turn' }]);

    turnAudio(client, 2, 4_000);
    sendJson(client, { type: 'commit' });
    await tick();

    expect(transcribe.mock.calls[1][0].pcm).toEqual(Buffer.alloc(4_000, 2));
    expect(finals(client)).toEqual([
      { turn: 1, text: 'first turn' },
      { turn: 2, text: 'second turn' }
    ]);
    // The session goes on: no done, still open, the slot still held.
    expect(client.framesOfType('done')).toHaveLength(0);
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(limiter.total).toBe(1);
  });

  test('two quick commits queue: one transcription at a time, finals in order', async () => {
    let finishFirst;
    transcribe
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishFirst = () => resolve({ text: 'one' });
          })
      )
      .mockResolvedValueOnce({ text: 'two' });
    const { client } = setup(batchModel);
    await startSession(client, 'whisper');

    turnAudio(client, 1);
    sendJson(client, { type: 'commit' });
    turnAudio(client, 2);
    sendJson(client, { type: 'commit' });
    sendJson(client, { type: 'commit' }); // an empty third turn
    await tick();

    // The second turn waits for the first.
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(client.framesOfType('final')).toHaveLength(0);

    finishFirst();
    await tick();

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[1][0].pcm).toEqual(Buffer.alloc(PCM, 2));
    expect(finals(client)).toEqual([
      { turn: 1, text: 'one' },
      { turn: 2, text: 'two' },
      { turn: 3, text: '' }
    ]);
  });

  test('commits that pile up behind a slow transcription end the session', async () => {
    transcribe.mockImplementation(() => new Promise(() => {})); // never answers
    const { client, limiter } = setup(batchModel);
    await startSession(client, 'whisper');

    for (let turn = 1; turn <= 40; turn += 1) {
      turnAudio(client, 1);
      sendJson(client, { type: 'commit' });
    }
    await tick();

    expect(client.framesOfType('error')[0].code).toBe('turn-backlog');
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
  });

  test('a commit with no audio is an empty final and never reaches the provider', async () => {
    const { client } = setup(batchModel);
    await startSession(client, 'whisper');

    sendJson(client, { type: 'commit' });
    await tick();

    expect(finals(client)).toEqual([{ turn: 1, text: '' }]);
    expect(transcribe).not.toHaveBeenCalled();
  });

  test('a clip shorter than 100 ms is silence: the provider is not asked', async () => {
    const { client } = setup(batchModel);
    await startSession(client, 'whisper');

    turnAudio(client, 1, 1_000);
    sendJson(client, { type: 'commit' });
    await tick();

    expect(finals(client)).toEqual([{ turn: 1, text: '' }]);
    expect(transcribe).not.toHaveBeenCalled();
  });

  test('audio and commits sent while the model resolves are not lost', async () => {
    transcribe.mockResolvedValue({ text: 'early' });
    const { client } = setup(batchModel);
    sendJson(client, { ...START, modelId: 'whisper' });
    turnAudio(client, 7);
    sendJson(client, { type: 'commit' });
    await tick();

    expect(transcribe.mock.calls[0][0].pcm).toEqual(Buffer.alloc(PCM, 7));
    expect(finals(client)).toEqual([{ turn: 1, text: 'early' }]);
  });

  test('the byte budget is per turn: it is given back after each transcription', async () => {
    usePlatform({
      realtime: { maxBufferedAudioBytes: 5_000, maxBufferedAudioBytesTotal: 5_000 }
    });
    transcribe.mockResolvedValue({ text: 'ok' });
    const { client } = setup(batchModel);
    await startSession(client, 'whisper');

    // Together these are far above both caps; each one alone is below.
    for (let turn = 1; turn <= 6; turn += 1) {
      turnAudio(client, turn, 4_000);
      sendJson(client, { type: 'commit' });
      await tick();
    }

    expect(client.framesOfType('error')).toHaveLength(0);
    expect(finals(client).map(f => f.turn)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('a single turn above the per-connection cap fails the session', async () => {
    usePlatform({ realtime: { maxBufferedAudioBytes: 5_000 } });
    const { client, limiter } = setup(batchModel);
    await startSession(client, 'whisper');

    turnAudio(client, 1, 3_000);
    turnAudio(client, 1, 3_000);
    await tick();

    expect(client.framesOfType('error')[0].code).toBe('audio-too-long');
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
    expect(transcribe).not.toHaveBeenCalled();
  });

  test('the process-wide cap still applies to a conversation', async () => {
    usePlatform({ realtime: { maxBufferedAudioBytesTotal: 5_000 } });
    transcribe.mockReturnValue(new Promise(() => {})); // never finishes: the bytes stay held
    const first = setup(batchModel);
    await startSession(first.client, 'whisper');
    turnAudio(first.client, 1, 4_000);
    sendJson(first.client, { type: 'commit' });
    await tick();

    const second = setup(batchModel);
    await startSession(second.client, 'whisper');
    turnAudio(second.client, 1, 4_000);
    await tick();

    expect(second.client.framesOfType('error')[0].code).toBe('server-busy');
    expect(first.client.framesOfType('error')).toHaveLength(0);
    // Closing the first gives its share back.
    first.client.close();
    await tick();
    const third = setup(batchModel);
    await startSession(third.client, 'whisper');
    turnAudio(third.client, 1, 4_000);
    await tick();
    expect(third.client.framesOfType('error')).toHaveLength(0);
  });

  test('a failed transcription ends the session with an error frame', async () => {
    transcribe.mockRejectedValue(new Error('Transcription request failed (HTTP 429)'));
    const { client, limiter } = setup(batchModel);
    await startSession(client, 'whisper');

    turnAudio(client, 1);
    sendJson(client, { type: 'commit' });
    await tick();

    const [error] = client.framesOfType('error');
    expect(error.code).toBe('upstream-error');
    expect(error.message).toMatch(/HTTP 429/);
    expect(client.framesOfType('final')).toHaveLength(0);
    expect(limiter.total).toBe(0);
  });

  test('stop waits for the transcriptions in flight, then done', async () => {
    let finish;
    transcribe.mockReturnValue(
      new Promise(resolve => {
        finish = () => resolve({ text: 'last words' });
      })
    );
    const { client, limiter } = setup(batchModel);
    await startSession(client, 'whisper');

    turnAudio(client, 1);
    sendJson(client, { type: 'commit' });
    turnAudio(client, 2); // never committed
    sendJson(client, { type: 'stop' });
    await tick(1_000);
    expect(client.framesOfType('done')).toHaveLength(0);

    finish();
    await tick();

    expect(finals(client)).toEqual([{ turn: 1, text: 'last words' }]);
    expect(client.framesOfType('done')).toHaveLength(1);
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(limiter.total).toBe(0);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  test('a client that leaves mid-transcription gets nothing and frees its slot', async () => {
    transcribe.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    );
    const { client, limiter } = setup(batchModel);
    await startSession(client, 'whisper');

    turnAudio(client, 1);
    sendJson(client, { type: 'commit' });
    await tick();
    client.close();
    await tick();

    expect(client.framesOfType('error')).toHaveLength(0);
    expect(client.framesOfType('final')).toHaveLength(0);
    expect(limiter.total).toBe(0);
  });
});

describe('provider commit frames', () => {
  test('vLLM ends a turn with a final commit and starts the next with a plain one', () => {
    const vllm = getTranscriptionProvider('vllm-realtime');
    expect(vllm.commitFrames({})).toEqual([{ type: 'input_audio_buffer.commit', final: true }]);
    expect(vllm.turnStartFrames({})).toEqual([{ type: 'input_audio_buffer.commit' }]);
    expect(vllm.commitEndsWithFinal).toBe(true);
  });

  test('Mistral flushes without ending the stream', () => {
    const mistral = getTranscriptionProvider('mistral');
    expect(mistral.commitFrames({})).toEqual([{ type: 'input_audio.flush' }]);
    expect(mistral.turnStartFrames).toBeUndefined();
    expect(mistral.commitEndsWithFinal).toBeUndefined();
  });

  test('Gemini Live signals the end of the audio stream, which the session survives', () => {
    const gemini = getTranscriptionProvider('google-live');
    expect(gemini.commitFrames({})).toEqual([{ realtimeInput: { audioStreamEnd: true } }]);
  });

  test('batch providers have no commit frames: the bridge transcribes instead', () => {
    for (const id of ['openai', 'local', 'google-transcribe']) {
      expect(getTranscriptionProvider(id).commitFrames).toBeUndefined();
    }
  });
});
