import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';

/**
 * Opening a stored chat.
 *
 * A server-backed chat keeps no browser copy, so `GET /api/chats/:id` is the
 * only thing that puts a past conversation back on screen — and it arrives a
 * network round trip after the first paint. Three things have to be true for
 * that to look like opening a chat rather than starting one:
 *
 *   1. the sessionStorage transcript is not read (it is a stale shadow of the
 *      store, and would sit above the hydrated history as a second copy),
 *   2. an empty transcript reads as "still loading", not as "new chat" — the
 *      greeting and the starter prompts must never flash before the history
 *      lands (`renderStartupState` in AppChat.jsx gates on `hydrating`),
 *   3. the stored ids are adopted, because `replaceFromMessageId` addresses
 *      the server's history by them and a locally minted `user-<ts>-<rand>`
 *      means nothing to the store.
 *
 * The real hooks are exercised; only the two modules that read `import.meta`
 * and the SSE transport are stubbed.
 */

jest.mock('uuid', () => ({
  __esModule: true,
  v4: () => '00000000-0000-0000-0000-000000000000'
}));

jest.mock('../../../client/src/shared/hooks/useEventSource', () => ({
  __esModule: true,
  default: () => ({ initEventSource: jest.fn(), cleanupEventSource: jest.fn() })
}));

jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  sendAppChatMessage: jest.fn().mockResolvedValue({})
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

const useChatMessages = require('../../../client/src/features/chat/hooks/useChatMessages').default;
const useAppChat = require('../../../client/src/features/chat/hooks/useAppChat').default;

const storageKey = chatId => `ai_hub_chat_messages_${chatId}`;

/** A transcript left in this tab by the pre-persistence behaviour. */
const LOCAL_COPY = [
  { id: 'local-1', role: 'user', content: 'stale question' },
  { id: 'local-2', role: 'assistant', content: 'stale answer' }
];

/** What `GET /api/chats/:id` returns. */
const STORED = [
  {
    id: 'srv-1',
    role: 'user',
    content: 'stored question',
    ts: '2026-03-15T09:00:00.000Z',
    runId: 'run-1'
  },
  {
    id: 'srv-2',
    role: 'assistant',
    content: 'stored answer',
    ts: '2026-03-15T09:00:04.000Z',
    runId: 'run-1',
    usage: { totalTokens: 42 }
  }
];

function seedLocalCopy(chatId, messages = LOCAL_COPY) {
  sessionStorage.setItem(storageKey(chatId), JSON.stringify(messages));
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('useChatMessages in server-backed mode', () => {
  test('starts hydrating with nothing on screen, ignoring the browser copy', () => {
    seedLocalCopy('chat-open');
    const { result } = renderHook(() => useChatMessages('chat-open', { serverBacked: true }));

    expect(result.current.hydrating).toBe(true);
    expect(result.current.messages).toEqual([]);
  });

  test('the stored transcript replaces local state and its ids are adopted', () => {
    seedLocalCopy('chat-open');
    const { result } = renderHook(() => useChatMessages('chat-open', { serverBacked: true }));

    act(() => {
      result.current.loadServerMessages(STORED);
    });

    expect(result.current.hydrating).toBe(false);
    expect(result.current.messages.map(m => m.id)).toEqual(['srv-1', 'srv-2']);
    // Kept a second time, so an edit can address the stored history by it even
    // after the message has been through the UI.
    expect(result.current.messages.map(m => m.serverId)).toEqual(['srv-1', 'srv-2']);
    expect(result.current.messages[0]).toMatchObject({
      role: 'user',
      content: 'stored question',
      loading: false,
      fromServer: true,
      ts: '2026-03-15T09:00:00.000Z',
      runId: 'run-1'
    });
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'stored answer',
      usage: { totalTokens: 42 }
    });
  });

  test('a stopped turn comes back cancelled, a failed one errored', () => {
    const { result } = renderHook(() => useChatMessages('chat-errors', { serverBacked: true }));

    act(() => {
      result.current.loadServerMessages([
        { id: 'srv-1', role: 'assistant', content: 'half an ', error: { code: 'ABORTED' } },
        { id: 'srv-2', role: 'assistant', content: '', error: { code: 'PROVIDER_ERROR' } }
      ]);
    });

    expect(result.current.messages[0]).toMatchObject({ cancelled: true });
    expect(result.current.messages[0].error).toBeUndefined();
    expect(result.current.messages[1]).toMatchObject({ error: true });
  });

  test('the hydrated transcript is not written back over the browser copy', () => {
    seedLocalCopy('chat-open');
    const before = sessionStorage.getItem(storageKey('chat-open'));
    const { result } = renderHook(() => useChatMessages('chat-open', { serverBacked: true }));

    act(() => {
      result.current.loadServerMessages(STORED);
    });

    // The store is the source of truth; a second copy here would go stale the
    // moment another tab appended a turn.
    expect(sessionStorage.getItem(storageKey('chat-open'))).toBe(before);
  });

  test('a chat with no stored transcript still finishes hydrating', () => {
    const { result } = renderHook(() => useChatMessages('chat-new', { serverBacked: true }));

    act(() => {
      result.current.loadServerMessages([]);
    });

    expect(result.current.hydrating).toBe(false);
    expect(result.current.messages).toEqual([]);
  });

  test('a chat the store has never heard of finishes hydrating too', () => {
    // The 404 an unsent chat id gets is the ordinary case, not a failure.
    const { result } = renderHook(() => useChatMessages('chat-404', { serverBacked: true }));

    act(() => {
      result.current.finishHydration();
    });

    expect(result.current.hydrating).toBe(false);
  });

  test('opening another chat clears the transcript and hydrates again', () => {
    const { result, rerender } = renderHook(
      ({ chatId }) => useChatMessages(chatId, { serverBacked: true }),
      { initialProps: { chatId: 'chat-one' } }
    );
    act(() => {
      result.current.loadServerMessages(STORED);
    });
    expect(result.current.hydrating).toBe(false);

    rerender({ chatId: 'chat-two' });

    expect(result.current.messages).toEqual([]);
    expect(result.current.hydrating).toBe(true);
  });

  test('becoming server-backed after the platform config resolves drops the browser copy', () => {
    seedLocalCopy('chat-late');
    const { result, rerender } = renderHook(
      ({ serverBacked }) => useChatMessages('chat-late', { serverBacked }),
      { initialProps: { serverBacked: false } }
    );
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.hydrating).toBe(false);

    rerender({ serverBacked: true });

    expect(result.current.messages).toEqual([]);
    expect(result.current.hydrating).toBe(true);
  });

  test('leaving incognito keeps the conversation that is on screen', () => {
    // `serverBacked` is `persistence && !ephemeral`, and incognito is a live
    // toggle: turning it off is the same false→true transition as the
    // capability resolving. But there is no stale browser copy to discard in
    // that case — the messages on screen are the only copy — so clearing them
    // would blank the chat the user is in, permanently (the hydration guard
    // in AppChat has already been latched for this chat).
    const { result, rerender } = renderHook(
      ({ ephemeral }) =>
        useChatMessages('chat-incognito-off', { serverBacked: !ephemeral, ephemeral }),
      { initialProps: { ephemeral: false } }
    );
    act(() => {
      result.current.loadServerMessages(STORED);
    });
    expect(result.current.messages).toHaveLength(2);

    // Incognito on: nothing is stored, but what is on screen stays.
    rerender({ ephemeral: true });
    act(() => {
      result.current.addUserMessage('something private');
    });
    expect(result.current.messages).toHaveLength(3);

    // …and off again.
    rerender({ ephemeral: false });

    expect(result.current.messages.map(m => m.content)).toEqual([
      'stored question',
      'stored answer',
      'something private'
    ]);
    expect(result.current.hydrating).toBe(false);
  });

  test('a turn started during the hydrate is kept, with the stored history in front', () => {
    // The fetch and the composer race: an auto-send from the start page, or a
    // user typing behind the spinner, adds a turn while the round trip is out.
    // Replacing would drop that turn from the screen while the server keeps
    // appending to it, and the two transcripts diverge from there.
    const { result } = renderHook(() => useChatMessages('chat-race', { serverBacked: true }));

    act(() => {
      result.current.addUserMessage('sent while loading');
      result.current.addAssistantMessage('pending-1');
    });

    act(() => {
      result.current.loadServerMessages(STORED, { preserveLocal: true });
    });

    expect(result.current.messages.map(m => m.content)).toEqual([
      'stored question',
      'stored answer',
      'sent while loading',
      ''
    ]);
    expect(result.current.hydrating).toBe(false);
  });

  test('without preserveLocal the stored transcript still replaces everything', () => {
    const { result } = renderHook(() => useChatMessages('chat-replace', { serverBacked: true }));
    act(() => {
      result.current.addUserMessage('local only');
    });

    act(() => {
      result.current.loadServerMessages(STORED);
    });

    expect(result.current.messages.map(m => m.id)).toEqual(['srv-1', 'srv-2']);
  });

  test('the very frame a chat becomes server-backed already reports hydrating', () => {
    // `hydrated` is reset in an effect, and React runs effects after the
    // render that scheduled them has painted. Read from that state alone,
    // `hydrating` would still be false for the one frame between "this chat
    // is server-backed" and "so start hydrating it" — which is a settled,
    // empty transcript on screen, i.e. the greeting flash, for a frame.
    // `renderHook`'s `rerender` flushes effects before it returns, so only a
    // per-render recording can see it.
    seedLocalCopy('chat-flip-frame');
    const frames = [];
    const { rerender } = renderHook(
      ({ serverBacked }) => {
        const chat = useChatMessages('chat-flip-frame', { serverBacked });
        frames.push({ serverBacked, hydrating: chat.hydrating });
        return chat;
      },
      { initialProps: { serverBacked: false } }
    );

    frames.length = 0;
    rerender({ serverBacked: true });

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toEqual({ serverBacked: true, hydrating: true });
    expect(frames.every(frame => frame.hydrating)).toBe(true);
  });

  test('the very frame a chat switches to another chat already reports hydrating', () => {
    const frames = [];
    const { result, rerender } = renderHook(
      ({ chatId }) => {
        const chat = useChatMessages(chatId, { serverBacked: true });
        frames.push({ chatId, hydrating: chat.hydrating });
        return chat;
      },
      { initialProps: { chatId: 'chat-frame-one' } }
    );
    act(() => {
      result.current.loadServerMessages(STORED);
    });
    expect(result.current.hydrating).toBe(false);

    frames.length = 0;
    rerender({ chatId: 'chat-frame-two' });

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toEqual({ chatId: 'chat-frame-two', hydrating: true });
    expect(frames.every(frame => frame.hydrating)).toBe(true);
  });
});

describe('the modes that are not server-backed', () => {
  test('an ordinary chat still restores its transcript from the browser and never hydrates', () => {
    seedLocalCopy('chat-plain');
    const { result } = renderHook(() => useChatMessages('chat-plain'));

    expect(result.current.hydrating).toBe(false);
    expect(result.current.messages.map(m => m.id)).toEqual(['local-1', 'local-2']);
  });

  test('an ephemeral chat starts empty and never hydrates', () => {
    seedLocalCopy('chat-incognito');
    const { result } = renderHook(() => useChatMessages('chat-incognito', { ephemeral: true }));

    expect(result.current.hydrating).toBe(false);
    expect(result.current.messages).toEqual([]);
  });
});

test('no render between mount and hydration shows an empty, settled chat', async () => {
  seedLocalCopy('chat-flash');
  // `renderStartupState` shows the greeting and the starter prompts when the
  // transcript is empty and nothing is loading. A frame in that state before
  // the history lands is the flash this whole mode exists to avoid, so record
  // every frame and assert none of them is one.
  const frames = [];
  const { result } = renderHook(() => {
    const chat = useAppChat({ appId: 'app1', chatId: 'chat-flash', serverBacked: true });
    frames.push({ count: chat.messages.length, hydrating: chat.hydrating });
    return chat;
  });

  // The fetch AppChat fires resolves a round trip later, never synchronously.
  await act(async () => {
    const response = await Promise.resolve({ messages: STORED });
    result.current.loadServerMessages(response.messages);
  });

  expect(frames.length).toBeGreaterThan(1);
  expect(frames.filter(frame => frame.count === 0 && !frame.hydrating)).toEqual([]);
  expect(frames[frames.length - 1]).toEqual({ count: 2, hydrating: false });
  expect(result.current.messages.map(m => m.id)).toEqual(['srv-1', 'srv-2']);
});
