import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';

/**
 * The chat protocol — one for every surface.
 *
 * Every chat is stored, so the server owns every history: it reads the
 * transcript back out of the store and rejects a request carrying more than
 * the new message with `CLIENT_HISTORY_NOT_ALLOWED`
 * (`server/routes/chat/sessionRoutes.js`). A chat the user does not want kept —
 * the incognito toggle, the compare panels, the canvas — posts the same one
 * message, flagged `ephemeral` so the server creates it as a temporary chat.
 *
 * An edit or a regenerate used to travel as a shortened array. With the server
 * holding the history that intent has to be said out loud, so the same
 * gestures now carry `replaceFromMessageId` — the *stored* id of the message
 * the fork starts at.
 *
 * Everything below runs the real `useChatMessages` / `useAppChat`; the only
 * stubs are the transport and the two modules that read `import.meta`.
 */

// The client's `uuid` build is ESM-only and jest does not transform
// node_modules; stub it (used only for the fallback chat id).
jest.mock('uuid', () => ({
  __esModule: true,
  v4: () => '00000000-0000-0000-0000-000000000000'
}));

// Capture the SSE handler useAppChat wires into useEventSource and stub the
// transport, so nothing opens a connection and the test can decide when the
// stream reports itself connected — which is when the request is actually made.
let capturedOnEvent = null;
jest.mock('../../../client/src/shared/hooks/useEventSource', () => ({
  __esModule: true,
  default: ({ onEvent }) => {
    capturedOnEvent = onEvent;
    return { initEventSource: jest.fn(), detachEventSource: jest.fn(), stopEventSource: jest.fn() };
  }
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

const useAppChat = require('../../../client/src/features/chat/hooks/useAppChat').default;
const useChatMessages = require('../../../client/src/features/chat/hooks/useChatMessages').default;
const { sendAppChatMessage } = require('../../../client/src/api');

const stored = (id, role, content) => ({
  id,
  role,
  content,
  ts: '2026-03-15T09:00:00.000Z',
  runId: 'run-1'
});

const TRANSCRIPT = [
  stored('srv-1', 'user', 'first question'),
  stored('srv-2', 'assistant', 'first answer'),
  stored('srv-3', 'user', 'second question'),
  stored('srv-4', 'assistant', 'second answer')
];

let seq = 0;

/** Deliver one SSE v2 frame the way useEventSource does. */
async function deliver(type, data, runId) {
  seq += 1;
  const envelope = {
    v: 2,
    seq,
    runId,
    ts: new Date(1773561600000 + seq * 1000).toISOString(),
    type,
    data
  };
  await act(async () => {
    await capturedOnEvent({ type: envelope.type, envelope });
  });
}

/** Report the stream connected — the moment useAppChat posts the request. */
const connect = chatId =>
  deliver('stream/connected', { runId: chatId, lastSeq: 0, protocol: 2 }, chatId);

/** Queue one user turn. */
function send(result, content, options = {}) {
  act(() => {
    result.current.sendMessage({
      displayMessage: content,
      apiMessage: { content },
      params: { modelId: 'model-x' },
      ...options
    });
  });
}

/** The `(appId, chatId, messages, params)` of the nth request. */
function requestAt(index) {
  const [appId, chatId, messages, params] = sendAppChatMessage.mock.calls[index];
  return { appId, chatId, messages, params };
}

/** Put a stored transcript on screen the way hydration does. */
function hydrate(result, messages = TRANSCRIPT) {
  act(() => {
    result.current.loadServerMessages(messages);
  });
}

beforeEach(() => {
  capturedOnEvent = null;
  seq = 0;
  sessionStorage.clear();
  sendAppChatMessage.mockClear();
});

describe('getMessagesForApi', () => {
  test('sends only the new message, however long the transcript', () => {
    const { result } = renderHook(() => useChatMessages('chat-api'));
    act(() => {
      result.current.addUserMessage('first question');
      result.current.addAssistantMessage('a1');
    });
    expect(result.current.messages).toHaveLength(2);

    const body = result.current.getMessagesForApi({
      role: 'user',
      content: 'second question',
      rawContent: 'second question, as typed',
      mcpApps: [{ big: 'payload' }]
    });

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ role: 'user', content: 'second question, as typed' });
    expect(body[0].mcpApps).toBeUndefined();
  });

  test('keeps nothing in browser storage', () => {
    const { result } = renderHook(() => useChatMessages('chat-no-copy'));
    act(() => {
      result.current.addUserMessage('a question');
    });
    expect(sessionStorage.length).toBe(0);
  });
});

describe('the wire', () => {
  test('a turn posts exactly one message and is not flagged ephemeral', async () => {
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-backed' }));
    hydrate(result);
    expect(result.current.messages).toHaveLength(4);

    send(result, 'third question');
    await connect('chat-backed');

    const { appId, chatId, messages, params } = requestAt(0);
    expect(appId).toBe('app1');
    expect(chatId).toBe('chat-backed');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'third question' });
    expect(params.ephemeral).toBeUndefined();
    expect(params.replaceFromMessageId).toBeUndefined();
  });

  test('a second turn still posts one message', async () => {
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-backed-2' }));
    hydrate(result);

    send(result, 'third question');
    await connect('chat-backed-2');
    act(() => {
      result.current.updateAssistantMessage(
        result.current.messages[result.current.messages.length - 1].id,
        'third answer',
        false
      );
    });

    send(result, 'fourth question');
    await connect('chat-backed-2');

    expect(sendAppChatMessage).toHaveBeenCalledTimes(2);
    expect(requestAt(1).messages).toHaveLength(1);
    expect(requestAt(1).messages[0].content).toBe('fourth question');
  });

  test('an incognito chat posts one message too, and asks for a temporary chat', async () => {
    const { result } = renderHook(() =>
      useAppChat({ appId: 'app1', chatId: 'chat-incognito', ephemeral: true })
    );

    send(result, 'one');
    await connect('chat-incognito');
    act(() => {
      result.current.updateAssistantMessage(result.current.messages[1].id, 'answered', false);
    });
    send(result, 'two');
    await connect('chat-incognito');

    expect(requestAt(1).messages.map(m => m.content)).toEqual(['two']);
    expect(requestAt(1).params.ephemeral).toBe(true);
  });

  test('the clarification reply takes the same protocol as an ordinary send', async () => {
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-clarify' }));
    hydrate(result, [TRANSCRIPT[0], TRANSCRIPT[1]]);

    send(result, 'which one?');
    await connect('chat-clarify');
    const assistantId = result.current.messages[result.current.messages.length - 1].id;

    await deliver(
      'run/started',
      { kind: 'chat', refs: { chatId: 'chat-clarify', messageId: assistantId } },
      'run-clarify'
    );
    await deliver(
      'interaction/raised',
      {
        interaction: {
          id: 'q1',
          runId: 'run-clarify',
          kind: 'question',
          status: 'pending',
          prompt: { message: 'Red or blue?', inputType: 'text' }
        }
      },
      'run-clarify'
    );
    expect(result.current.clarificationPending).toBe(true);

    act(() => {
      result.current.submitClarificationResponse('blue', { modelId: 'model-x' });
    });
    await connect('chat-clarify');

    const { messages, params } = requestAt(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'blue' });
    expect(params.ephemeral).toBeUndefined();
  });
});

describe('replaceFromMessageId', () => {
  test('editing a stored message forks the stored history at that message', async () => {
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-edit' }));
    hydrate(result);

    act(() => {
      result.current.resendMessage('srv-3', 'second question, rephrased');
    });
    // The local transcript is truncated at the edited message, as it always was.
    expect(result.current.messages.map(m => m.id)).toEqual(['srv-1', 'srv-2']);

    send(result, 'second question, rephrased');
    await connect('chat-edit');

    const { messages, params } = requestAt(0);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('second question, rephrased');
    expect(params.replaceFromMessageId).toBe('srv-3');
  });

  test('regenerating an answer forks at the question that produced it', async () => {
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-regen' }));
    hydrate(result);

    let resend;
    act(() => {
      resend = result.current.resendMessage('srv-4');
    });
    expect(resend.content).toBe('second question');
    expect(result.current.messages.map(m => m.id)).toEqual(['srv-1', 'srv-2']);

    send(result, resend.content);
    await connect('chat-regen');

    expect(requestAt(0).params.replaceFromMessageId).toBe('srv-3');
  });

  test('deleting from a stored message forks there on the next send', async () => {
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-delete' }));
    hydrate(result);

    act(() => {
      result.current.deleteMessage('srv-3');
    });

    send(result, 'a different question');
    await connect('chat-delete');

    expect(requestAt(0).params.replaceFromMessageId).toBe('srv-3');
  });

  test('the fork is consumed by one request, not repeated by the next', async () => {
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-once' }));
    hydrate(result);

    act(() => {
      result.current.resendMessage('srv-3', 'rephrased');
    });
    send(result, 'rephrased');
    await connect('chat-once');
    act(() => {
      result.current.updateAssistantMessage(
        result.current.messages[result.current.messages.length - 1].id,
        'answer',
        false
      );
    });

    send(result, 'and one more');
    await connect('chat-once');

    expect(requestAt(0).params.replaceFromMessageId).toBe('srv-3');
    expect(requestAt(1).params.replaceFromMessageId).toBeUndefined();
  });

  test('editing a turn made in this session forks at the exchange id it was stored under', async () => {
    // The store mints its own ids and no stream frame reports them, so a turn
    // made in the session that is still open never learns one. It does know
    // the exchange id it sent, which the store filed as `clientMessageId` and
    // the fork lookup accepts. Without that, regenerating the answer you just
    // got would carry no fork id, and the server would append the retry to the
    // untouched history — a duplicated exchange per retry.
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-local' }));
    act(() => {
      result.current.loadServerMessages([]);
    });

    send(result, 'brand new question');
    await connect('chat-local');
    const exchangeId = requestAt(0).messages[0].messageId;
    expect(exchangeId).toBeTruthy();
    const localUserId = result.current.messages[0].id;
    expect(localUserId).not.toBe(exchangeId);

    act(() => {
      result.current.resendMessage(localUserId, 'brand new question, rephrased');
    });
    send(result, 'brand new question, rephrased');
    await connect('chat-local');

    expect(requestAt(1).params.replaceFromMessageId).toBe(exchangeId);
  });

  test('regenerating an answer produced in this session forks at its own question', async () => {
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-local-regen' }));
    act(() => {
      result.current.loadServerMessages([]);
    });

    send(result, 'explain X');
    await connect('chat-local-regen');
    const exchangeId = requestAt(0).messages[0].messageId;
    const assistantId = result.current.messages[1].id;
    act(() => {
      result.current.updateAssistantMessage(assistantId, 'first answer', false);
    });

    let resend;
    act(() => {
      resend = result.current.resendMessage(assistantId);
    });
    expect(resend.content).toBe('explain X');
    send(result, resend.content);
    await connect('chat-local-regen');

    expect(requestAt(1).params.replaceFromMessageId).toBe(exchangeId);
    expect(requestAt(1).messages).toHaveLength(1);
  });

  test('a fork latched in one chat is not carried into the next', async () => {
    // `/apps/:appId/c/:chatId` swaps chats without remounting the hook, so an
    // abandoned edit in chat A could otherwise address A's stored history from
    // inside chat B — where the id does not exist, and the send fails with
    // 400 UNKNOWN_MESSAGE for no visible reason.
    const { result, rerender } = renderHook(({ chatId }) => useAppChat({ appId: 'app1', chatId }), {
      initialProps: { chatId: 'chat-a' }
    });
    hydrate(result);

    act(() => {
      result.current.resendMessage('srv-3', 'rephrased');
    });

    rerender({ chatId: 'chat-b' });
    hydrate(result, [stored('other-1', 'user', 'unrelated')]);

    send(result, 'a question in the other chat');
    await connect('chat-b');

    expect(requestAt(0).chatId).toBe('chat-b');
    expect(requestAt(0).params.replaceFromMessageId).toBeUndefined();
  });
});

describe('sendChatHistory', () => {
  test('a turn says the history is off, because the array cannot', async () => {
    // A turn posts exactly one message whatever the viewer's "Include chat
    // history in requests" toggle says, so without this field the server would
    // keep prepending the stored transcript and the opt-out would be inert.
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-nohist' }));
    hydrate(result);

    send(result, 'a standalone question', { sendChatHistory: false });
    await connect('chat-nohist');

    expect(requestAt(0).messages).toHaveLength(1);
    expect(requestAt(0).params.sendChatHistory).toBe(false);
  });

  test('leaving the toggle on says so, so the stored setting can be turned back on', async () => {
    // The field used to be sent only when *off*. The chat document merges
    // settings, so a turn that omits the key leaves the stored value alone —
    // which meant the toggle could be turned off and never back on: every
    // reopen restored `false`, and ticking it on again recorded nothing.
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-hist' }));
    hydrate(result);

    send(result, 'a follow-up');
    await connect('chat-hist');

    // The server only tests `=== false`, so `true` changes no wire behaviour —
    // it is the recorded value this fixes.
    expect(requestAt(0).params.sendChatHistory).toBe(true);
  });

  test('off then on round-trips, rather than latching off for good', async () => {
    // The whole point: a durable chat records what the toggle is, so a later
    // reopen can restore it. Recording only `false` meant the stored value
    // could go one way.
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-roundtrip' }));
    hydrate(result);

    send(result, 'without history', { sendChatHistory: false });
    await connect('chat-roundtrip');
    expect(requestAt(0).params.sendChatHistory).toBe(false);

    act(() => {
      result.current.updateAssistantMessage(result.current.messages[1].id, 'answered', false);
    });
    send(result, 'with history again');
    await connect('chat-roundtrip');
    expect(requestAt(1).params.sendChatHistory).toBe(true);
  });
});

test('a chat with no id supplied keeps the same one across re-renders', () => {
  const { result, rerender } = renderHook(() => useAppChat({ appId: 'app1' }));
  const first = result.current.chatId;

  rerender();
  rerender();

  expect(first).toBeTruthy();
  expect(result.current.chatId).toBe(first);
});
