import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';

/**
 * The protocol switch — the reason the durable-chat backend cannot ship
 * without the client.
 *
 * A persisted chat owns its own history: the server reads the transcript back
 * out of the store and rejects a request carrying more than the new message
 * with `CLIENT_HISTORY_NOT_ALLOWED` (`server/routes/chat/sessionRoutes.js`).
 * Every other surface — anonymous viewers, the incognito toggle, the compare
 * panels, the canvas — keeps posting its whole local array exactly as before,
 * flagged `ephemeral` so the server knows not to store it. Both modes are
 * permanent, so both are pinned here.
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
    return { initEventSource: jest.fn(), cleanupEventSource: jest.fn() };
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
  /** Two finished turns in local state, whatever the mode. */
  function twoTurns(options) {
    const { result } = renderHook(() => useChatMessages('chat-api', options));
    act(() => {
      result.current.addUserMessage('first question');
      result.current.addAssistantMessage('a1');
    });
    act(() => {
      result.current.updateAssistantMessage('a1', 'first answer', false);
    });
    return result;
  }

  const NEW_MESSAGE = { role: 'user', content: 'second question' };

  test('a server-backed chat sends only the new message, however long the transcript', () => {
    const result = twoTurns({ serverBacked: true });
    expect(result.current.messages).toHaveLength(2);

    const body = result.current.getMessagesForApi(true, NEW_MESSAGE);

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ role: 'user', content: 'second question' });
  });

  test('an ordinary chat still sends its whole local history', () => {
    const result = twoTurns(undefined);

    const body = result.current.getMessagesForApi(true, NEW_MESSAGE);

    expect(body.map(m => m.content)).toEqual(['first question', 'first answer', 'second question']);
  });

  test('an ephemeral chat also sends its whole local history — nothing stores it', () => {
    const result = twoTurns({ ephemeral: true });

    const body = result.current.getMessagesForApi(true, NEW_MESSAGE);

    expect(body.map(m => m.content)).toEqual(['first question', 'first answer', 'second question']);
  });

  test('an app with chat history off sends one message in either mode', () => {
    expect(twoTurns(undefined).current.getMessagesForApi(false, NEW_MESSAGE)).toHaveLength(1);
    expect(
      twoTurns({ serverBacked: true }).current.getMessagesForApi(false, NEW_MESSAGE)
    ).toHaveLength(1);
  });
});

describe('the wire', () => {
  test('a server-backed turn posts exactly one message and is not flagged ephemeral', async () => {
    const { result } = renderHook(() =>
      useAppChat({ appId: 'app1', chatId: 'chat-backed', serverBacked: true })
    );
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

  test('a second server-backed turn still posts one message', async () => {
    const { result } = renderHook(() =>
      useAppChat({ appId: 'app1', chatId: 'chat-backed-2', serverBacked: true })
    );
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

  test('an ordinary chat posts its growing array and marks every turn ephemeral', async () => {
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-plain' }));

    send(result, 'one');
    await connect('chat-plain');
    expect(requestAt(0).messages).toHaveLength(1);
    expect(requestAt(0).params.ephemeral).toBe(true);

    act(() => {
      result.current.updateAssistantMessage(result.current.messages[1].id, 'answered', false);
    });

    send(result, 'two');
    await connect('chat-plain');

    expect(requestAt(1).messages.map(m => m.content)).toEqual(['one', 'answered', 'two']);
    expect(requestAt(1).params.ephemeral).toBe(true);
  });

  test('an incognito chat posts its whole array too', async () => {
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

    expect(requestAt(1).messages.map(m => m.content)).toEqual(['one', 'answered', 'two']);
    expect(requestAt(1).params.ephemeral).toBe(true);
  });

  test('the clarification reply takes the same protocol as an ordinary send', async () => {
    const { result } = renderHook(() =>
      useAppChat({ appId: 'app1', chatId: 'chat-clarify', serverBacked: true })
    );
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
    const { result } = renderHook(() =>
      useAppChat({ appId: 'app1', chatId: 'chat-edit', serverBacked: true })
    );
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
    const { result } = renderHook(() =>
      useAppChat({ appId: 'app1', chatId: 'chat-regen', serverBacked: true })
    );
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
    const { result } = renderHook(() =>
      useAppChat({ appId: 'app1', chatId: 'chat-delete', serverBacked: true })
    );
    hydrate(result);

    act(() => {
      result.current.deleteMessage('srv-3');
    });

    send(result, 'a different question');
    await connect('chat-delete');

    expect(requestAt(0).params.replaceFromMessageId).toBe('srv-3');
  });

  test('the fork is consumed by one request, not repeated by the next', async () => {
    const { result } = renderHook(() =>
      useAppChat({ appId: 'app1', chatId: 'chat-once', serverBacked: true })
    );
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

  test('a turn made in this session has no stored id, so it only truncates locally', async () => {
    const { result } = renderHook(() =>
      useAppChat({ appId: 'app1', chatId: 'chat-local', serverBacked: true })
    );
    act(() => {
      result.current.loadServerMessages([]);
    });

    send(result, 'brand new question');
    await connect('chat-local');
    const localUserId = result.current.messages[0].id;

    act(() => {
      result.current.resendMessage(localUserId, 'brand new question, rephrased');
    });
    send(result, 'brand new question, rephrased');
    await connect('chat-local');

    expect(requestAt(1).params.replaceFromMessageId).toBeUndefined();
  });

  test('an ordinary chat never sends a fork id — it still posts the truncated array', async () => {
    const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-plain-edit' }));

    send(result, 'one');
    await connect('chat-plain-edit');
    act(() => {
      result.current.updateAssistantMessage(result.current.messages[1].id, 'answered', false);
    });

    act(() => {
      result.current.resendMessage(result.current.messages[0].id, 'one, rephrased');
    });
    expect(result.current.messages).toHaveLength(0);

    send(result, 'one, rephrased');
    await connect('chat-plain-edit');

    expect(requestAt(1).messages.map(m => m.content)).toEqual(['one, rephrased']);
    expect(requestAt(1).params.replaceFromMessageId).toBeUndefined();
    expect(requestAt(1).params.ephemeral).toBe(true);
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
