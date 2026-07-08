/**
 * Regression tests for client/src/features/chat/hooks/useAppChat.js
 *
 * The SSE `handleEvent` switch called two state setters that did not exist in
 * scope, so the handlers threw "X is not defined" at runtime the moment the
 * matching event arrived. Both slipped past ESLint (no `no-undef` error) and
 * only surfaced in the browser — reported as an "Add-in Error" in the Outlook
 * add-in, thrown from the ChatMessageList bundle:
 *
 *   - 'done'                 → `setSearchStatus(null)` — a dangling reference
 *     left behind when PR #1860 removed the top-level `searchStatus` state
 *     (declaration, `search.status` write and `resetConversationState` reset
 *     were removed; this third call in the `done` handler was missed).
 *   - 'response.message.id'  → `setMessages(...)` — `useChatMessages` never
 *     exposed a `setMessages` setter (it is internal to that hook).
 *
 * These exercise the real hook end-to-end through the real `useChatMessages`,
 * so the assertions fail (with a ReferenceError) against the pre-fix code and
 * pass against the fix.
 */

import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';

// The client's `uuid` build is ESM-only and jest does not transform
// node_modules; stub it (used only for default id generation).
jest.mock('uuid', () => ({
  __esModule: true,
  v4: () => '00000000-0000-0000-0000-000000000000'
}));

// Capture the SSE event handler that useAppChat wires into useEventSource and
// stub the transport so no real EventSource / network connection is opened.
let capturedOnEvent = null;
jest.mock('../../../client/src/shared/hooks/useEventSource', () => ({
  __esModule: true,
  default: ({ onEvent }) => {
    capturedOnEvent = onEvent;
    return {
      initEventSource: jest.fn(),
      cleanupEventSource: jest.fn()
    };
  }
}));

// sendAppChatMessage is only reached from the 'connected' handler (not under
// test); stub the api module so importing the hook does not pull in the client.
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  sendAppChatMessage: jest.fn()
}));

// Minimal i18n: return the provided default string (or the key).
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, def) => def || key })
}));

// These two utils use `import.meta.env`, which the jest babel transform does
// not handle; stub them with factories so the real files are never parsed.
jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`
}));

const useAppChat = require('../../../client/src/features/chat/hooks/useAppChat').default;

/**
 * Drive sendMessage so an assistant placeholder exists in state and
 * lastMessageIdRef points at it — the precondition every SSE handler assumes.
 * Returns the assistant message.
 */
function startAssistantMessage(result) {
  act(() => {
    result.current.sendMessage({
      displayMessage: 'hello',
      apiMessage: { content: 'hello' },
      params: {}
    });
  });
  return result.current.messages.find(m => m.role === 'assistant');
}

beforeEach(() => {
  capturedOnEvent = null;
  sessionStorage.clear();
});

test("'response.message.id' attaches ifinderMessageId (no setMessages ReferenceError)", async () => {
  const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-resp' }));

  const assistant = startAssistantMessage(result);
  expect(assistant).toBeTruthy();
  expect(assistant.loading).toBe(true);
  expect(assistant.ifinderMessageId).toBeUndefined();

  // Pre-fix: threw "setMessages is not defined".
  await act(async () => {
    await capturedOnEvent({ type: 'response.message.id', data: { messageId: 'resp-123' } });
  });

  const updated = result.current.messages.find(m => m.id === assistant.id);
  expect(updated.ifinderMessageId).toBe('resp-123');
  // Emitted before 'done', so the message keeps streaming: loading preserved.
  expect(updated.loading).toBe(true);
});

test("'done' completes the message (no setSearchStatus ReferenceError)", async () => {
  const onMessageComplete = jest.fn();
  const { result } = renderHook(() =>
    useAppChat({ appId: 'app1', chatId: 'chat-done', onMessageComplete })
  );

  const assistant = startAssistantMessage(result);
  expect(result.current.processing).toBe(true);

  // Pre-fix: threw "setSearchStatus is not defined".
  await act(async () => {
    await capturedOnEvent({
      type: 'done',
      fullContent: 'final answer',
      data: { finishReason: 'stop' }
    });
  });

  const done = result.current.messages.find(m => m.id === assistant.id);
  expect(done.content).toBe('final answer');
  expect(done.loading).toBe(false);
  expect(result.current.processing).toBe(false);
  expect(onMessageComplete).toHaveBeenCalledWith('final answer', 'hello');
});

test("a 'response.message.id' then 'done' sequence keeps both effects", async () => {
  const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-seq' }));

  const assistant = startAssistantMessage(result);

  await act(async () => {
    await capturedOnEvent({ type: 'chunk', fullContent: 'partial' });
    await capturedOnEvent({ type: 'response.message.id', data: { messageId: 'resp-999' } });
    await capturedOnEvent({
      type: 'done',
      fullContent: 'partial done',
      data: { finishReason: 'stop' }
    });
  });

  const msg = result.current.messages.find(m => m.id === assistant.id);
  expect(msg.ifinderMessageId).toBe('resp-999'); // survived the 'done' finalize
  expect(msg.content).toBe('partial done');
  expect(msg.loading).toBe(false);
  expect(result.current.processing).toBe(false);
});
