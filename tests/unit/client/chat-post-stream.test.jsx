// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs';
import path from 'node:path';
import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';

/**
 * A chat turn sent on its own POST stream (`chatPostStream` flag) versus the
 * GET-then-POST it replaces when the flag is off.
 *
 * Runs the real `useAppChat` and `useEventSource`; the transport
 * (`openSseStream`) is a script the test plays: it opens, delivers frames and
 * ends (or breaks) when told to.
 */

jest.mock('uuid', () => ({ __esModule: true, v4: () => '00000000-0000-0000-0000-000000000000' }));
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, def) => (typeof def === 'string' ? def : key) })
}));
jest.mock('../../../client/src/utils/debugLog', () => ({ __esModule: true, debugLog: () => {} }));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`
}));
jest.mock('../../../client/src/utils/sessionManager', () => ({
  __esModule: true,
  getSessionId: () => 'session-1'
}));
jest.mock('../../../client/src/shared/hooks/useMyUsage', () => ({
  __esModule: true,
  refreshMyUsage: () => {}
}));

const mockApi = {
  sendAppChatMessage: jest.fn().mockResolvedValue({}),
  checkAppChatStatus: jest.fn().mockResolvedValue({ active: true, processing: true }),
  stopAppChatStream: jest.fn().mockResolvedValue({}),
  fetchChat: jest.fn().mockResolvedValue(null)
};
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  sendAppChatMessage: (...args) => mockApi.sendAppChatMessage(...args),
  checkAppChatStatus: (...args) => mockApi.checkAppChatStatus(...args),
  stopAppChatStream: (...args) => mockApi.stopAppChatStream(...args),
  fetchChat: (...args) => mockApi.fetchChat(...args)
}));

let mockFlagOn = true;
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({
    isEnabled: (id, fallback) => (id === 'chatPostStream' ? mockFlagOn : fallback)
  })
}));

let mockAcknowledgement = null;
jest.mock('../../../client/src/shared/hooks/useAiAcknowledgement', () => ({
  __esModule: true,
  useAiAcknowledgement: () => mockAcknowledgement
}));

/** Every `openSseStream` call: `{ url, opts, resolve, reject }`. */
const mockStreams = [];
const mockLedger = { events: [] };
jest.mock('../../../client/src/shared/utils/openSseStream', () => {
  const actual = jest.requireActual('../../../client/src/shared/utils/openSseStream');
  return {
    __esModule: true,
    ...actual,
    fetchWithAuthRetry: jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: mockLedger.events, nextCursor: null })
    })),
    openSseStream: jest.fn(
      (url, opts) =>
        new Promise((resolve, reject) => {
          mockStreams.push({ url, opts, resolve, reject });
        })
    )
  };
});

const { SseHttpError, setSseAuthProvider } = jest.requireActual(
  '../../../client/src/shared/utils/openSseStream'
);
const {
  fetchWithAuthRetry: mockFetchLedger
} = require('../../../client/src/shared/utils/openSseStream');
const { TURN_IDLE_TIMEOUT_MS } = require('../../../client/src/shared/hooks/useEventSource');
const useAppChat = require('../../../client/src/features/chat/hooks/useAppChat').default;

const CHAT_ID = 'chat-1';
const RUN_ID = 'chat-run-1';
let seq = 0;

const envelope = (type, data = {}, runId = RUN_ID, extra = {}) => ({
  v: 2,
  seq: ++seq,
  runId,
  ts: new Date(1773561600000 + seq * 1000).toISOString(),
  type,
  data,
  ...extra
});

/** Deliver frames on a stream the way the parser would. */
async function play(stream, ...frames) {
  await act(async () => {
    for (const frame of frames) stream.opts.onEvent(frame.type, frame);
  });
}
const open = async stream => act(async () => stream.opts.onOpen?.({}));
const end = async (stream, value) =>
  act(async () => {
    stream.resolve(value);
    await Promise.resolve();
  });
const fail = async (stream, error) =>
  act(async () => {
    stream.reject(error);
    await Promise.resolve();
  });

const answerFrames = (messageId, text = 'Hello') => [
  envelope('stream/connected', { runId: CHAT_ID, lastSeq: 0, protocol: 2 }, CHAT_ID),
  envelope('run/started', { kind: 'chat', refs: { chatId: CHAT_ID, messageId } }),
  envelope('step/delta', { step: 0, kind: 'text', content: text }, RUN_ID, { rseq: 2 }),
  envelope('run/ended', { status: 'completed', finishReason: 'stop' })
];

function render(options = {}) {
  return renderHook(() => useAppChat({ appId: 'acme', chatId: CHAT_ID, ...options }));
}

function send(result, content = 'hi') {
  act(() => {
    result.current.sendMessage({
      displayMessage: content,
      apiMessage: { content },
      params: { modelId: 'model-x' }
    });
  });
}

const lastAssistant = result => result.current.messages.filter(m => m.role === 'assistant').at(-1);
const flush = () => act(async () => new Promise(resolve => setTimeout(resolve, 0)));

beforeEach(() => {
  mockStreams.length = 0;
  mockLedger.events = [];
  mockFlagOn = true;
  mockAcknowledgement = null;
  seq = 0;
  sessionStorage.clear();
  localStorage.clear();
  Object.values(mockApi).forEach(fn => fn.mockClear());
  mockApi.fetchChat.mockReset().mockResolvedValue(null);
});

/** Ledger frames of a turn that started (and ran a tool), as the replay reads them. */
const ledgerOf = started => [
  { v: 2, seq: 1, runId: RUN_ID, ts: started.ts, type: 'run/started', data: started.data },
  {
    v: 2,
    seq: 4,
    runId: RUN_ID,
    ts: started.ts,
    type: 'tool/started',
    data: { step: 0, callId: 'c1', toolId: 'search', name: 'search', execution: 'server' }
  }
];

/** Send, accept and draw part of an answer; resolves with the stream and frames. */
async function partialTurn(result, text = 'Partial') {
  send(result);
  const stream = mockStreams[0];
  await open(stream);
  const frames = answerFrames(lastAssistant(result).id, text);
  await play(stream, frames[0], frames[1], frames[2]);
  return { stream, frames };
}

describe('flag off: GET first, then the POST', () => {
  test('opens the GET and posts on stream/connected', async () => {
    mockFlagOn = false;
    const { result } = render();
    send(result);
    expect(mockStreams).toHaveLength(1);
    expect(mockStreams[0].url).toBe('/api/apps/acme/chat/chat-1');
    expect(mockStreams[0].opts.method).toBeUndefined();
    await play(mockStreams[0], answerFrames(lastAssistant(result).id)[0]);
    expect(mockApi.sendAppChatMessage).toHaveBeenCalledTimes(1);
  });

  // The POST is answered when the turn ends: its timeout (or a proxy's) loses
  // the reply, not the turn. With the real transport hook: what happens to the
  // GET stream, and that the server is never told to stop.
  describe('a POST whose reply is lost', () => {
    const lostReply = () =>
      Object.assign(new Error('Request timed out.'), {
        isTimeout: true,
        status: 500,
        userFriendlyMessage: 'Request timed out.'
      });

    test('the GET stays open, the answer is drawn to its end and no stop is sent', async () => {
      mockFlagOn = false;
      mockApi.sendAppChatMessage.mockRejectedValueOnce(lostReply());
      const onMessageAccepted = jest.fn();
      const { result } = render({ onMessageAccepted });
      send(result);
      const stream = mockStreams[0];
      await open(stream);
      const frames = answerFrames(lastAssistant(result).id, 'A long answer');
      await play(stream, frames[0]);
      await flush();

      expect(mockApi.checkAppChatStatus).toHaveBeenCalledWith('acme', CHAT_ID, { timeout: 5000 });
      expect(onMessageAccepted).toHaveBeenCalledWith(CHAT_ID);
      expect(stream.opts.signal.aborted).toBe(false);
      expect(result.current.processing).toBe(true);

      await play(stream, frames[1], frames[2], frames[3]);
      expect(lastAssistant(result).content).toBe('A long answer');
      expect(lastAssistant(result).loading).toBe(false);
      expect(result.current.processing).toBe(false);
      // One stream, one POST: the turn was neither sent again nor re-attached to.
      expect(mockStreams).toHaveLength(1);
      expect(mockApi.sendAppChatMessage).toHaveBeenCalledTimes(1);
      expect(mockApi.stopAppChatStream).not.toHaveBeenCalled();
    });

    test('with nothing running the error shows and the GET is let go, without a stop', async () => {
      mockFlagOn = false;
      mockApi.sendAppChatMessage.mockRejectedValueOnce(lostReply());
      mockApi.checkAppChatStatus.mockResolvedValueOnce({ active: false });
      const { result } = render();
      send(result);
      const stream = mockStreams[0];
      await open(stream);
      await play(stream, answerFrames(lastAssistant(result).id)[0]);
      await flush();

      expect(lastAssistant(result).content).toMatch(/Request timed out\./);
      expect(result.current.processing).toBe(false);
      expect(stream.opts.signal.aborted).toBe(true);
      expect(mockApi.stopAppChatStream).not.toHaveBeenCalled();
    });
  });
});

describe('flag on: the POST streams the turn', () => {
  test('sends one POST with the message and renders its frames', async () => {
    const onMessageAccepted = jest.fn();
    const { result } = render({ onMessageAccepted });
    send(result);
    expect(mockStreams).toHaveLength(1);
    const stream = mockStreams[0];
    expect(stream.url).toBe('/api/apps/acme/chat/chat-1');
    expect(stream.opts.method).toBe('POST');
    expect(stream.opts.headers).toEqual({ 'X-Session-ID': 'session-1' });
    expect(stream.opts.body).toMatchObject({
      messages: [expect.objectContaining({ role: 'user', content: 'hi' })],
      modelId: 'model-x'
    });
    await open(stream);
    await play(stream, ...answerFrames(lastAssistant(result).id));
    // stream/connected on the POST does not send anything again.
    expect(mockApi.sendAppChatMessage).not.toHaveBeenCalled();
    await end(stream);
    expect(lastAssistant(result).content).toBe('Hello');
    expect(result.current.processing).toBe(false);
    expect(onMessageAccepted).toHaveBeenCalledWith(CHAT_ID);
    expect(mockApi.checkAppChatStatus).not.toHaveBeenCalled();
  });

  test('a frame the connection already passed is not folded twice', async () => {
    const { result } = render();
    send(result);
    const stream = mockStreams[0];
    await open(stream);
    const [connected, started] = answerFrames(lastAssistant(result).id);
    await play(
      stream,
      connected,
      started,
      envelope('step/delta', { step: 0, kind: 'text', content: 'A' }, RUN_ID, { rseq: 2 }),
      envelope('step/delta', { step: 0, kind: 'text', content: 'A' }, RUN_ID, { rseq: 2 }),
      envelope('step/delta', { step: 0, kind: 'text', content: 'B' }, RUN_ID, { rseq: 3 })
    );
    expect(lastAssistant(result).content).toBe('AB');
  });

  test('a refusal renders its message and sends nothing else', async () => {
    const { result } = render();
    send(result);
    await fail(
      mockStreams[0],
      new SseHttpError('refused', 503, { code: 'CHAT_STORAGE_UNAVAILABLE', detail: 'down' })
    );
    expect(lastAssistant(result).content).toMatch(/Chats cannot be stored right now/);
    expect(result.current.processing).toBe(false);
    expect(mockStreams).toHaveLength(1);
  });

  test('428: asks for the acknowledgement and sends the same request again', async () => {
    mockAcknowledgement = { handleAcknowledgementRequired: jest.fn().mockResolvedValue(true) };
    const { result } = render();
    send(result);
    const firstBody = mockStreams[0].opts.body;
    await fail(
      mockStreams[0],
      new SseHttpError('ack', 428, { code: 'AI_ACKNOWLEDGEMENT_REQUIRED', detail: 'ack' })
    );
    await flush();
    expect(mockAcknowledgement.handleAcknowledgementRequired).toHaveBeenCalledTimes(1);
    expect(mockStreams).toHaveLength(2);
    expect(mockStreams[1].opts.method).toBe('POST');
    expect(mockStreams[1].opts.body).toEqual(firstBody);
    await open(mockStreams[1]);
    await play(mockStreams[1], ...answerFrames(lastAssistant(result).id));
    await end(mockStreams[1]);
    expect(lastAssistant(result).content).toBe('Hello');
  });

  test('a clarification answer travels on the POST', async () => {
    const { result } = render();
    send(result);
    const stream = mockStreams[0];
    await open(stream);
    const question = {
      id: 'q-1',
      runId: RUN_ID,
      step: 0,
      kind: 'question',
      origin: 'tool',
      status: 'pending',
      prompt: { message: 'Which colour?', inputType: 'text' },
      source: { chatId: CHAT_ID },
      policy: {},
      createdAt: new Date().toISOString()
    };
    await play(
      stream,
      ...answerFrames(lastAssistant(result).id).slice(0, 2),
      envelope('interaction/raised', { interaction: question }),
      envelope('run/paused', { reason: 'interaction', interactionId: 'q-1' })
    );
    await end(stream);
    expect(result.current.clarificationPending).toBe(true);
    act(() => {
      result.current.submitClarificationResponse(
        { questionId: 'q-1', value: 'blue', displayText: 'blue' },
        { modelId: 'model-x' }
      );
    });
    expect(mockStreams).toHaveLength(2);
    expect(mockStreams[1].opts.method).toBe('POST');
    expect(mockStreams[1].opts.body.clarificationResponse).toMatchObject({
      questionId: 'q-1',
      value: 'blue'
    });
  });

  test('a tool approval travels on the POST; a refused one asks again', async () => {
    const { result } = render({ toolApprovals: true });
    send(result);
    const stream = mockStreams[0];
    await open(stream);
    const interaction = {
      id: 'approval-1',
      runId: RUN_ID,
      step: 0,
      kind: 'approval',
      origin: 'tool',
      status: 'pending',
      prompt: { message: 'Run it?', displayData: { toolId: 'send_mail', toolName: 'Send mail' } },
      source: { chatId: CHAT_ID, toolId: 'send_mail' },
      policy: {},
      createdAt: new Date().toISOString()
    };
    await play(
      stream,
      ...answerFrames(lastAssistant(result).id).slice(0, 2),
      envelope('interaction/raised', { interaction }),
      envelope('run/paused', { reason: 'interaction', interactionId: 'approval-1' })
    );
    await end(stream);
    expect(lastAssistant(result).toolApproval).toMatchObject({ interactionId: 'approval-1' });

    act(() => {
      result.current.submitToolApproval(
        { interactionId: 'approval-1', decision: 'approve' },
        { modelId: 'model-x' }
      );
    });
    expect(mockStreams).toHaveLength(2);
    expect(mockStreams[1].opts.body).toMatchObject({
      toolApprovalCapable: true,
      messages: [
        expect.objectContaining({
          approvalResponse: expect.objectContaining({ interactionId: 'approval-1' })
        })
      ]
    });
    await fail(
      mockStreams[1],
      new SseHttpError('busy', 503, { code: 'CHAT_STORAGE_UNAVAILABLE', detail: 'down' })
    );
    const card = result.current.messages.find(m => m.toolApproval?.interactionId === 'approval-1');
    expect(card.awaitingInput).toBe(true);
    expect(card.toolApproval.decision).toBeUndefined();
  });

  test('Stop is sent while the POST is still open, and later frames are not drawn', async () => {
    const { result } = render();
    send(result);
    const stream = mockStreams[0];
    await open(stream);
    const frames = answerFrames(lastAssistant(result).id);
    await play(stream, frames[0], frames[1], frames[2]);
    let abortedAtStop = null;
    mockApi.stopAppChatStream.mockImplementationOnce(async () => {
      // The server gets the stop before this connection closes, and what the
      // turn still sends meanwhile is not drawn.
      abortedAtStop = stream.opts.signal.aborted;
      stream.opts.onEvent(
        'step/delta',
        envelope('step/delta', { step: 0, kind: 'text', content: ' more' }, RUN_ID, { rseq: 3 })
      );
    });
    await act(async () => {
      result.current.cancelGeneration();
    });
    expect(mockApi.stopAppChatStream).toHaveBeenCalledWith('acme', CHAT_ID, {
      source: 'stop-button'
    });
    expect(abortedAtStop).toBe(false);
    expect(lastAssistant(result).content).not.toContain('more');
    expect(stream.opts.signal.aborted).toBe(true);
    await end(stream);
    expect(result.current.processing).toBe(false);
  });

  test('a broken POST re-attaches to the turn and resumes after the replayed ledger', async () => {
    const { result } = render();
    send(result);
    const stream = mockStreams[0];
    await open(stream);
    const frames = answerFrames(lastAssistant(result).id, 'Partial');
    await play(stream, frames[0], frames[1], frames[2]);
    mockLedger.events = [
      { v: 2, seq: 1, runId: RUN_ID, ts: frames[1].ts, type: 'run/started', data: frames[1].data },
      {
        v: 2,
        seq: 4,
        runId: RUN_ID,
        ts: frames[1].ts,
        type: 'tool/started',
        data: { step: 0, callId: 'c1', toolId: 'search', name: 'search', execution: 'server' }
      }
    ];
    // The read breaks: the parser reports it and the request ends.
    await act(async () => {
      stream.opts.onEvent('error', { message: 'network' });
    });
    await end(stream);
    await flush();
    expect(mockStreams).toHaveLength(2);
    expect(mockStreams[1].url).toBe(
      `/api/apps/acme/chat/chat-1?resumeRun=${RUN_ID}&afterLedgerSeq=4`
    );
    expect(mockStreams[1].opts.method).toBeUndefined();
    // What was drawn is rebuilt, not kept: one answer bubble, no doubled text.
    const assistants = result.current.messages.filter(m => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).not.toContain('Partial');
    // The snapshot then puts the partial text back, once.
    await open(mockStreams[1]);
    await play(
      mockStreams[1],
      envelope('stream/connected', { runId: CHAT_ID, lastSeq: 0, protocol: 2 }, CHAT_ID),
      envelope('step/delta', { step: 0, kind: 'text', content: 'Partial' }),
      envelope('step/delta', { step: 0, kind: 'text', content: ' answer' }, RUN_ID, { rseq: 5 }),
      envelope('run/ended', { status: 'completed', finishReason: 'stop' })
    );
    expect(lastAssistant(result).content).toBe('Partial answer');
  });

  test('the chat counts as accepted as soon as the turn is (not when it ends)', async () => {
    const onMessageAccepted = jest.fn();
    const { result } = render({ onMessageAccepted });
    send(result);
    await open(mockStreams[0]);
    expect(onMessageAccepted).toHaveBeenCalledWith(CHAT_ID);
  });

  test('a read that breaks after the turn was accepted is a drop, not a refusal', async () => {
    const { result } = render();
    const { stream, frames } = await partialTurn(result);
    mockLedger.events = ledgerOf(frames[1]);
    // What the real parser does: report the broken read, then throw.
    await act(async () => {
      stream.opts.onEvent('error', { message: 'network' });
    });
    await fail(stream, new TypeError('network error'));
    await flush();
    expect(mockStreams).toHaveLength(2);
    expect(mockStreams[1].url).toContain(`resumeRun=${RUN_ID}`);
    expect(lastAssistant(result).content).not.toMatch(/Failed to generate/);
  });

  test('the server’s word on durability decides, not the surface’s ephemeral prop', async () => {
    // The server made the chat temporary on its own (an anonymous user).
    const kept = render();
    send(kept.result);
    const stream = mockStreams[0];
    await open(stream);
    const frames = answerFrames(lastAssistant(kept.result).id, 'Partial');
    await play(
      stream,
      envelope('stream/connected', { runId: CHAT_ID, lastSeq: 0, durable: false }, CHAT_ID),
      frames[1],
      frames[2]
    );
    mockLedger.events = ledgerOf(frames[1]);
    await end(stream);
    await flush();
    expect(mockStreams).toHaveLength(1);
    expect(lastAssistant(kept.result).content).toContain('The connection was lost');
    kept.unmount();

    // A surface that asked for a temporary chat in a chat the server keeps.
    mockStreams.length = 0;
    const temp = render({ ephemeral: true });
    send(temp.result);
    await open(mockStreams[0]);
    const frames2 = answerFrames(lastAssistant(temp.result).id, 'Partial');
    await play(
      mockStreams[0],
      envelope('stream/connected', { runId: CHAT_ID, lastSeq: 0, durable: true }, CHAT_ID),
      frames2[1],
      frames2[2]
    );
    mockLedger.events = ledgerOf(frames2[1]);
    await end(mockStreams[0]);
    await flush();
    expect(mockStreams).toHaveLength(2);
    expect(mockStreams[1].url).toContain(`resumeRun=${RUN_ID}`);
  });

  test('a resumed turn re-reads the stored transcript once it has settled', async () => {
    const { result } = render();
    const { stream, frames } = await partialTurn(result);
    mockLedger.events = ledgerOf(frames[1]);
    await end(stream);
    await flush();
    expect(mockStreams).toHaveLength(2);
    mockApi.fetchChat.mockResolvedValueOnce({
      chat: { id: CHAT_ID, status: 'active' },
      messages: [
        { id: 'u1', role: 'user', content: 'hi' },
        { id: 'a1', role: 'assistant', content: 'The stored answer', runId: RUN_ID }
      ]
    });
    await open(mockStreams[1]);
    await play(
      mockStreams[1],
      envelope('stream/connected', { runId: CHAT_ID, lastSeq: 0, protocol: 2 }, CHAT_ID),
      envelope('run/ended', { status: 'completed', finishReason: 'stop' })
    );
    await flush();
    expect(mockApi.fetchChat).toHaveBeenCalledWith(CHAT_ID);
    expect(lastAssistant(result).content).toBe('The stored answer');
  });

  describe('a POST lost before its answer may still have started the turn', () => {
    const running = { chat: { id: CHAT_ID, status: 'running', activeRunId: RUN_ID } };

    test.each([
      ['a 502 from the proxy', () => new SseHttpError('Bad Gateway', 502, null)],
      ['a 504 from the proxy', () => new SseHttpError('Gateway Timeout', 504, null)],
      ['a network failure', () => new TypeError('Failed to fetch')]
    ])('%s: a running turn is followed, not reported', async (_what, error) => {
      mockApi.fetchChat.mockResolvedValueOnce(running);
      mockLedger.events = [
        {
          v: 2,
          seq: 1,
          runId: RUN_ID,
          ts: new Date().toISOString(),
          type: 'run/started',
          data: { kind: 'chat', refs: { chatId: CHAT_ID } }
        }
      ];
      const onMessageAccepted = jest.fn();
      const { result } = render({ onMessageAccepted });
      send(result);
      await fail(mockStreams[0], error());
      await flush();
      await flush();
      expect(mockApi.fetchChat).toHaveBeenCalledWith(CHAT_ID);
      expect(mockStreams).toHaveLength(2);
      expect(mockStreams[1].url).toBe(
        `/api/apps/acme/chat/chat-1?resumeRun=${RUN_ID}&afterLedgerSeq=1`
      );
      expect(onMessageAccepted).toHaveBeenCalledWith(CHAT_ID);
      expect(result.current.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
      expect(lastAssistant(result).content).not.toMatch(/error|Failed/i);
      expect(result.current.processing).toBe(true);
      // Following a turn is reading it: the server is not told to stop.
      expect(mockApi.stopAppChatStream).not.toHaveBeenCalled();
    });

    test('a 502 with nothing running is reported as before', async () => {
      const { result } = render();
      send(result);
      await fail(mockStreams[0], new SseHttpError('Bad Gateway', 502, null));
      await flush();
      expect(mockApi.fetchChat).toHaveBeenCalledWith(CHAT_ID);
      expect(mockStreams).toHaveLength(1);
      expect(lastAssistant(result).content).toMatch(/server error|Failed to generate|Bad Gateway/i);
      expect(result.current.processing).toBe(false);
      expect(mockApi.stopAppChatStream).not.toHaveBeenCalled();
    });

    test('a refusal is not looked into', async () => {
      const { result } = render();
      send(result);
      await fail(mockStreams[0], new SseHttpError('raw', 500, { code: 'X', detail: 'raw' }));
      await flush();
      expect(mockApi.fetchChat).not.toHaveBeenCalled();
    });
  });

  test('a temporary chat keeps what was drawn when its POST breaks', async () => {
    const { result } = render({ ephemeral: true });
    const { stream } = await partialTurn(result);
    await end(stream);
    await flush();
    // The server stopped the turn: nothing to re-attach to.
    expect(mockStreams).toHaveLength(1);
    const assistants = result.current.messages.filter(m => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toContain('Partial');
    expect(assistants[0].content).toContain('The connection was lost');
    expect(result.current.processing).toBe(false);
  });

  test('a kept chat keeps what was drawn when the replay brings nothing', async () => {
    const { result } = render();
    const { stream } = await partialTurn(result);
    mockLedger.events = [];
    await end(stream);
    await flush();
    expect(mockStreams).toHaveLength(1);
    const assistants = result.current.messages.filter(m => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toContain('Partial');
    expect(assistants[0].content).toContain('The connection was lost');
    expect(result.current.processing).toBe(false);
  });

  test('a turn the server stopped because its client left keeps what was drawn', async () => {
    const { result } = render();
    const { stream, frames } = await partialTurn(result);
    mockLedger.events = [
      ...ledgerOf(frames[1]),
      {
        v: 2,
        seq: 5,
        runId: RUN_ID,
        ts: frames[1].ts,
        type: 'run/ended',
        data: {
          status: 'aborted',
          finishReason: 'cancelled',
          cause: { kind: 'client_disconnected' }
        }
      }
    ];
    await end(stream);
    await flush();
    expect(mockStreams).toHaveLength(1);
    const assistants = result.current.messages.filter(m => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toContain('Partial');
  });

  test('a silent POST counts as dropped after twice the heartbeat', async () => {
    jest.useFakeTimers();
    try {
      const { result } = render();
      const { stream, frames } = await partialTurn(result);
      mockLedger.events = ledgerOf(frames[1]);
      // The real transport ends when its signal aborts.
      stream.opts.signal.addEventListener('abort', () => stream.resolve());
      // A heartbeat comment keeps it alive.
      await act(async () => {
        jest.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS - 1000);
        stream.opts.onChunk();
        jest.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS - 1000);
      });
      expect(stream.opts.signal.aborted).toBe(false);
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(stream.opts.signal.aborted).toBe(true);
      jest.useRealTimers();
      await flush();
      await flush();
      expect(mockStreams).toHaveLength(2);
      expect(mockStreams[1].url).toContain(`resumeRun=${RUN_ID}`);
    } finally {
      jest.useRealTimers();
    }
  });

  // `tests/e2e-agents/long-turn.spec.js` proves in a browser that an answer
  // longer than this limit arrives on one connection. It cannot import the
  // limit, so its numbers are checked here: a raised limit must not leave that
  // proof running short of it.
  test('the end-to-end proof of a long answer runs past the idle limit', () => {
    const spec = fs.readFileSync(
      path.resolve(__dirname, '../../e2e-agents/long-turn.spec.js'),
      'utf8'
    );
    const slow = /const SLOW = \{ everyMs: (\d+), words: (\d+) \};/.exec(spec);
    expect(slow).not.toBeNull();
    const [everyMs, words] = [Number(slow[1]), Number(slow[2])];
    expect(everyMs * words).toBeGreaterThan(TURN_IDLE_TIMEOUT_MS);
    // Each word arrives well inside the limit: the answer is slow, not silent.
    expect(everyMs).toBeLessThan(TURN_IDLE_TIMEOUT_MS / 2);
    // The spec says "60 seconds" in its own checks.
    expect(TURN_IDLE_TIMEOUT_MS).toBe(60000);
  });

  test('a POST that closes while Stop is on its way is not re-attached', async () => {
    const { result } = render();
    const { stream, frames } = await partialTurn(result);
    mockLedger.events = ledgerOf(frames[1]);
    mockApi.stopAppChatStream.mockImplementationOnce(async () => {
      stream.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await act(async () => {
      result.current.cancelGeneration();
    });
    await flush();
    expect(mockStreams).toHaveLength(1);
  });

  test('a surface gone before its re-attach replay finished opens no GET', async () => {
    let releaseLedger;
    mockFetchLedger.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseLedger = () =>
            resolve({
              ok: true,
              json: async () => ({ items: mockLedger.events, nextCursor: null })
            });
        })
    );
    const { result, unmount } = render();
    const { stream, frames } = await partialTurn(result);
    mockLedger.events = ledgerOf(frames[1]);
    await end(stream);
    await flush();
    unmount();
    await act(async () => {
      releaseLedger();
    });
    await flush();
    expect(mockStreams).toHaveLength(1);
  });

  describe('refusals read like the JSON path’s', () => {
    test('401 expires the session and says so', async () => {
      localStorage.setItem('authToken', 'stale');
      const expired = jest.fn();
      window.addEventListener('authTokenExpired', expired);
      try {
        const { result } = render();
        send(result);
        await fail(
          mockStreams[0],
          new SseHttpError('Authentication required', 401, {
            code: 'UNAUTHORIZED',
            detail: 'Authentication required'
          })
        );
        expect(expired).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('authToken')).toBeNull();
        expect(lastAssistant(result).content).toMatch(/Your session has expired/);
      } finally {
        window.removeEventListener('authTokenExpired', expired);
      }
    });

    test('401 of a host with its own sign-in leaves the main app’s session alone', async () => {
      localStorage.setItem('authToken', 'main-app');
      const expired = jest.fn();
      window.addEventListener('authTokenExpired', expired);
      setSseAuthProvider({ getToken: () => 'office', onUnauthorized: async () => false });
      try {
        const { result } = render();
        send(result);
        await fail(
          mockStreams[0],
          new SseHttpError('Authentication required', 401, { code: 'UNAUTHORIZED' })
        );
        expect(expired).not.toHaveBeenCalled();
        expect(localStorage.getItem('authToken')).toBe('main-app');
      } finally {
        setSseAuthProvider(null);
        window.removeEventListener('authTokenExpired', expired);
      }
    });

    test.each([
      [403, /You do not have permission/],
      [404, /The requested resource was not found/],
      [500, /A server error occurred/]
    ])('%s shows the friendly text, not the server detail', async (status, text) => {
      const { result } = render();
      send(result);
      await fail(
        mockStreams[0],
        new SseHttpError('raw', status, { code: 'X', detail: 'raw server detail' })
      );
      expect(lastAssistant(result).content).toMatch(text);
      expect(lastAssistant(result).content).not.toContain('raw server detail');
    });

    test('a request that never reached the server does not say "Failed to fetch"', async () => {
      const { result } = render();
      send(result);
      await fail(mockStreams[0], new TypeError('Failed to fetch'));
      expect(lastAssistant(result).content).not.toContain('Failed to fetch');
      expect(lastAssistant(result).content).toMatch(/Failed to generate response/);
    });
  });

  test('an @workflow mention answered with JSON follows the GET', async () => {
    const { result } = render();
    send(result, '@summarize this');
    await end(mockStreams[0], { status: 'streaming', chatId: CHAT_ID });
    expect(mockStreams).toHaveLength(2);
    expect(mockStreams[1].url).toBe('/api/apps/acme/chat/chat-1');
    expect(mockStreams[1].opts.method).toBeUndefined();
    // Its stream/connected does not post the message a second time.
    await play(
      mockStreams[1],
      envelope('stream/connected', { runId: CHAT_ID, lastSeq: 0, protocol: 2 }, CHAT_ID)
    );
    expect(mockApi.sendAppChatMessage).not.toHaveBeenCalled();
  });
});
