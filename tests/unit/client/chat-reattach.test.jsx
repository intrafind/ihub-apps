import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';

/**
 * Re-attaching to a turn that is still running when the chat is reopened.
 *
 * A durable chat's turn outlives the browser that started it. Reopening the
 * chat used to show the stored transcript — the question, and nothing after
 * it — and then sit there: the stream was never connected, so no frame could
 * arrive, and the partial answer already in the run ledger was never asked
 * for. The chat looked stuck until the turn ended and the page was loaded a
 * second time.
 *
 * `reattachToRun` replays the ledger through the same `handleEvent` the live
 * stream uses, then connects. Both halves are pinned here, along with the
 * `onSettled` callback the caller needs to re-read the store once the turn
 * finishes.
 */

jest.mock('uuid', () => ({
  __esModule: true,
  v4: () => '00000000-0000-0000-0000-000000000000'
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, def) => def || key })
}));

jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`
}));

jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  sendAppChatMessage: jest.fn().mockResolvedValue({}),
  stopAppChatStream: jest.fn().mockResolvedValue({}),
  checkAppChatStatus: jest.fn().mockResolvedValue({ active: true })
}));

const mockOpenCalls = [];
const mockEmitters = [];
const ledgerPages = [];
jest.mock('../../../client/src/shared/utils/openSseStream', () => {
  const actual = jest.requireActual('../../../client/src/shared/utils/openSseStream');
  return {
    __esModule: true,
    ...actual,
    openSseStream: jest.fn((url, { signal, onOpen, onEvent }) => {
      mockOpenCalls.push(url);
      mockEmitters.push(onEvent);
      onOpen?.();
      return new Promise(resolve => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
        return undefined;
      });
    }),
    fetchWithAuthRetry: jest.fn(async () => ({
      ok: true,
      json: async () => ledgerPages.shift() || { events: [], lastSeq: 0, nextAfter: 0 }
    }))
  };
});

const useAppChat = require('../../../client/src/features/chat/hooks/useAppChat').default;
const { fetchWithAuthRetry } = require('../../../client/src/shared/utils/openSseStream');

const RUN_ID = 'chat-run-77';

/** An SSE v2 envelope as the ledger projection returns it. */
const envelope = (seq, type, data = {}) => ({
  v: 2,
  seq,
  runId: RUN_ID,
  ts: new Date(seq * 1000).toISOString(),
  type,
  data
});

/** A ledger page holding `events`, with the paging cursors the walk needs. */
const page = events => ({
  events,
  lastSeq: events.length ? events[events.length - 1].seq : 0,
  nextAfter: events.length ? events[events.length - 1].seq : 0
});

beforeEach(() => {
  mockOpenCalls.length = 0;
  mockEmitters.length = 0;
  ledgerPages.length = 0;
  sessionStorage.clear();
  fetchWithAuthRetry.mockClear();
});

test('replays what the ledger already holds, then follows the stream', async () => {
  ledgerPages.push(
    page([
      envelope(1, 'run/started', { kind: 'chat', refs: {} }),
      envelope(2, 'step/delta', { step: 0, kind: 'text', content: 'Searching' }),
      envelope(3, 'step/delta', { step: 0, kind: 'text', content: ' the web…' })
    ])
  );

  const { result } = renderHook(() =>
    useAppChat({ appId: 'acme', chatId: 'chat-abc', serverBacked: true })
  );

  let attached;
  await act(async () => {
    attached = await result.current.reattachToRun(RUN_ID);
  });

  expect(attached).toBe(true);
  // The partial answer is on screen, not a blank bubble.
  const assistant = result.current.messages.filter(m => m.role === 'assistant');
  expect(assistant).toHaveLength(1);
  expect(assistant[0].content).toBe('Searching the web…');
  expect(result.current.processing).toBe(true);
  // And the surface is now following the live stream for the rest of it.
  expect(mockOpenCalls).toEqual(['/api/apps/acme/chat/chat-abc']);
});

test('does not attach to a run that already ended, and settles instead', async () => {
  ledgerPages.push(
    page([
      envelope(1, 'run/started', { kind: 'chat', refs: {} }),
      envelope(2, 'step/delta', { step: 0, kind: 'text', content: 'done already' }),
      envelope(3, 'run/ended', { status: 'completed', finishReason: 'stop' })
    ])
  );

  const { result } = renderHook(() =>
    useAppChat({ appId: 'acme', chatId: 'chat-abc', serverBacked: true })
  );

  const onSettled = jest.fn();
  let attached;
  await act(async () => {
    attached = await result.current.reattachToRun(RUN_ID, { onSettled });
  });

  expect(attached).toBe(false);
  // Opening a stream for a finished run would leave the composer behind a
  // Stop button until the connection timed out.
  expect(mockOpenCalls).toEqual([]);
  expect(onSettled).toHaveBeenCalledTimes(1);
  expect(result.current.processing).toBe(false);
});

test('a live run/ended on the attached run settles it', async () => {
  // The live half of the reattach had no test at all: the suite's stream mock
  // never delivered an event, so no terminal frame ever reached `handleEvent`
  // and both `settleReattachedRun` calls could be deleted with every test
  // still passing.
  ledgerPages.push(
    page([
      envelope(1, 'run/started', { kind: 'chat', refs: {} }),
      envelope(2, 'step/delta', { step: 0, kind: 'text', content: 'still going' })
    ])
  );

  const { result } = renderHook(() =>
    useAppChat({ appId: 'acme', chatId: 'chat-abc', serverBacked: true })
  );

  const onSettled = jest.fn();
  await act(async () => {
    await result.current.reattachToRun(RUN_ID, { onSettled });
  });
  expect(onSettled).not.toHaveBeenCalled();

  const emit = mockEmitters[mockEmitters.length - 1];
  await act(async () => {
    emit('run/ended', envelope(3, 'run/ended', { status: 'completed', finishReason: 'stop' }));
  });

  expect(onSettled).toHaveBeenCalledTimes(1);
  expect(result.current.processing).toBe(false);
});

test('another run ending in the same chat does not settle the attached one', async () => {
  // A chat can have several runs in flight — a workflow child, a superseded
  // turn — and only the one this surface attached to means the store is worth
  // re-reading.
  ledgerPages.push(
    page([
      envelope(1, 'run/started', { kind: 'chat', refs: {} }),
      envelope(2, 'step/delta', { step: 0, kind: 'text', content: 'still going' })
    ])
  );

  const { result } = renderHook(() =>
    useAppChat({ appId: 'acme', chatId: 'chat-abc', serverBacked: true })
  );

  const onSettled = jest.fn();
  await act(async () => {
    await result.current.reattachToRun(RUN_ID, { onSettled });
  });

  const emit = mockEmitters[mockEmitters.length - 1];
  await act(async () => {
    emit('run/ended', {
      v: 2,
      seq: 3,
      runId: 'some-other-run',
      ts: new Date(3000).toISOString(),
      type: 'run/ended',
      data: { status: 'completed', finishReason: 'stop' }
    });
  });

  expect(onSettled).not.toHaveBeenCalled();
});

test('a stream that drops settles the attached run rather than latching it forever', async () => {
  // The turn being re-attached to outlived the browser that started it, so the
  // connection dropping or timing out is its ordinary ending. A stream-level
  // error stamps the *chat* id as its runId, so nothing could ever match it
  // against the attached run: the attachment stayed latched, the caller never
  // re-read the store, and the chat kept a partial projection and a running
  // badge until a reload.
  ledgerPages.push(
    page([
      envelope(1, 'run/started', { kind: 'chat', refs: {} }),
      envelope(2, 'step/delta', { step: 0, kind: 'text', content: 'half an answer' })
    ])
  );

  const { result } = renderHook(() =>
    useAppChat({ appId: 'acme', chatId: 'chat-abc', serverBacked: true })
  );

  const onSettled = jest.fn();
  await act(async () => {
    await result.current.reattachToRun(RUN_ID, { onSettled });
  });

  const emit = mockEmitters[mockEmitters.length - 1];
  await act(async () => {
    emit('stream/error', {
      v: 2,
      seq: 0,
      // What `syntheticStreamError` stamps: the stream id, which is the chat.
      runId: 'chat-abc',
      ts: new Date(0).toISOString(),
      type: 'stream/error',
      data: { message: 'connection lost' }
    });
  });

  expect(onSettled).toHaveBeenCalledTimes(1);
  expect(result.current.processing).toBe(false);
});

test('a replayed run/ended does not report the previous chat s prompt', async () => {
  // The replay runs through the *live* `handleEvent`, so a `run/ended` in it
  // reaches `onMessageComplete(content, lastUserMessage)` exactly as a live one
  // does. That reference used to survive a chat switch, so reopening a chat
  // whose turn had already finished fired the callback with this chat's answer
  // under the *previous* chat's question — enough, on a canvas-enabled app, to
  // navigate the user out of the chat they just opened.
  ledgerPages.push(
    page([
      envelope(1, 'run/started', { kind: 'chat', refs: {} }),
      envelope(2, 'step/delta', { step: 0, kind: 'text', content: 'the answer for chat B' }),
      envelope(3, 'run/ended', { status: 'completed', finishReason: 'stop' })
    ])
  );

  const completed = [];
  const { result, rerender } = renderHook(
    ({ chatId }) =>
      useAppChat({
        appId: 'acme',
        chatId,
        serverBacked: true,
        onMessageComplete: (content, prompt) => completed.push({ content, prompt })
      }),
    { initialProps: { chatId: 'chat-a' } }
  );

  // A turn in chat A, then the user opens chat B without answering anything in
  // it — the ordinary "come back to a chat that finished while I was away".
  await act(async () => {
    result.current.sendMessage({
      displayMessage: 'the question I asked in chat A',
      apiMessage: { content: 'the question I asked in chat A' },
      params: { modelId: 'model-x' }
    });
  });
  await act(async () => {
    rerender({ chatId: 'chat-b' });
  });

  await act(async () => {
    await result.current.reattachToRun(RUN_ID);
  });

  for (const call of completed) {
    expect(call.prompt).not.toBe('the question I asked in chat A');
  }
});

test('a ledger that cannot be read still connects rather than giving up', async () => {
  fetchWithAuthRetry.mockImplementationOnce(async () => ({ ok: false, status: 503 }));

  const { result } = renderHook(() =>
    useAppChat({ appId: 'acme', chatId: 'chat-abc', serverBacked: true })
  );

  let attached;
  await act(async () => {
    attached = await result.current.reattachToRun(RUN_ID);
  });

  // Without the replay the surface misses what already happened, but the rest
  // of the answer is still worth having — and it is what the store will hold.
  expect(attached).toBe(true);
  expect(mockOpenCalls).toEqual(['/api/apps/acme/chat/chat-abc']);
});

test('reattaching to nothing is a no-op', async () => {
  const { result } = renderHook(() =>
    useAppChat({ appId: 'acme', chatId: 'chat-abc', serverBacked: true })
  );

  let attached;
  await act(async () => {
    attached = await result.current.reattachToRun(null);
  });

  expect(attached).toBe(false);
  expect(fetchWithAuthRetry).not.toHaveBeenCalled();
  expect(mockOpenCalls).toEqual([]);
});
