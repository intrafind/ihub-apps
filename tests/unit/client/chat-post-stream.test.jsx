// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
  stopAppChatStream: jest.fn().mockResolvedValue({})
};
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  sendAppChatMessage: (...args) => mockApi.sendAppChatMessage(...args),
  checkAppChatStatus: (...args) => mockApi.checkAppChatStatus(...args),
  stopAppChatStream: (...args) => mockApi.stopAppChatStream(...args)
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

const { SseHttpError } = jest.requireActual('../../../client/src/shared/utils/openSseStream');
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
  Object.values(mockApi).forEach(fn => fn.mockClear());
});

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
