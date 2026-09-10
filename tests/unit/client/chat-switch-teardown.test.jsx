import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';

/**
 * Leaving a chat while it is still streaming.
 *
 * `/apps/:appId/c/:chatId` made `chatId` reactive: opening another chat from
 * the sidebar swaps it on a surface that stays mounted, so `useEventSource`'s
 * teardown now runs on a plain chat switch and not only on unmount. Two things
 * follow from that, and both are pinned here.
 *
 * 1. The teardown must not tell the server to stop. `POST …/stop` is built to
 *    reach a turn whose client is gone — the very turn durable chats promise
 *    will finish — so cancelling it because the user looked at another chat
 *    throws away the answer they are waiting for.
 * 2. The turn has to be torn down *locally*, or the composer of the chat they
 *    just opened stays disabled behind a Stop button and a queued message
 *    would be posted into the wrong chat.
 *
 * A real unmount used to be the exception: it stopped the turn whatever the
 * chat was. For a durable chat that is the same mistake with a different
 * trigger, and it was reported from real use — close the tab on a running
 * turn, come back, and the chat holds an empty assistant message with an
 * ABORTED error where the answer should be. Unmount therefore stops an
 * ephemeral turn (leaving the page must not bill a generation nobody will
 * read) and leaves a durable one running.
 *
 * The real `useAppChat` and the real `useEventSource` run; only the HTTP
 * transport underneath them is stubbed.
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

// A stream that opens and then simply never ends, the way a long answer looks
// while it is being generated. `openSseStream` resolves when the connection is
// aborted, which is what the real transport does for an AbortError.
const mockOpenCalls = [];
jest.mock('../../../client/src/shared/utils/openSseStream', () => {
  const actual = jest.requireActual('../../../client/src/shared/utils/openSseStream');
  return {
    __esModule: true,
    ...actual,
    openSseStream: jest.fn((url, { signal, onOpen, onEvent }) => {
      mockOpenCalls.push(url);
      onOpen?.();
      // The frame that tells `useAppChat` the connection is live and the
      // queued body may go out.
      onEvent?.('stream/connected', {
        v: 2,
        seq: 1,
        runId: null,
        ts: new Date(0).toISOString(),
        type: 'stream/connected',
        data: { protocol: 2, lastSeq: 0 }
      });
      return new Promise(resolve => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
        return undefined;
      });
    })
  };
});

const useAppChat = require('../../../client/src/features/chat/hooks/useAppChat').default;
const { sendAppChatMessage, stopAppChatStream } = require('../../../client/src/api');

/** Start a turn and let the stubbed transport connect. */
async function startTurn(result, content) {
  await act(async () => {
    result.current.sendMessage({
      displayMessage: content,
      apiMessage: { content },
      params: { modelId: 'model-x' }
    });
  });
}

beforeEach(() => {
  mockOpenCalls.length = 0;
  sessionStorage.clear();
  sendAppChatMessage.mockClear();
  stopAppChatStream.mockClear();
});

test('opening another chat mid-stream leaves the durable run alone', async () => {
  const { result, rerender } = renderHook(
    ({ chatId }) => useAppChat({ appId: 'acme', chatId, serverBacked: true }),
    { initialProps: { chatId: 'chat-aaa' } }
  );

  await startTurn(result, 'a long question');
  expect(result.current.processing).toBe(true);
  expect(mockOpenCalls).toEqual(['/api/apps/acme/chat/chat-aaa']);

  await act(async () => {
    rerender({ chatId: 'chat-bbb' });
  });

  // The server-side turn keeps running: nothing asked it to stop.
  expect(stopAppChatStream).not.toHaveBeenCalled();
});

test('…and releases the composer of the chat that was just opened', async () => {
  const { result, rerender } = renderHook(
    ({ chatId }) => useAppChat({ appId: 'acme', chatId, serverBacked: true }),
    { initialProps: { chatId: 'chat-aaa' } }
  );

  await startTurn(result, 'a long question');
  expect(result.current.processing).toBe(true);

  await act(async () => {
    rerender({ chatId: 'chat-bbb' });
  });

  expect(result.current.processing).toBe(false);
  expect(result.current.messages).toEqual([]);
});

test('a turn queued but never connected is not posted into the chat that replaced it', async () => {
  // `sendMessage` queues the body and posts it when the stream reports itself
  // connected. A chat switch in between must drop the queue, or chat B's
  // stream would deliver chat A's message.
  const { result, rerender } = renderHook(
    ({ chatId }) => useAppChat({ appId: 'acme', chatId, serverBacked: true }),
    { initialProps: { chatId: 'chat-aaa' } }
  );

  await startTurn(result, 'meant for A');
  sendAppChatMessage.mockClear();

  await act(async () => {
    rerender({ chatId: 'chat-bbb' });
  });
  await startTurn(result, 'meant for B');

  expect(sendAppChatMessage).toHaveBeenCalledTimes(1);
  const [, chatId, messages] = sendAppChatMessage.mock.calls[0];
  expect(chatId).toBe('chat-bbb');
  expect(messages[0].content).toBe('meant for B');
});

test('unmounting an ephemeral chat still stops the stream', async () => {
  // Nothing stores this turn, so leaving the surface for good is the last
  // chance to stop a generation that no one will ever read.
  const { result, unmount } = renderHook(() =>
    useAppChat({ appId: 'acme', chatId: 'chat-ccc', serverBacked: false })
  );

  await startTurn(result, 'a question');

  await act(async () => {
    unmount();
  });

  expect(stopAppChatStream).toHaveBeenCalledWith('acme', 'chat-ccc');
});

test('unmounting a durable chat leaves the turn running', async () => {
  // The whole promise of a durable chat is that closing the tab does not cost
  // you the answer. `POST …/stop` aborts unconditionally — it has to, so the
  // Stop button works on a turn whose client is gone — so sending it here
  // stored an empty assistant message with an ABORTED error instead.
  const { result, unmount } = renderHook(() =>
    useAppChat({ appId: 'acme', chatId: 'chat-ddd', serverBacked: true })
  );

  await startTurn(result, 'a question');

  await act(async () => {
    unmount();
  });

  expect(stopAppChatStream).not.toHaveBeenCalled();
});
