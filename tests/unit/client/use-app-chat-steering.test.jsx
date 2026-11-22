// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';

/**
 * Messages the person sends into the running answer of a chat (#3191), as the
 * chat hook handles them with the real stream transport (the chat's GET
 * stream; only the network is stubbed):
 *
 * - a message sent shows at once and takes the id the server answers with;
 * - `steer/applied` with `step` takes it off the list and draws it in the
 *   answer (`appliedMessages`), with the activity item the server named;
 * - the stream stays open past the answer's `run/ended` while a message sent
 *   into it waits for its frame, and closes once none waits;
 * - `steer/applied` with `nextRunId` places the next turn's question and answer
 *   at once and follows that turn on the chat's stream;
 * - `steer/dropped` gives the text back; a frame of a run the page does not
 *   show changes no message.
 */

jest.mock('uuid', () => ({
  __esModule: true,
  v4: () => '00000000-0000-0000-0000-000000000000'
}));
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, def) => (typeof def === 'string' ? def : key) })
}));
jest.mock('../../../client/src/utils/debugLog', () => ({ __esModule: true, debugLog: () => {} }));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`
}));
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  sendAppChatMessage: jest.fn().mockResolvedValue({}),
  stopAppChatStream: jest.fn().mockResolvedValue({}),
  checkAppChatStatus: jest.fn().mockResolvedValue({ active: true, processing: true }),
  sendHumanEvent: jest.fn(),
  removeHumanEvent: jest.fn(),
  fetchChat: jest.fn()
}));

const mockOpenCalls = [];
const mockEmitters = [];
const mockSignals = [];
jest.mock('../../../client/src/shared/utils/openSseStream', () => {
  const actual = jest.requireActual('../../../client/src/shared/utils/openSseStream');
  return {
    __esModule: true,
    ...actual,
    openSseStream: jest.fn((url, { signal, onOpen, onEvent }) => {
      mockOpenCalls.push(url);
      mockEmitters.push(onEvent);
      mockSignals.push(signal);
      onOpen?.();
      return new Promise(resolve => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
        return undefined;
      });
    }),
    // The next turn has no ledger yet.
    fetchWithAuthRetry: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
  };
});

const useAppChat = require('../../../client/src/features/chat/hooks/useAppChat').default;
const { sendHumanEvent, fetchChat } = require('../../../client/src/api');

const RUN = 'chat-run-1';
let seq = 0;
const frame = (runId, type, data = {}) => ({
  v: 2,
  seq: ++seq,
  runId,
  ts: new Date(seq * 1000).toISOString(),
  type,
  data
});

/** Send a message and bring its turn's stream to a running run. */
async function startTurn(result) {
  act(() => {
    result.current.sendMessage({
      displayMessage: { content: 'Write the report' },
      apiMessage: { content: 'Write the report' },
      params: {}
    });
  });
  const emit = mockEmitters.at(-1);
  await act(async () => {
    emit('stream/connected', frame('chat-1', 'stream/connected', {}));
  });
  const exchangeId = result.current.messages.at(-1).id;
  await act(async () => {
    emit(
      'run/started',
      frame(RUN, 'run/started', { kind: 'chat', refs: { messageId: exchangeId } })
    );
  });
  return { emit, exchangeId };
}

beforeEach(() => {
  seq = 0;
  mockOpenCalls.length = 0;
  mockEmitters.length = 0;
  mockSignals.length = 0;
  sendHumanEvent.mockReset();
  fetchChat.mockReset().mockResolvedValue({ chat: { status: 'active' }, messages: [] });
});

test('a message read at a step leaves the list and is drawn in the answer', async () => {
  const { result } = renderHook(() => useAppChat({ appId: 'app', chatId: 'chat-1' }));
  const { emit, exchangeId } = await startTurn(result);
  expect(result.current.runningRunId).toBe(RUN);

  sendHumanEvent.mockResolvedValue({ runId: RUN, seq: 4, id: 'steer-1', effect: 'steer_queued' });
  await act(async () => {
    await result.current.steering.send(RUN, 'Use the 2025 numbers');
  });
  expect(sendHumanEvent).toHaveBeenCalledWith(RUN, {
    kind: 'steer',
    message: 'Use the 2025 numbers'
  });
  expect(result.current.steering.items).toEqual([
    expect.objectContaining({ id: 'steer-1', runId: RUN, kind: 'steer', actions: ['remove'] })
  ]);

  await act(async () => {
    emit(
      'steer/applied',
      frame(RUN, 'steer/applied', {
        id: 'steer-1',
        kind: 'steer',
        text: 'Use the 2025 numbers',
        step: 1,
        activityKind: 'user_message'
      })
    );
  });
  expect(result.current.steering.items).toEqual([]);
  const answer = result.current.messages.find(m => m.id === exchangeId);
  expect(answer.appliedMessages).toEqual([
    { id: 'steer-1', text: 'Use the 2025 numbers', step: 1, activityKind: 'user_message' }
  ]);
});

test('the stream stays open past the end of the answer while a message waits for its frame', async () => {
  const { result } = renderHook(() => useAppChat({ appId: 'app', chatId: 'chat-1' }));
  const { emit } = await startTurn(result);
  sendHumanEvent.mockResolvedValue({ runId: RUN, seq: 4, id: 'steer-2', effect: 'steer_queued' });
  await act(async () => {
    await result.current.steering.send(RUN, 'And skip the appendix');
  });

  await act(async () => {
    emit('run/ended', frame(RUN, 'run/ended', { status: 'aborted', finishReason: 'cancelled' }));
  });
  const signal = mockSignals.at(-1);
  expect(signal.aborted).toBe(false);
  expect(result.current.runningRunId).toBeNull();

  await act(async () => {
    emit(
      'steer/dropped',
      frame(RUN, 'steer/dropped', {
        id: 'steer-2',
        kind: 'steer',
        text: 'And skip the appendix',
        reason: 'run_stopped'
      })
    );
  });
  expect(signal.aborted).toBe(true);
  expect(result.current.steering.items).toEqual([]);
  expect(result.current.steering.dropped).toEqual([
    { id: 'steer-2', text: 'And skip the appendix', reason: 'run_stopped' }
  ]);
});

test('without a message waiting, the stream closes at the end of the answer as before', async () => {
  const { result } = renderHook(() => useAppChat({ appId: 'app', chatId: 'chat-1' }));
  const { emit } = await startTurn(result);
  await act(async () => {
    emit('run/ended', frame(RUN, 'run/ended', { status: 'completed', finishReason: 'stop' }));
  });
  expect(mockSignals.at(-1).aborted).toBe(true);
});

test('a message sent as the next turn gets its question and answer at once, and its turn is followed', async () => {
  jest.useFakeTimers();
  try {
    const { result } = renderHook(() => useAppChat({ appId: 'app', chatId: 'chat-1' }));
    const { emit, exchangeId } = await startTurn(result);
    sendHumanEvent.mockResolvedValue({ runId: RUN, seq: 4, id: 'later-1', effect: 'steer_queued' });
    await act(async () => {
      await result.current.steering.send(RUN, 'Then a summary', 'afterwards');
    });
    expect(sendHumanEvent).toHaveBeenCalledWith(RUN, {
      kind: 'steer',
      message: 'Then a summary',
      mode: 'afterwards'
    });
    expect(result.current.steering.items[0]).toMatchObject({ id: 'later-1', kind: 'send_after' });

    await act(async () => {
      emit(
        'step/delta',
        frame(RUN, 'step/delta', { step: 0, kind: 'text', content: 'The report.' })
      );
      emit('run/ended', frame(RUN, 'run/ended', { status: 'completed', finishReason: 'stop' }));
      emit(
        'steer/applied',
        frame(RUN, 'steer/applied', {
          id: 'later-1',
          kind: 'send_after',
          text: 'Then a summary',
          nextRunId: 'chat-run-2'
        })
      );
      // Queued again on the next turn's run: no message of this page belongs to it yet.
      emit(
        'steer/queued',
        frame('chat-run-9', 'steer/queued', { id: 'x', kind: 'steer', text: 'other' })
      );
    });
    const answer = result.current.messages.find(m => m.id === exchangeId);
    expect(answer.content).toBe('The report.');
    const [question, next] = result.current.messages.slice(-2);
    expect(question).toMatchObject({ role: 'user', content: 'Then a summary' });
    expect(next).toMatchObject({ id: 'later-1', role: 'assistant', loading: true });
    expect(result.current.steering.items.map(item => item.id)).toEqual(['x']);

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockOpenCalls.at(-1)).toContain('resumeRun=chat-run-2');
    expect(result.current.processing).toBe(true);

    // The next turn's frames arrive on the chat's stream, into its own answer.
    const follow = mockEmitters.at(-1);
    fetchChat.mockResolvedValue({
      chat: { status: 'running', activeRunId: 'chat-run-2' },
      messages: [],
      pending: [],
      maySteer: true
    });
    await act(async () => {
      follow('stream/connected', frame('chat-1', 'stream/connected', {}));
      follow(
        'run/started',
        frame('chat-run-2', 'run/started', { kind: 'chat', refs: { messageId: 'later-1' } })
      );
      follow(
        'step/delta',
        frame('chat-run-2', 'step/delta', { step: 0, kind: 'text', content: 'Summary.' })
      );
    });
    expect(result.current.messages.find(m => m.id === 'later-1').content).toBe('Summary.');
    expect(result.current.messages.find(m => m.id === exchangeId).content).toBe('The report.');
  } finally {
    jest.useRealTimers();
  }
});

test('a message already read cannot be removed: it leaves the list and a toast says so', async () => {
  const { ToastProvider } = require('../../../client/src/shared/components/ToastHost');
  const { removeHumanEvent } = require('../../../client/src/api');
  const wrapper = ({ children }) => <ToastProvider>{children}</ToastProvider>;
  const { result } = renderHook(() => useAppChat({ appId: 'app', chatId: 'chat-1' }), {
    wrapper
  });
  await startTurn(result);
  sendHumanEvent.mockResolvedValue({ runId: RUN, seq: 4, id: 'steer-3', effect: 'steer_queued' });
  await act(async () => {
    await result.current.steering.send(RUN, 'Too late');
  });
  const conflict = Object.assign(new Error('read'), {
    status: 409,
    code: 'STEER_ALREADY_APPLIED'
  });
  removeHumanEvent.mockRejectedValueOnce(conflict);
  await act(async () => {
    await result.current.steering.remove(result.current.steering.items[0]);
  });
  expect(removeHumanEvent).toHaveBeenCalledWith(RUN, 'steer-3');
  expect(result.current.steering.items).toEqual([]);
  expect(document.body).toHaveTextContent('Already read by iHub');
});
