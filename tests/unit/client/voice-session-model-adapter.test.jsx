/**
 * Voice mode (issue #2868), speech service `model`: the conversation socket to
 * `/api/voice/realtime`. A fake WebSocket stands in for the server, so the
 * tests decide what arrives when: audio only while the user speaks, one
 * `commit` per turn, finals matched by turn number, a keepalive for the whole
 * session, one reconnect per outage.
 */

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildWsUrl: path => `ws://localhost${path}`
}));
// The speech service module also pulls in the Azure SDK and dictation classes.
jest.mock('../../../client/src/utils/azureRecognitionService', () => ({
  __esModule: true,
  default: class {}
}));
jest.mock('../../../client/src/utils/modelRecognitionService', () => ({
  __esModule: true,
  default: class {}
}));

import {
  KEEPALIVE_INTERVAL_MS,
  MAX_BUFFERED_BYTES,
  createModelAdapter
} from '../../../client/src/features/voice/utils/voiceSession/modelAdapter';

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  // --- what the network and the server do ---
  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, wasClean: code === 1000 });
  }

  json() {
    return this.sent.filter(data => typeof data === 'string').map(data => JSON.parse(data));
  }

  audio() {
    return this.sent.filter(data => typeof data !== 'string');
  }
}

const pcm = (value, length = 160) => new Int16Array(length).fill(value);

function setup(options = {}) {
  FakeSocket.instances = [];
  const events = [];
  const adapter = createModelAdapter({
    modelId: 'voxtral',
    language: 'de',
    emit: event => events.push(event),
    createWebSocket: url => new FakeSocket(url),
    reconnectDelayMs: 100,
    ...options
  });
  const socket = () => FakeSocket.instances[FakeSocket.instances.length - 1];
  // Connect and let the server say ready.
  const connect = async () => {
    const started = adapter.start();
    socket().open();
    socket().receive({ type: 'ready', mode: 'stream' });
    await started;
  };
  return { adapter, events, socket, connect };
}

const finals = events => events.filter(event => event.type === 'final').map(event => event.text);

describe('model adapter: the conversation socket', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('opens /api/voice/realtime and starts a conversation session for the model', async () => {
    const { adapter, socket } = setup();
    const started = adapter.start();
    expect(socket().url).toBe('ws://localhost/voice/realtime');
    expect(socket().binaryType).toBe('arraybuffer');

    socket().open();
    expect(socket().json()[0]).toEqual({
      type: 'start',
      modelId: 'voxtral',
      lang: 'de-DE',
      conversation: true
    });

    let resolved = false;
    started.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    // Not ready until the server says so
    expect(resolved).toBe(false);
    socket().receive({ type: 'ready', mode: 'stream' });
    await started;
    expect(resolved).toBe(true);
    adapter.stop();
  });

  test('sends audio only while the user speaks: pre-roll first, then the frames, nothing after the commit', async () => {
    const { adapter, socket, connect } = setup();
    await connect();

    adapter.pushAudio(pcm(1)); // no turn: silence stays here
    expect(socket().audio()).toHaveLength(0);

    adapter.beginTurn(pcm(2, 480)); // the pre-roll
    adapter.pushAudio(pcm(3));
    adapter.pushAudio(pcm(4));
    expect(
      socket()
        .audio()
        .map(buffer => new Int16Array(buffer)[0])
    ).toEqual([2, 3, 4]);
    expect(socket().audio()[0].byteLength).toBe(960);

    adapter.commitTurn();
    expect(socket().json().slice(-1)[0]).toEqual({ type: 'commit' });
    adapter.pushAudio(pcm(5)); // the app is thinking: nothing goes up
    expect(socket().audio()).toHaveLength(3);
    adapter.stop();
  });

  test('commits once per turn and ignores a second commit', async () => {
    const { adapter, socket, connect } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    adapter.commitTurn();
    adapter.commitTurn();
    expect(
      socket()
        .json()
        .filter(frame => frame.type === 'commit')
    ).toHaveLength(1);
    adapter.stop();
  });

  test('delta frames become interim text; the final of the turn replaces them', async () => {
    const { adapter, socket, connect, events } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    socket().receive({ type: 'delta', text: 'Wie ' });
    socket().receive({ type: 'delta', text: 'ist das ' });
    socket().receive({ type: 'delta', text: 'Wetter' });
    expect(events.map(event => event.text)).toEqual(['Wie', 'Wie ist das', 'Wie ist das Wetter']);

    adapter.commitTurn();
    socket().receive({ type: 'final', text: ' Wie ist das Wetter? ', turn: 1 });
    expect(events.slice(-1)[0]).toEqual({ type: 'final', text: 'Wie ist das Wetter?' });

    // The next turn starts its caption from scratch
    adapter.beginTurn(pcm(1));
    socket().receive({ type: 'delta', text: 'Danke' });
    expect(events.slice(-1)[0]).toEqual({ type: 'interim', text: 'Danke' });
    adapter.stop();
  });

  test('the tail of an earlier turn is not the caption of the turn being spoken', async () => {
    const { adapter, socket, connect, events } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    socket().receive({ type: 'delta', text: 'Wie ist', turn: 1 });
    adapter.commitTurn();
    // The user goes on while the server is still transcribing the first part.
    adapter.beginTurn(pcm(1));
    socket().receive({ type: 'delta', text: ' das', turn: 1 });
    socket().receive({ type: 'delta', text: 'Und', turn: 2 });
    expect(events.map(event => event.text)).toEqual(['Wie ist', 'Und']);

    // Once the first turn is the only one waiting its text is the caption again.
    socket().receive({ type: 'final', text: 'Wie ist das', turn: 1 });
    adapter.commitTurn();
    socket().receive({ type: 'delta', text: ' Wetter', turn: 2 });
    expect(events.filter(event => event.type === 'interim').slice(-1)[0].text).toBe('Und Wetter');
    adapter.stop();
  });

  test('deltas without a turn number (an older server) still make the caption', async () => {
    const { adapter, socket, connect, events } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    socket().receive({ type: 'delta', text: 'Hallo' });
    expect(events).toEqual([{ type: 'interim', text: 'Hallo' }]);
    adapter.stop();
  });

  test('a batch model sends no deltas: the final alone ends the turn', async () => {
    const { adapter, socket, connect, events } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    adapter.commitTurn();
    socket().receive({ type: 'final', text: 'Guten Tag', turn: 1 });
    expect(events).toEqual([{ type: 'final', text: 'Guten Tag' }]);
    adapter.stop();
  });

  test('an empty final (silence) is still reported, as an empty transcript', async () => {
    const { adapter, socket, connect, events } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    adapter.commitTurn();
    socket().receive({ type: 'final', text: '', turn: 1 });
    expect(finals(events)).toEqual(['']);
    adapter.stop();
  });

  test('finals are matched by turn number, each turn once', async () => {
    const { adapter, socket, connect, events } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    adapter.commitTurn();
    socket().receive({ type: 'final', text: 'eins', turn: 1 });
    adapter.beginTurn(pcm(1));
    adapter.commitTurn();
    socket().receive({ type: 'final', text: 'zwei', turn: 2 });
    expect(finals(events)).toEqual(['eins', 'zwei']);

    // A repeated or unknown turn is stale: ignored
    socket().receive({ type: 'final', text: 'eins again', turn: 1 });
    socket().receive({ type: 'final', text: 'zwei again', turn: 2 });
    socket().receive({ type: 'final', text: 'from nowhere', turn: 9 });
    expect(finals(events)).toEqual(['eins', 'zwei']);
    adapter.stop();
  });

  test('a final that arrives before its commit was sent is not mistaken for a later turn', async () => {
    const { adapter, socket, connect, events } = setup();
    await connect();
    socket().receive({ type: 'final', text: 'stray', turn: 1 });
    expect(finals(events)).toEqual([]);
    adapter.beginTurn(pcm(1));
    adapter.commitTurn();
    socket().receive({ type: 'final', text: 'real', turn: 1 });
    expect(finals(events)).toEqual(['real']);
    adapter.stop();
  });

  test('when a newer turn is answered first, the older one ends empty and is not answered twice', async () => {
    const { adapter, socket, connect, events } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    adapter.commitTurn(); // turn 1
    adapter.beginTurn(pcm(1));
    adapter.commitTurn(); // turn 2
    socket().receive({ type: 'final', text: 'zwei', turn: 2 });
    expect(finals(events)).toEqual(['', 'zwei']);
    socket().receive({ type: 'final', text: 'eins late', turn: 1 });
    expect(finals(events)).toEqual(['', 'zwei']);
    adapter.stop();
  });

  test('a turn dropped by the user is flushed on the server and its answer ignored', async () => {
    const { adapter, socket, connect, events } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    adapter.cancelTurn();
    expect(socket().json().slice(-1)[0]).toEqual({ type: 'commit' });
    socket().receive({ type: 'delta', text: 'half a sentence' });
    socket().receive({ type: 'final', text: 'half a sentence', turn: 1 });
    expect(events).toEqual([]);

    // The next turn is number 2 on the server
    adapter.beginTurn(pcm(1));
    adapter.commitTurn();
    socket().receive({ type: 'final', text: 'second', turn: 2 });
    expect(finals(events)).toEqual(['second']);
    adapter.stop();
  });

  test('muted: no audio goes up', async () => {
    const { adapter, socket, connect } = setup();
    await connect();
    adapter.setMuted(true);
    adapter.beginTurn(pcm(1));
    adapter.pushAudio(pcm(2));
    expect(socket().audio()).toHaveLength(0);
    adapter.stop();
  });

  test('audio is dropped, not queued, while the socket is backed up', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, socket, connect } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    socket().bufferedAmount = MAX_BUFFERED_BYTES + 1;
    adapter.pushAudio(pcm(2));
    adapter.pushAudio(pcm(3));
    expect(socket().audio()).toHaveLength(1); // only the pre-roll
    socket().bufferedAmount = 0;
    adapter.pushAudio(pcm(4));
    expect(socket().audio()).toHaveLength(2);
    // Control frames are tiny and still go
    adapter.commitTurn();
    expect(socket().json().slice(-1)[0]).toEqual({ type: 'commit' });
    warn.mockRestore();
    adapter.stop();
  });

  test('sends a keepalive at least every 20 s for the whole session', async () => {
    jest.useFakeTimers();
    const { adapter, socket, connect } = setup();
    await connect();
    const keepalives = () =>
      socket()
        .json()
        .filter(frame => frame.type === 'keepalive').length;

    expect(KEEPALIVE_INTERVAL_MS).toBeLessThanOrEqual(20_000);
    expect(keepalives()).toBe(0);
    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS - 1);
    expect(keepalives()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(keepalives()).toBe(1);
    jest.advanceTimersByTime(60_000);
    expect(keepalives()).toBe(1 + Math.floor(60_000 / KEEPALIVE_INTERVAL_MS));

    // Also while muted and while the app speaks
    adapter.setMuted(true);
    adapter.setAgentState('speaking');
    const before = keepalives();
    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 2);
    expect(keepalives()).toBe(before + 2);

    adapter.stop();
    const after = keepalives();
    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 3);
    expect(keepalives()).toBe(after);
  });

  test('stop() tells the server and closes the socket; nothing is emitted afterwards', async () => {
    const { adapter, socket, connect, events } = setup();
    await connect();
    const first = socket();
    adapter.stop();
    expect(first.json().slice(-1)[0]).toEqual({ type: 'stop' });
    expect(first.closed).toBe(true);
    adapter.stop(); // idempotent
    first.drop(1006);
    expect(events).toEqual([]);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('model adapter: failures', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('an unexpected close is answered with one reconnect and a fresh start frame', async () => {
    jest.useFakeTimers();
    const { adapter, socket, connect, events } = setup();
    await connect();
    const first = socket();

    first.drop(1006);
    expect(FakeSocket.instances).toHaveLength(1); // not at once
    jest.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);

    const second = socket();
    second.open();
    expect(second.json()[0]).toEqual({
      type: 'start',
      modelId: 'voxtral',
      lang: 'de-DE',
      conversation: true
    });
    second.receive({ type: 'ready', mode: 'stream' });
    expect(events).toEqual([]); // the user noticed nothing

    // The new socket works: turn numbers start again at 1
    adapter.beginTurn(pcm(1));
    adapter.commitTurn();
    second.receive({ type: 'final', text: 'back again', turn: 1 });
    expect(finals(events)).toEqual(['back again']);

    adapter.stop();
  });

  test('a reconnect that works restores the budget: the next outage is survived too', async () => {
    jest.useFakeTimers();
    const { adapter, socket, connect, events } = setup();
    await connect();
    for (let outage = 1; outage <= 3; outage++) {
      socket().drop(1006);
      jest.advanceTimersByTime(100);
      expect(FakeSocket.instances).toHaveLength(outage + 1);
      socket().open();
      socket().receive({ type: 'ready' });
    }
    expect(events).toEqual([]);

    // And the conversation still works on the last socket.
    adapter.beginTurn(pcm(1));
    adapter.commitTurn();
    socket().receive({ type: 'final', text: 'still here', turn: 1 });
    expect(finals(events)).toEqual(['still here']);
    adapter.stop();
  });

  test('a reconnect whose socket closes before it is ready ends the session', async () => {
    jest.useFakeTimers();
    const { adapter, socket, connect, events } = setup();
    await connect();
    socket().drop(1006);
    jest.advanceTimersByTime(100);
    socket().open(); // the server never says ready
    socket().drop(1006);
    jest.advanceTimersByTime(10_000);

    expect(FakeSocket.instances).toHaveLength(2); // no third attempt
    const errors = events.filter(event => event.type === 'error');
    expect(errors).toEqual([
      expect.objectContaining({ type: 'error', code: 'connection', recoverable: false })
    ]);
    adapter.stop();
  });

  test('a drop right after a reconnect, before ready, is still one outage: no endless retries', async () => {
    jest.useFakeTimers();
    const { adapter, socket, connect, events } = setup();
    await connect();
    socket().drop(1006);
    jest.advanceTimersByTime(100);
    socket().drop(1006); // the reconnecting socket never opened
    jest.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    adapter.stop();
  });

  describe('a turn that was being spoken when the socket dropped', () => {
    const reconnect = socket => {
      jest.advanceTimersByTime(100);
      socket().open();
      socket().receive({ type: 'ready' });
    };

    test('is not sent as the sentence that is left: it ends empty and is flushed away', async () => {
      jest.useFakeTimers();
      const { adapter, socket, connect, events } = setup();
      await connect();
      adapter.beginTurn(pcm(1));
      adapter.pushAudio(pcm(2));
      socket().drop(1006);
      jest.advanceTimersByTime(100);
      socket().open();
      socket().receive({ type: 'ready' });
      // The user is still talking: the end of the sentence reaches the new socket.
      adapter.pushAudio(pcm(3));
      expect(socket().audio()).toHaveLength(1);
      adapter.commitTurn();

      expect(finals(events)).toEqual(['']);
      // The tail the server holds is flushed, and what it makes of it is ignored.
      expect(
        socket()
          .json()
          .filter(frame => frame.type === 'commit')
      ).toHaveLength(1);
      socket().receive({ type: 'final', text: 'das Wetter in Berlin', turn: 1 });
      expect(finals(events)).toEqual(['']);

      // The next turn is a clean one.
      adapter.beginTurn(pcm(1));
      adapter.commitTurn();
      socket().receive({ type: 'final', text: 'Wie ist das Wetter in Berlin', turn: 2 });
      expect(finals(events)).toEqual(['', 'Wie ist das Wetter in Berlin']);
      adapter.stop();
    });

    test('also when it ends before the new socket is back', async () => {
      jest.useFakeTimers();
      const { adapter, socket, connect, events } = setup();
      await connect();
      adapter.beginTurn(pcm(1));
      socket().drop(1006);
      adapter.pushAudio(pcm(2));
      adapter.commitTurn();
      expect(finals(events)).toEqual(['']);
      reconnect(socket);
      expect(finals(events)).toEqual(['']);
      adapter.stop();
    });

    test('a turn that begins while the socket is down is truncated from the start', async () => {
      jest.useFakeTimers();
      const { adapter, socket, connect, events } = setup();
      await connect();
      socket().drop(1006);
      adapter.beginTurn(pcm(1));
      adapter.pushAudio(pcm(2));
      reconnect(socket);
      adapter.pushAudio(pcm(3));
      adapter.commitTurn();
      expect(finals(events)).toEqual(['']);
      adapter.stop();
    });

    test('a turn after the outage is sent as usual', async () => {
      jest.useFakeTimers();
      const { adapter, socket, connect, events } = setup();
      await connect();
      adapter.beginTurn(pcm(1));
      socket().drop(1006);
      adapter.cancelTurn(); // muted: dropped either way
      reconnect(socket);
      adapter.beginTurn(pcm(1));
      adapter.pushAudio(pcm(2));
      adapter.commitTurn();
      socket().receive({ type: 'final', text: 'complete sentence', turn: 1 });
      expect(finals(events)).toEqual(['complete sentence']);
      adapter.stop();
    });
  });

  test('a turn waiting for its final when the socket drops ends empty after the reconnect', async () => {
    jest.useFakeTimers();
    const { adapter, socket, connect, events } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    adapter.commitTurn();
    socket().drop(1006);
    jest.advanceTimersByTime(100);
    expect(finals(events)).toEqual(['']);
    adapter.stop();
  });

  test('a turn committed while the socket is down ends empty at once', async () => {
    jest.useFakeTimers();
    const { adapter, socket, connect, events } = setup();
    await connect();
    adapter.beginTurn(pcm(1));
    socket().drop(1006);
    adapter.commitTurn();
    expect(finals(events)).toEqual(['']);
    adapter.stop();
  });

  test('an error frame from the server is final: its code and message, no reconnect', async () => {
    jest.useFakeTimers();
    const { adapter, socket, connect, events } = setup();
    await connect();
    socket().receive({ type: 'error', code: 'session-limit', message: 'Too long' });
    socket().drop(1005);
    jest.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(events).toEqual([
      { type: 'error', code: 'session-limit', message: 'Too long', recoverable: false }
    ]);
    adapter.stop();
  });

  test('the server ending a silent conversation passes its code through for the overlay', async () => {
    jest.useFakeTimers();
    const { adapter, socket, connect, events } = setup();
    await connect();
    socket().receive({
      type: 'error',
      code: 'no-speech',
      message: 'Nothing was said for a long time, so the session was closed'
    });
    socket().drop(1008);
    jest.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(events).toEqual([
      {
        type: 'error',
        code: 'no-speech',
        message: 'Nothing was said for a long time, so the session was closed',
        recoverable: false
      }
    ]);
    adapter.stop();
  });

  test('refusals (policy violation, application close codes) are not retried', async () => {
    jest.useFakeTimers();
    for (const code of [1008, 4401]) {
      const { adapter, socket, connect, events } = setup();
      await connect();
      socket().drop(code);
      jest.advanceTimersByTime(10_000);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(events.filter(event => event.type === 'error')).toHaveLength(1);
      adapter.stop();
    }
  });

  test('start() rejects with the server code when it refuses the session', async () => {
    const { adapter, socket } = setup();
    const started = adapter.start();
    socket().open();
    socket().receive({ type: 'error', code: 'model-disabled', message: 'Model is disabled' });
    socket().drop(1005);
    await expect(started).rejects.toMatchObject({
      code: 'model-disabled',
      message: 'Model is disabled'
    });
    adapter.stop();
  });

  test('start() rejects when the socket closes before the server is ready', async () => {
    const { adapter, socket } = setup();
    const started = adapter.start();
    socket().drop(1006);
    await expect(started).rejects.toMatchObject({ code: 'connection' });
    expect(FakeSocket.instances).toHaveLength(1); // no reconnect before the session came up
    adapter.stop();
  });

  test('start() rejects when the server never says ready', async () => {
    jest.useFakeTimers();
    const { adapter, socket } = setup({ readyTimeoutMs: 5000 });
    const started = adapter.start();
    socket().open();
    const outcome = expect(started).rejects.toMatchObject({ code: 'connection' });
    jest.advanceTimersByTime(5000);
    await outcome;
    adapter.stop();
  });

  test('start() rejects when the socket cannot even be created', async () => {
    const adapter = createModelAdapter({
      modelId: 'voxtral',
      emit: () => {},
      createWebSocket: () => {
        throw new Error('blocked');
      }
    });
    await expect(adapter.start()).rejects.toMatchObject({ code: 'connection', message: 'blocked' });
  });

  test('ignores frames it does not know and text that is not JSON', async () => {
    const { adapter, socket, connect, events } = setup();
    await connect();
    socket().receive({ type: 'mystery' });
    socket().onmessage({ data: 'not json' });
    expect(events).toEqual([]);
    adapter.stop();
  });
});
