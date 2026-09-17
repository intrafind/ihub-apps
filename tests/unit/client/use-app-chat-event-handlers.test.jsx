/**
 * Regression tests for client/src/features/chat/hooks/useAppChat.js on the
 * SSE v2 dialect: every frame reaches `handleEvent` as `{ type, envelope }`
 * where envelope = `{ v: 2, seq, runId, ts, type, data }`; the hook folds it
 * into the per-chat run reducer and projects the run onto the assistant
 * placeholder bound via `run/started.data.refs.messageId`.
 *
 * The three historical regressions (both handlers used to throw
 * "X is not defined" at runtime) are kept as scenarios:
 *   - `meta.responseMessageId` attaches ifinderMessageId while still loading
 *   - `run/ended` finalises the message, flips processing off and calls
 *     onMessageComplete
 *   - a delta → meta → run/ended sequence keeps ifinderMessageId
 *
 * These exercise the real hook end-to-end through the real `useChatMessages`.
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
// stub the transport so no real network connection is opened.
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

// sendAppChatMessage is only reached from the 'stream/connected' handler;
// stub the api module so importing the hook does not pull in the client.
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  sendAppChatMessage: jest.fn().mockResolvedValue({})
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
const { sendAppChatMessage } = require('../../../client/src/api');

let seq = 0;
const RUN_ID = 'run-turn-1';

/** Build an SSE v2 envelope (seq increments per test). */
function envelope(type, data = {}, runId = RUN_ID) {
  seq += 1;
  return { v: 2, seq, runId, ts: new Date(1756800000000 + seq * 1000).toISOString(), type, data };
}

/** Deliver one frame the way useEventSource does. */
async function deliver(type, data, runId) {
  const env = envelope(type, data, runId);
  await act(async () => {
    await capturedOnEvent({ type: env.type, envelope: env });
  });
  return env;
}

/**
 * Drive sendMessage so an assistant placeholder exists in state and
 * lastMessageIdRef points at it — the precondition every handler assumes.
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

/** run/started bound to the placeholder via refs.messageId. */
async function startRun(assistantId, appId = 'app1', chatId = 'chat') {
  await deliver('run/started', {
    kind: 'chat',
    model: 'gpt-x',
    refs: { chatId, appId, messageId: assistantId }
  });
}

beforeEach(() => {
  capturedOnEvent = null;
  seq = 0;
  sessionStorage.clear();
  sendAppChatMessage.mockClear();
});

test("'stream/connected' sends the pending message", async () => {
  const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-conn' }));
  startAssistantMessage(result);

  await deliver('stream/connected', { runId: 'chat-conn', lastSeq: 0, protocol: 2 }, 'chat-conn');

  expect(sendAppChatMessage).toHaveBeenCalledTimes(1);
  const [appId, chatId, messages] = sendAppChatMessage.mock.calls[0];
  expect(appId).toBe('app1');
  expect(chatId).toBe('chat-conn');
  expect(messages[messages.length - 1]).toMatchObject({ role: 'user', content: 'hello' });
  expect(result.current.processing).toBe(true);
});

test("'meta.responseMessageId' attaches ifinderMessageId while the message keeps loading", async () => {
  const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-resp' }));

  const assistant = startAssistantMessage(result);
  expect(assistant).toBeTruthy();
  expect(assistant.loading).toBe(true);
  expect(assistant.ifinderMessageId).toBeUndefined();

  await startRun(assistant.id);
  await deliver('meta', { responseMessageId: 'resp-123' });

  const updated = result.current.messages.find(m => m.id === assistant.id);
  expect(updated.ifinderMessageId).toBe('resp-123');
  // Emitted before run/ended, so the message keeps streaming: loading preserved.
  expect(updated.loading).toBe(true);
});

test("'run/ended' completes the message, stops processing and calls onMessageComplete", async () => {
  const onMessageComplete = jest.fn();
  const { result } = renderHook(() =>
    useAppChat({ appId: 'app1', chatId: 'chat-done', onMessageComplete })
  );

  const assistant = startAssistantMessage(result);
  expect(result.current.processing).toBe(true);

  await startRun(assistant.id);
  await deliver('step/delta', { step: 0, kind: 'text', content: 'final ' });
  await deliver('step/delta', { step: 0, kind: 'text', content: 'answer' });
  await deliver('run/ended', { status: 'completed', finishReason: 'stop' });

  const done = result.current.messages.find(m => m.id === assistant.id);
  expect(done.content).toBe('final answer');
  expect(done.loading).toBe(false);
  expect(done.finishReason).toBe('stop');
  expect(result.current.processing).toBe(false);
  expect(onMessageComplete).toHaveBeenCalledWith('final answer', 'hello');
});

test('a delta → meta → run/ended sequence keeps both effects', async () => {
  const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-seq' }));

  const assistant = startAssistantMessage(result);

  await startRun(assistant.id);
  await deliver('step/delta', { step: 0, kind: 'text', content: 'partial' });
  await deliver('meta', { responseMessageId: 'resp-999' });
  await deliver('step/delta', { step: 0, kind: 'text', content: ' done' });
  await deliver('run/ended', { status: 'completed', finishReason: 'stop' });

  const msg = result.current.messages.find(m => m.id === assistant.id);
  expect(msg.ifinderMessageId).toBe('resp-999'); // survived the run/ended finalize
  expect(msg.content).toBe('partial done');
  expect(msg.loading).toBe(false);
  expect(result.current.processing).toBe(false);
});

test('events without a prior run/started fall back to the current placeholder', async () => {
  const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-fallback' }));
  const assistant = startAssistantMessage(result);

  await deliver('step/delta', { step: 0, kind: 'text', content: 'no run/started' }, 'run-x');

  const msg = result.current.messages.find(m => m.id === assistant.id);
  expect(msg.content).toBe('no run/started');
  expect(msg.loading).toBe(true);
});

test('interaction/raised + run/paused keeps the clarification pending and stops processing', async () => {
  const onMessageComplete = jest.fn();
  const { result } = renderHook(() =>
    useAppChat({ appId: 'app1', chatId: 'chat-clar', onMessageComplete })
  );
  const assistant = startAssistantMessage(result);
  await startRun(assistant.id);
  await deliver('step/delta', { step: 0, kind: 'text', content: 'One question:' });

  const interaction = {
    id: 'q-1',
    runId: RUN_ID,
    step: 0,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Which year?', inputType: 'text', allowSkip: true, allowOther: false },
    policy: {},
    status: 'pending',
    source: { toolCallId: 'call-1', toolId: 'ask_user', chatId: 'chat-clar', appId: 'app1' },
    createdAt: new Date().toISOString(),
    ordinal: 1
  };
  await deliver('interaction/raised', { interaction });
  expect(result.current.clarificationPending).toBe(true);
  expect(result.current.processing).toBe(true);

  await deliver('run/paused', { reason: 'interaction', interactionId: 'q-1' });

  const msg = result.current.messages.find(m => m.id === assistant.id);
  expect(msg.content).toBe('One question:');
  expect(msg.awaitingInput).toBe(true);
  expect(msg.loading).toBe(false);
  expect(msg.clarification).toMatchObject({
    questionId: 'q-1',
    toolCallId: 'call-1',
    question: 'Which year?',
    inputType: 'text',
    allowSkip: true,
    options: []
  });
  expect(result.current.processing).toBe(false);
  expect(result.current.clarificationPending).toBe(true);
  expect(onMessageComplete).not.toHaveBeenCalled();

  // A run/ended with status paused (turn handed back) must not reset the clarification.
  await deliver('run/ended', { status: 'paused', finishReason: 'clarification' });
  expect(result.current.clarificationPending).toBe(true);
  expect(result.current.messages.find(m => m.id === assistant.id).awaitingInput).toBe(true);
  expect(onMessageComplete).not.toHaveBeenCalled();
});

test('stream/error appends the message, stops loading/processing and run/ended(error) does not complete', async () => {
  const onMessageComplete = jest.fn();
  const { result } = renderHook(() =>
    useAppChat({ appId: 'app1', chatId: 'chat-err', onMessageComplete })
  );
  const assistant = startAssistantMessage(result);
  await startRun(assistant.id);
  await deliver('step/delta', { step: 0, kind: 'text', content: 'so far' });
  await deliver('stream/error', { code: 'LLM_ERROR', message: 'Model exploded', retryable: false });

  let msg = result.current.messages.find(m => m.id === assistant.id);
  expect(msg.content).toBe('so far\n\nModel exploded');
  expect(msg.loading).toBe(false);
  expect(result.current.processing).toBe(false);

  await deliver('run/ended', { status: 'error', finishReason: 'error' });
  msg = result.current.messages.find(m => m.id === assistant.id);
  expect(msg.content).toBe('so far\n\nModel exploded'); // not appended twice
  expect(onMessageComplete).not.toHaveBeenCalled();
});

test('a transport-level stream/error (no run yet) falls back to the default error text', async () => {
  const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-transport' }));
  const assistant = startAssistantMessage(result);

  await act(async () => {
    await capturedOnEvent({
      type: 'stream/error',
      envelope: {
        v: 2,
        runId: 'chat-transport',
        ts: new Date().toISOString(),
        type: 'stream/error',
        data: { code: 'CONNECTION_ERROR', message: '', retryable: false },
        synthetic: true
      }
    });
  });

  const msg = result.current.messages.find(m => m.id === assistant.id);
  expect(msg.content).toBe('\n\nAn error occurred during streaming');
  expect(msg.loading).toBe(false);
  expect(result.current.processing).toBe(false);
});

test('workflow progress and result on the chat stream project steps and workflowResult', async () => {
  const { result } = renderHook(() => useAppChat({ appId: 'app1', chatId: 'chat-wf' }));
  const assistant = startAssistantMessage(result);
  await startRun(assistant.id);

  await deliver('progress/node', {
    executionId: 'wf-exec-1',
    nodeId: 'search',
    nodeName: 'Search',
    nodeType: 'tool',
    status: 'running',
    progress: { workflowName: 'Research', chatVisible: true }
  });
  let msg = result.current.messages.find(m => m.id === assistant.id);
  expect(msg.workflowStep).toMatchObject({ nodeName: 'Search', status: 'running' });
  expect(msg.workflowSteps).toHaveLength(1);

  await deliver('step/delta', { step: 0, kind: 'text', content: 'Report' });
  await deliver('meta', {
    executionId: 'wf-exec-1',
    extra: { workflow: { status: 'completed', workflowName: 'Research', outputFormat: 'html' } }
  });
  await deliver('run/ended', { status: 'completed', finishReason: 'stop' });

  msg = result.current.messages.find(m => m.id === assistant.id);
  expect(msg.workflowStep).toBeNull();
  expect(msg.workflowSteps).toEqual([
    {
      nodeName: 'Search',
      nodeType: 'tool',
      status: 'completed',
      workflowName: 'Research',
      chatVisible: true
    }
  ]);
  expect(msg.workflowResult).toEqual({
    status: 'completed',
    executionId: 'wf-exec-1',
    workflowName: 'Research'
  });
  expect(msg.outputFormat).toBe('html'); // workflow output format wins over the app default
  expect(msg.content).toBe('Report');
});
