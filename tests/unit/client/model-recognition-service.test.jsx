/**
 * Dictation with a transcription model (`ModelSpeechRecognition`): the session
 * names its model, and after `stop()` it waits for the transcript as long as
 * the model needs — a streaming model's completes within the server's settle
 * window, a batch model only starts transcribing on `stop`.
 */
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildWsUrl: path => `ws://localhost${path}`
}));
jest.mock('../../../client/src/utils/realtimeTranscriptionCore', () => ({
  ...jest.requireActual('../../../client/src/utils/realtimeTranscriptionCore'),
  createPcmCapturePipeline: jest.fn(async () => ({ stop: jest.fn() }))
}));

import ModelSpeechRecognition from '../../../client/src/utils/modelRecognitionService';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = FakeSocket.CONNECTING;
    FakeSocket.instances.push(this);
    Promise.resolve().then(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  receive(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  controlFrames() {
    return this.sent.filter(data => typeof data === 'string').map(data => JSON.parse(data));
  }
}

async function started(modelId = 'gemini-live') {
  const recognition = new ModelSpeechRecognition(modelId);
  recognition.lang = 'de-DE';
  recognition.continuous = true;
  recognition.onresult = jest.fn();
  recognition.onend = jest.fn();
  recognition.onerror = jest.fn();
  await recognition.start();
  return { recognition, socket: FakeSocket.instances.at(-1) };
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.instances.length = 0;
  global.WebSocket = FakeSocket;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: jest.fn(async () => ({ getTracks: () => [{ stop: jest.fn() }] })) }
  });
});

afterEach(() => {
  jest.useRealTimers();
  delete navigator.mediaDevices;
});

test('the session names its model and the recognition language', async () => {
  const { socket } = await started('gemini-live');
  expect(socket.url).toBe('ws://localhost/voice/realtime');
  expect(socket.controlFrames()[0]).toEqual({
    type: 'start',
    modelId: 'gemini-live',
    lang: 'de-DE'
  });
});

test('a batch model gets its time to transcribe after stop', async () => {
  const { recognition, socket } = await started('gemini-transcribe');
  socket.receive({ type: 'ready', mode: 'batch', knowledgeSources: ['audio'] });

  recognition.stop();
  expect(socket.controlFrames().at(-1)).toEqual({ type: 'stop' });
  // Past a streaming model's fallback: still waiting.
  jest.advanceTimersByTime(10_000);
  expect(socket.readyState).toBe(FakeSocket.OPEN);

  socket.receive({ type: 'final', text: 'Hallo Welt' });
  socket.receive({ type: 'done' });
  expect(recognition.onresult).toHaveBeenLastCalledWith({ text: 'Hallo Welt', isFinal: true });
  expect(socket.readyState).toBe(FakeSocket.CLOSED);
  expect(recognition.onend).toHaveBeenCalled();
});

test('a streaming model that never says done is torn down shortly after stop', async () => {
  const { recognition, socket } = await started('voxtral');
  socket.receive({ type: 'ready', mode: 'stream', knowledgeSources: ['audio'] });
  socket.receive({ type: 'delta', text: 'hello' });

  recognition.stop();
  jest.advanceTimersByTime(3_000);
  expect(socket.readyState).toBe(FakeSocket.CLOSED);
  expect(recognition.onresult).toHaveBeenLastCalledWith({ text: 'hello', isFinal: true });
  expect(recognition.onend).toHaveBeenCalled();
});

test('a server error (say, a model the user may not use) ends the session', async () => {
  const { recognition, socket } = await started('voxtral');
  socket.receive({
    type: 'error',
    code: 'not-permitted',
    message: 'Not permitted to use transcription model: voxtral'
  });
  expect(recognition.onerror).toHaveBeenCalledWith({
    error: 'service',
    message: 'Not permitted to use transcription model: voxtral'
  });
  expect(socket.readyState).toBe(FakeSocket.CLOSED);
});
