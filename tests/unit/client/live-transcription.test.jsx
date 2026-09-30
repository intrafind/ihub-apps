/**
 * `startLiveTranscription`: the chat's record button streams the microphone to
 * a transcription model and reports the running transcript while the user is
 * still speaking.
 */

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildWsUrl: path => `ws://localhost/api${path}`
}));

// The capture graph needs Web Audio; the test hands frames in itself.
const mockCapture = { onFrame: null, stop: jest.fn() };
jest.mock('../../../client/src/utils/realtimeTranscriptionCore', () => ({
  ...jest.requireActual('../../../client/src/utils/realtimeTranscriptionCore'),
  __esModule: true,
  createPcmCapturePipeline: jest.fn(async (_stream, onFrame) => {
    mockCapture.onFrame = onFrame;
    return { sampleRate: 16000, stop: mockCapture.stop };
  })
}));

import { startLiveTranscription } from '../../../client/src/utils/liveTranscription';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  // The server closing a session: a clean close without a status code.
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ wasClean: true, code: 1005 });
  }
  // A proxy timeout or a network drop: no close handshake.
  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ wasClean: false, code: 1006 });
  }
  // Test controls
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  json() {
    return this.sent.filter(d => typeof d === 'string').map(d => JSON.parse(d));
  }
  binary() {
    return this.sent.filter(d => typeof d !== 'string');
  }
}

let track;

function grantMicrophone() {
  track = { stop: jest.fn() };
  const stream = { getTracks: () => [track] };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: jest.fn().mockResolvedValue(stream) }
  });
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Start a session through an opened socket; returns the session and its socket. */
async function start(opts = {}) {
  const starting = startLiveTranscription({ modelId: 'voxtral', ...opts });
  await tick();
  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  const session = await starting;
  return { session, ws };
}

const speak = () => mockCapture.onFrame(new Float32Array(160).fill(0.1), 16000);

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  global.WebSocket = FakeWebSocket;
  mockCapture.onFrame = null;
  mockCapture.stop.mockClear();
  grantMicrophone();
});

afterEach(() => {
  delete navigator.mediaDevices;
});

test('names the model, holds audio until ready, then streams and grows the transcript', async () => {
  const onText = jest.fn();
  const { session, ws } = await start({ onText });
  expect(ws.url).toBe('ws://localhost/api/voice/realtime');
  expect(ws.json()).toEqual([{ type: 'start', modelId: 'voxtral' }]);

  // Captured before the upstream is ready: held, not dropped.
  speak();
  speak();
  expect(ws.binary()).toHaveLength(0);
  ws.receive({ type: 'ready' });
  expect(ws.binary()).toHaveLength(2);
  speak();
  expect(ws.binary()).toHaveLength(3);

  ws.receive({ type: 'delta', text: 'Hello' });
  ws.receive({ type: 'delta', text: ' there' });
  ws.receive({ type: 'final', text: 'Hello there.' });
  expect(onText.mock.calls.map(([text]) => text)).toEqual(['Hello', 'Hello there', 'Hello there.']);
  expect(session.text()).toBe('Hello there.');

  const stopped = session.stop();
  // The microphone is released at once; the socket stays for the tail.
  expect(track.stop).toHaveBeenCalled();
  expect(mockCapture.stop).toHaveBeenCalled();
  expect(ws.json().at(-1)).toEqual({ type: 'stop' });
  ws.receive({ type: 'delta', text: 'How are you' });
  ws.receive({ type: 'done' });
  await expect(stopped).resolves.toBe('Hello there. How are you');
  expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
});

test('stopped before the upstream is ready: the held audio goes first, then stop', async () => {
  const { session, ws } = await start();
  speak();
  const stopped = session.stop();
  expect(ws.json()).toEqual([{ type: 'start', modelId: 'voxtral' }]);

  ws.receive({ type: 'ready' });
  expect(ws.binary()).toHaveLength(1);
  expect(ws.json().at(-1)).toEqual({ type: 'stop' });
  ws.receive({ type: 'final', text: 'Short.' });
  ws.receive({ type: 'done' });
  await expect(stopped).resolves.toBe('Short.');
});

test('an error while speaking reaches onError with the text so far and frees the mic', async () => {
  const onError = jest.fn();
  const { ws } = await start({ onError });
  ws.receive({ type: 'ready' });
  ws.receive({ type: 'delta', text: 'Half a' });
  ws.receive({ type: 'error', code: 'session-limit', message: 'too long' });

  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0][0]).toMatchObject({ code: 'session-limit', partialText: 'Half a' });
  expect(track.stop).toHaveBeenCalled();
});

test('a socket that closes before stop is an interruption, after stop the end', async () => {
  const onError = jest.fn();
  const first = await start({ onError });
  first.ws.receive({ type: 'ready' });
  first.ws.close();
  expect(onError.mock.calls[0][0].code).toBe('interrupted');

  const second = await start({ onError });
  second.ws.receive({ type: 'ready' });
  second.ws.receive({ type: 'final', text: 'All of it.' });
  const stopped = second.session.stop();
  second.ws.close();
  await expect(stopped).resolves.toBe('All of it.');
  expect(onError).toHaveBeenCalledTimes(1);
});

test('a connection dropped after stop is interrupted, not a finished transcript', async () => {
  const { session, ws } = await start();
  ws.receive({ type: 'ready' });
  ws.receive({ type: 'final', text: 'The first half' });
  const stopped = session.stop();
  // A proxy timing out while the tail is transcribed: no `done`, no clean close.
  ws.drop();
  await expect(stopped).rejects.toMatchObject({
    code: 'interrupted',
    partialText: 'The first half'
  });
});

test('a refusal while the microphone is set up rejects the start, not onError', async () => {
  const onError = jest.fn();
  const {
    createPcmCapturePipeline
  } = require('../../../client/src/utils/realtimeTranscriptionCore');
  createPcmCapturePipeline.mockImplementationOnce(async (_stream, onFrame) => {
    mockCapture.onFrame = onFrame;
    // The server answers the start frame while the graph is still being built.
    FakeWebSocket.instances.at(-1).receive({
      type: 'error',
      code: 'not-permitted',
      message: 'Not permitted to use transcription model'
    });
    return { sampleRate: 16000, stop: mockCapture.stop };
  });

  const starting = startLiveTranscription({ modelId: 'voxtral', onError });
  await tick();
  FakeWebSocket.instances.at(-1).open();

  await expect(starting).rejects.toMatchObject({ code: 'not-permitted' });
  expect(onError).not.toHaveBeenCalled();
  expect(track.stop).toHaveBeenCalled();
  expect(mockCapture.stop).toHaveBeenCalled();
});

test('a denied microphone rejects with code "mic" and opens no socket', async () => {
  navigator.mediaDevices.getUserMedia.mockRejectedValue(new Error('NotAllowedError'));
  await expect(startLiveTranscription({ modelId: 'voxtral' })).rejects.toMatchObject({
    code: 'mic'
  });
  expect(FakeWebSocket.instances).toHaveLength(0);
});

test('cancel rejects a pending stop with "aborted" and keeps the text so far', async () => {
  const onError = jest.fn();
  const { session, ws } = await start({ onError });
  ws.receive({ type: 'ready' });
  ws.receive({ type: 'delta', text: 'Never mind' });
  const stopped = session.stop();
  session.cancel();

  await expect(stopped).rejects.toMatchObject({ code: 'aborted', partialText: 'Never mind' });
  expect(onError).not.toHaveBeenCalled();
  expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
});
