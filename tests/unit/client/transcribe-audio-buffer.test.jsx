/**
 * `transcribeAudioBuffer`: how a finished transcription is told apart from a
 * truncated one. The chat sends an uploaded file's transcript as the message,
 * so a transcript cut off by a dropped connection must fail, not resolve.
 */

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildWsUrl: path => `ws://localhost/api${path}`
}));

import { transcribeAudioBuffer } from '../../../client/src/utils/transcribeAudioBuffer';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor() {
    this.readyState = FakeWebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.finish({ wasClean: true, code: 1005 });
  }
  // Test controls
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  finish(evt) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(evt);
  }
  stopSent() {
    return this.sent.some(d => typeof d === 'string' && JSON.parse(d).type === 'stop');
  }
}

// Already mono 16 kHz, so no resampling (and no OfflineAudioContext) is needed.
const AUDIO = {
  numberOfChannels: 1,
  sampleRate: 16000,
  length: 1600,
  duration: 0.1,
  getChannelData: () => new Float32Array(1600).fill(0.1)
};

/** Start a transcription and stream it up to the `stop` frame. */
async function streamed() {
  const running = transcribeAudioBuffer(AUDIO, { modelId: 'voxtral' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  ws.receive({ type: 'ready' });
  ws.receive({ type: 'final', text: 'Everything we said.' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(ws.stopSent()).toBe(true);
  return { running, ws };
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  global.WebSocket = FakeWebSocket;
});

test('the server closing after stop completes the transcript', async () => {
  const { running, ws } = await streamed();
  ws.finish({ wasClean: true, code: 1005 });
  await expect(running).resolves.toBe('Everything we said.');
});

test('a connection dropped after stop is interrupted, not complete', async () => {
  const { running, ws } = await streamed();
  ws.finish({ wasClean: false, code: 1006 });
  await expect(running).rejects.toMatchObject({ code: 'interrupted' });
});

test('a clean close with an error code after stop is interrupted too', async () => {
  const { running, ws } = await streamed();
  ws.finish({ wasClean: true, code: 1011 });
  await expect(running).rejects.toMatchObject({ code: 'interrupted' });
});

test('`done` completes the transcript whatever follows', async () => {
  const { running, ws } = await streamed();
  ws.receive({ type: 'done' });
  await expect(running).resolves.toBe('Everything we said.');
});
