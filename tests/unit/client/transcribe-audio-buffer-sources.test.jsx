import { transcribeAudioBuffer } from '../../../client/src/utils/transcribeAudioBuffer';

/**
 * The transcription server names what a transcript is based on — the session's
 * `ready` frame carries `knowledgeSources` — and `transcribeAudioBuffer` hands it
 * to the caller for the answer badge. The client never supplies a source itself.
 */

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildWsUrl: path => `ws://ihub.test${path}`
}));

class FakeSocket {
  static OPEN = 1;
  static last = null;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

// Mono at 16 kHz: no resampling, so no OfflineAudioContext is needed.
const AUDIO = {
  length: 4,
  numberOfChannels: 1,
  sampleRate: 16000,
  getChannelData: () => new Float32Array([0, 0.25, -0.25, 0])
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function openSession(opts) {
  const transcript = transcribeAudioBuffer(AUDIO, { modelId: 'voxtral', ...opts });
  await flush();
  const socket = FakeSocket.last;
  expect(JSON.parse(socket.sent[0])).toEqual({ type: 'start', modelId: 'voxtral' });
  return { transcript, socket };
}

const originalWebSocket = global.WebSocket;

beforeEach(() => {
  FakeSocket.last = null;
  global.WebSocket = FakeSocket;
});

afterEach(() => {
  global.WebSocket = originalWebSocket;
});

describe('transcribeAudioBuffer — the source of the transcript', () => {
  test('passes on the sources the server named when the session became ready', async () => {
    const onSources = jest.fn();
    const { transcript, socket } = await openSession({ onSources });

    socket.receive({ type: 'ready', knowledgeSources: ['audio'] });
    expect(onSources).toHaveBeenCalledWith(['audio']);

    await flush();
    socket.receive({ type: 'final', text: 'hello there' });
    socket.receive({ type: 'done' });
    await expect(transcript).resolves.toBe('hello there');
    expect(onSources).toHaveBeenCalledTimes(1);
  });

  test('reports no source the server did not name', async () => {
    const onSources = jest.fn();
    const { transcript, socket } = await openSession({ onSources });

    socket.receive({ type: 'ready' });
    await flush();
    socket.receive({ type: 'final', text: 'hello' });
    socket.receive({ type: 'done' });
    await expect(transcript).resolves.toBe('hello');
    expect(onSources).not.toHaveBeenCalled();
  });
});
