// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs';
import path from 'node:path';
import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

/**
 * A chat turn that outlasts the request that sent it (GET-then-POST, the
 * `chatPostStream` flag off): the POST is answered when the turn ends, so its
 * timeout, or a proxy's 502/504, loses the reply and not the turn.
 *
 * - The client asks whether the turn is running and keeps listening. A status
 *   check that fails is repeated after 1 s, 2 s and 4 s before the lost reply is
 *   reported as a failure. Each check has 5 s to answer, so the search ends
 *   after 27 s at the latest.
 * - The stream is the second witness: once it has shown the turn's run, the
 *   lost reply is never reported.
 * - A request that really failed still shows the error, in English and German.
 * - Nothing here stops the turn on the server.
 *
 * Runs the real `useAppChat` and the real error texts (`apiErrors.js` with
 * i18next and `shared/i18n`); the stream transport is a stub the test plays
 * frames into, and the timers are jest's, so no test waits for a real delay.
 */

jest.mock('uuid', () => ({ __esModule: true, v4: () => '00000000-0000-0000-0000-000000000000' }));
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, def) => (typeof def === 'string' ? def : key) })
}));
// These two read `import.meta.env`, which the jest transform cannot parse.
jest.mock('../../../client/src/utils/debugLog', () => ({ __esModule: true, debugLog: () => {} }));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: urlPath => `/api/${urlPath}`
}));
jest.mock('../../../client/src/shared/hooks/useMyUsage', () => ({
  __esModule: true,
  refreshMyUsage: () => {}
}));

/** The stream transport: what the hook asked of it, and the handler it gave. */
const mockStream = {
  onEvent: null,
  initEventSource: jest.fn(),
  detachEventSource: jest.fn(),
  stopEventSource: jest.fn(),
  startTurn: jest.fn()
};
jest.mock('../../../client/src/shared/hooks/useEventSource', () => ({
  __esModule: true,
  default: ({ onEvent }) => {
    mockStream.onEvent = onEvent;
    return {
      initEventSource: mockStream.initEventSource,
      detachEventSource: mockStream.detachEventSource,
      stopEventSource: mockStream.stopEventSource,
      startTurn: mockStream.startTurn
    };
  }
}));

const mockApi = {
  sendAppChatMessage: jest.fn(),
  checkAppChatStatus: jest.fn(),
  stopAppChatStream: jest.fn(),
  fetchChat: jest.fn()
};
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  sendAppChatMessage: (...args) => mockApi.sendAppChatMessage(...args),
  checkAppChatStatus: (...args) => mockApi.checkAppChatStatus(...args),
  stopAppChatStream: (...args) => mockApi.stopAppChatStream(...args),
  fetchChat: (...args) => mockApi.fetchChat(...args)
}));

const { enhanceApiError } = require('../../../client/src/api/utils/apiErrors');
const { shortenedTimeout } = require('../../../client/src/api/utils/devTimeout');
const {
  default: useAppChat,
  LOST_REPLY_STATUS_RETRY_MS,
  LOST_REPLY_STATUS_TIMEOUT_MS
} = require('../../../client/src/features/chat/hooks/useAppChat');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const CHAT_ID = 'chat-long';
const RUN_ID = 'run-turn-1';
const TIMEOUT_EN = en.error.requestTimedOut;
const TIMEOUT_DE = de.error.requestTimedOut;

/** What axios rejects with when a request passes its timeout, as the API client reports it. */
const timedOut = () =>
  enhanceApiError({ code: 'ECONNABORTED', message: 'timeout of 300000ms exceeded' });
/** A proxy that gave up on the POST while the server went on. */
const gatewayTimeout = () =>
  enhanceApiError({ message: 'Request failed with status code 504', response: { status: 504 } });
/** A proxy that lost its connection to the server while the server went on. */
const badGateway = () =>
  enhanceApiError({ message: 'Request failed with status code 502', response: { status: 502 } });
/** What the lost-turn search hands the status check besides the two ids. */
const CHECK_OPTIONS = { timeout: LOST_REPLY_STATUS_TIMEOUT_MS };
/**
 * A status check that gets no answer: like the API client, it fails when the
 * timeout it was given has passed (30 s when it was given none).
 */
const hangingCheck = (_appId, _chatId, { timeout = 30000 } = {}) =>
  new Promise((_resolve, reject) => {
    setTimeout(() => reject(timedOut()), timeout);
  });
/** A promise the test settles itself. */
function held() {
  const handle = {};
  handle.promise = new Promise(resolve => {
    handle.resolve = resolve;
  });
  return handle;
}
/** A status check that got no answer: the API client reports it with status 500. */
const noAnswer = () => enhanceApiError({ code: 'ERR_NETWORK', message: 'Network Error' });
const refused = status =>
  enhanceApiError({
    message: `Request failed with status code ${status}`,
    response: { status, data: { code: 'NOT_FOUND', detail: 'Chat session not found' } }
  });

let seq = 0;
const envelope = (type, data = {}, runId = RUN_ID) => ({
  v: 2,
  seq: ++seq,
  runId,
  ts: new Date(1773561600000 + seq * 1000).toISOString(),
  type,
  data
});

/**
 * Hand a frame to the hook the way the transport does: not awaited, because the
 * handler of `stream/connected` returns only when the POST has been dealt with.
 */
async function deliver(type, data, runId) {
  const frame = envelope(type, data, runId);
  await act(async () => {
    void mockStream.onEvent({ type: frame.type, envelope: frame });
    await jest.advanceTimersByTimeAsync(0);
  });
}

const advance = ms =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });

function render(options = {}) {
  return renderHook(props => useAppChat({ appId: 'app1', chatId: CHAT_ID, ...props }), {
    initialProps: options
  });
}

/** Send a message; returns the assistant placeholder of its answer. */
function send(result, content = 'hello') {
  act(() => {
    result.current.sendMessage({
      displayMessage: content,
      apiMessage: { content },
      params: {}
    });
  });
  // Sending lets go of the stream of the turn before; what counts is what follows.
  mockStream.detachEventSource.mockClear();
  return result.current.messages.filter(message => message.role === 'assistant').at(-1);
}

const connect = (chatId = CHAT_ID) =>
  deliver('stream/connected', { runId: chatId, lastSeq: 0, protocol: 2 }, chatId);
const startRun = messageId =>
  deliver('run/started', { kind: 'chat', refs: { chatId: CHAT_ID, appId: 'app1', messageId } });
const messageOf = (result, id) => result.current.messages.find(message => message.id === id);

beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    interpolation: { escapeValue: false }
  });
});

beforeEach(async () => {
  jest.useFakeTimers();
  seq = 0;
  sessionStorage.clear();
  localStorage.clear();
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockApi.sendAppChatMessage.mockResolvedValue({});
  mockApi.checkAppChatStatus.mockResolvedValue({ active: true, processing: true });
  mockApi.stopAppChatStream.mockResolvedValue({});
  mockApi.fetchChat.mockResolvedValue(null);
  for (const fn of [
    mockStream.initEventSource,
    mockStream.detachEventSource,
    mockStream.stopEventSource,
    mockStream.startTurn
  ]) {
    fn.mockReset();
  }
  await i18next.changeLanguage('en');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the text of a request that timed out', () => {
  test('comes from shared/i18n, in English and in German', async () => {
    expect(TIMEOUT_EN).toBe(
      'Request timed out. The operation may have taken longer than expected.'
    );
    expect(TIMEOUT_DE).toMatch(/^Zeitüberschreitung bei der Anfrage\./);

    expect(timedOut().userFriendlyMessage).toBe(TIMEOUT_EN);
    expect(timedOut().message).toBe(TIMEOUT_EN);
    await i18next.changeLanguage('de');
    expect(timedOut().userFriendlyMessage).toBe(TIMEOUT_DE);
    // Callers still tell a timeout by the flag, whatever the language.
    expect(timedOut().isTimeout).toBe(true);
  });

  test('is English while the translations are not there', () => {
    jest.isolateModules(() => {
      jest.doMock('i18next', () => ({ __esModule: true, default: { isInitialized: false } }));
      const isolated = require('../../../client/src/api/utils/apiErrors');
      const error = isolated.enhanceApiError({ code: 'ECONNABORTED', message: 'timeout' });
      expect(error.userFriendlyMessage).toBe(TIMEOUT_EN);
    });
    jest.dontMock('i18next');
  });

  test('is not written out in the client any more', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'client/src/api/utils/apiErrors.js'),
      'utf8'
    );
    expect(source).toContain("'error.requestTimedOut'");
    expect(source.split('Request timed out.')).toHaveLength(2);
  });
});

describe('the test override of the chat POST timeout', () => {
  test('only shortens the timeout', () => {
    expect(shortenedTimeout(3000, 300000)).toBe(3000);
    expect(shortenedTimeout(1, 300000)).toBe(1);
    // Longer than the client's own, the same, or "no timeout" (axios reads 0 so): ignored.
    expect(shortenedTimeout(900000, 300000)).toBeUndefined();
    expect(shortenedTimeout(300000, 300000)).toBeUndefined();
    expect(shortenedTimeout(0, 300000)).toBeUndefined();
    expect(shortenedTimeout(-5, 300000)).toBeUndefined();
    expect(shortenedTimeout(Infinity, 300000)).toBeUndefined();
    expect(shortenedTimeout(NaN, 300000)).toBeUndefined();
    // Not a number: a page script cannot smuggle anything else in.
    expect(shortenedTimeout('3000', 300000)).toBeUndefined();
    expect(shortenedTimeout({ valueOf: () => 3000 }, 300000)).toBeUndefined();
    expect(shortenedTimeout(undefined, 300000)).toBeUndefined();
    expect(shortenedTimeout(null, 300000)).toBeUndefined();
  });

  /** Every source file below `dir`, as paths relative to the repository. */
  const sourcesBelow = dir =>
    fs
      .readdirSync(path.join(repoRoot, dir), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(js|jsx|html)$/.test(entry.name))
      .map(entry => path.relative(repoRoot, path.join(entry.parentPath, entry.name)));

  test('is read in one place, behind the check for a development build', () => {
    const readers = [...sourcesBelow('client/src'), 'client/index.html'].filter(file =>
      fs.readFileSync(path.join(repoRoot, file), 'utf8').includes('__ihubStreamTimeoutMs')
    );
    expect(readers).toEqual(['client/src/api/endpoints/apps.js']);

    const source = fs.readFileSync(path.join(repoRoot, readers[0]), 'utf8');
    // The property is named once in code (and once in the comment above it)…
    const reads = source.split('\n').filter(line => /window\.__ihubStreamTimeoutMs/.test(line));
    expect(reads.filter(line => !line.trim().startsWith('*'))).toHaveLength(1);
    // …in a function that leaves before it when the build is not a development build.
    const fn = source.slice(source.indexOf('const chatPostConfig = () => {'));
    const body = fn.slice(0, fn.indexOf('\n};'));
    expect(body.split('\n')[1].trim()).toBe('if (!IS_DEV_BUILD) return undefined;');
    // The flag is the build's own: Vite replaces `import.meta.env.DEV` with `false` in production.
    const client = fs.readFileSync(path.join(repoRoot, 'client/src/api/client.js'), 'utf8');
    expect(client).toContain('const IS_DEV_BUILD = import.meta.env.DEV;');
    expect(source).toContain(
      "import { apiClient, streamingApiClient, IS_DEV_BUILD } from '../client';"
    );
    expect(body).toContain('window.__ihubStreamTimeoutMs');
    expect(body).toContain('shortenedTimeout(');
  });
});

describe('a lost reply: the turn is looked for before an error is shown', () => {
  test.each([
    ['the timeout of the browser', timedOut],
    ['a 504 of a proxy', gatewayTimeout],
    ['a 502 of a proxy', badGateway]
  ])('after %s, a turn the server is running is followed at once', async (_name, lostReply) => {
    const onMessageAccepted = jest.fn();
    mockApi.sendAppChatMessage.mockRejectedValueOnce(lostReply());
    const { result } = render({ onMessageAccepted });
    const assistant = send(result);
    await connect();

    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledWith('app1', CHAT_ID, CHECK_OPTIONS);
    expect(onMessageAccepted).toHaveBeenCalledWith(CHAT_ID);
    expect(messageOf(result, assistant.id).content).toBe('');
    expect(messageOf(result, assistant.id).loading).toBe(true);
    expect(result.current.processing).toBe(true);
    expect(mockStream.detachEventSource).not.toHaveBeenCalled();

    // The stream connects once more (it was reopened): the message the server
    // already has is not sent a second time.
    await connect();
    expect(mockApi.sendAppChatMessage).toHaveBeenCalledTimes(1);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
  });

  test('a failed status check is repeated after 1 s, and the turn is followed', async () => {
    const onMessageAccepted = jest.fn();
    mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
    mockApi.checkAppChatStatus.mockRejectedValueOnce(noAnswer());
    const { result } = render({ onMessageAccepted });
    const assistant = send(result);
    await connect();

    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
    // Nothing is decided while the second check is due.
    await advance(999);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
    expect(onMessageAccepted).not.toHaveBeenCalled();
    expect(messageOf(result, assistant.id).content).not.toContain(TIMEOUT_EN);
    expect(result.current.processing).toBe(true);

    await advance(1);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(2);
    expect(onMessageAccepted).toHaveBeenCalledWith(CHAT_ID);
    expect(messageOf(result, assistant.id).content).not.toContain(TIMEOUT_EN);
    expect(result.current.processing).toBe(true);
    expect(mockStream.detachEventSource).not.toHaveBeenCalled();
  });

  test('the check is made four times in all: at once, then after 1 s, 2 s and 4 s', async () => {
    expect(LOST_REPLY_STATUS_RETRY_MS).toEqual([1000, 2000, 4000]);
    mockApi.sendAppChatMessage.mockRejectedValueOnce(gatewayTimeout());
    mockApi.checkAppChatStatus
      .mockRejectedValueOnce(noAnswer())
      .mockRejectedValueOnce(refused(502))
      .mockRejectedValueOnce(refused(429));
    const onMessageAccepted = jest.fn();
    const { result } = render({ onMessageAccepted });
    const assistant = send(result);
    await connect();

    const calls = () => mockApi.checkAppChatStatus.mock.calls.length;
    expect(calls()).toBe(1);
    await advance(1000);
    expect(calls()).toBe(2);
    await advance(1999);
    expect(calls()).toBe(2);
    await advance(1);
    expect(calls()).toBe(3);
    await advance(3999);
    expect(calls()).toBe(3);
    expect(onMessageAccepted).not.toHaveBeenCalled();
    await advance(1);
    expect(calls()).toBe(4);

    // The fourth check answered: the turn is running.
    expect(onMessageAccepted).toHaveBeenCalledWith(CHAT_ID);
    expect(messageOf(result, assistant.id).content).toBe('');
    expect(result.current.processing).toBe(true);
  });

  test('when every check fails, the error is shown and the stream is let go', async () => {
    mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
    mockApi.checkAppChatStatus.mockRejectedValue(noAnswer());
    const { result } = render();
    const assistant = send(result);
    await connect();

    await advance(6999);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(3);
    expect(messageOf(result, assistant.id).content).not.toContain(TIMEOUT_EN);
    expect(result.current.processing).toBe(true);

    await advance(1);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(4);
    expect(messageOf(result, assistant.id).content).toContain(TIMEOUT_EN);
    expect(messageOf(result, assistant.id).loading).toBe(false);
    expect(result.current.processing).toBe(false);
    expect(mockStream.detachEventSource).toHaveBeenCalledTimes(1);

    // No fifth check, however long one waits.
    await advance(60000);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(4);
  });

  test('a check that gets no answer is given up after 5 s and repeated', async () => {
    expect(LOST_REPLY_STATUS_TIMEOUT_MS).toBe(5000);
    const onMessageAccepted = jest.fn();
    mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
    mockApi.checkAppChatStatus.mockImplementationOnce(hangingCheck);
    const { result } = render({ onMessageAccepted });
    const assistant = send(result);
    await connect();

    // The first check hangs for its 5 s, the second is due 1 s later.
    await advance(5999);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
    expect(onMessageAccepted).not.toHaveBeenCalled();
    await advance(1);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(2);
    expect(mockApi.checkAppChatStatus).toHaveBeenLastCalledWith('app1', CHAT_ID, CHECK_OPTIONS);
    expect(onMessageAccepted).toHaveBeenCalledWith(CHAT_ID);
    expect(messageOf(result, assistant.id).content).toBe('');
    expect(result.current.processing).toBe(true);
  });

  test('when no check gets an answer, the error shows after 27 s, not after two minutes', async () => {
    mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
    mockApi.checkAppChatStatus.mockImplementation(hangingCheck);
    const { result } = render();
    const assistant = send(result);
    await connect();

    // Four checks of 5 s each, and the waits of 1 s, 2 s and 4 s between them.
    const checks = LOST_REPLY_STATUS_RETRY_MS.length + 1;
    const longest =
      checks * LOST_REPLY_STATUS_TIMEOUT_MS +
      LOST_REPLY_STATUS_RETRY_MS.reduce((sum, ms) => sum + ms, 0);
    expect(longest).toBe(27000);

    await advance(longest - 1);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(checks);
    for (const call of mockApi.checkAppChatStatus.mock.calls) {
      expect(call).toEqual(['app1', CHAT_ID, CHECK_OPTIONS]);
    }
    expect(messageOf(result, assistant.id).content).not.toContain(TIMEOUT_EN);
    expect(result.current.processing).toBe(true);

    await advance(1);
    expect(messageOf(result, assistant.id).content).toContain(TIMEOUT_EN);
    expect(messageOf(result, assistant.id).loading).toBe(false);
    expect(result.current.processing).toBe(false);
    expect(mockStream.detachEventSource).toHaveBeenCalledTimes(1);

    await advance(120000);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(checks);
  });

  test('the status request is made with the timeout it is given', () => {
    // `api/endpoints/apps.js` reads `import.meta.env`, which jest cannot load:
    // its source is read instead.
    const source = fs.readFileSync(path.join(repoRoot, 'client/src/api/endpoints/apps.js'), 'utf8');
    const fn = source.slice(source.indexOf('export const checkAppChatStatus = '));
    const body = fn.slice(0, fn.indexOf('\n};')).replace(/\s+/g, ' ');
    expect(body).toContain('async (appId, chatId, { timeout } = {}) =>');
    expect(body).toContain(
      'apiClient.get( `/apps/${appId}/chat/${chatId}/status`, ' +
        'Number.isFinite(timeout) && timeout > 0 ? { timeout } : undefined )'
    );
  });

  test('an answer that nothing is running is final: the error shows at once', async () => {
    mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
    mockApi.checkAppChatStatus.mockResolvedValue({ active: false });
    const { result } = render();
    const assistant = send(result);
    await connect();

    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
    expect(messageOf(result, assistant.id).content).toContain(TIMEOUT_EN);
    expect(result.current.processing).toBe(false);
    await advance(60000);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
  });

  test.each([401, 403, 404])(
    'a status check refused with %s is an answer and is not repeated',
    async status => {
      mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
      mockApi.checkAppChatStatus.mockRejectedValue(refused(status));
      const { result } = render();
      const assistant = send(result);
      await connect();

      expect(messageOf(result, assistant.id).content).toContain(TIMEOUT_EN);
      await advance(60000);
      expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
    }
  );

  test('a request that really failed shows the error in German too', async () => {
    await i18next.changeLanguage('de');
    mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
    mockApi.checkAppChatStatus.mockResolvedValue({ active: false });
    const { result } = render();
    const assistant = send(result);
    await connect();

    expect(messageOf(result, assistant.id).content).toContain(TIMEOUT_DE);
    expect(messageOf(result, assistant.id).content).not.toContain(TIMEOUT_EN);
    expect(result.current.processing).toBe(false);
  });

  // docs/troubleshooting.md names this text for a reply a proxy lost: the error
  // shown is the one of the POST, and a 502 or 504 is not a timeout.
  test.each([
    ['502', badGateway],
    ['504', gatewayTimeout]
  ])(
    'a %s of a proxy with nothing running ends with the server error text',
    async (_status, lostReply) => {
      mockApi.sendAppChatMessage.mockRejectedValueOnce(lostReply());
      mockApi.checkAppChatStatus.mockResolvedValue({ active: false });
      const { result } = render();
      const assistant = send(result);
      await connect();

      expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
      expect(messageOf(result, assistant.id).content).toContain(
        'A server error occurred. Please try again later.'
      );
      expect(messageOf(result, assistant.id).content).not.toContain(TIMEOUT_EN);
      expect(result.current.processing).toBe(false);
    }
  );

  test('a refusal is not a lost reply: no status check, the error shows', async () => {
    mockApi.sendAppChatMessage.mockRejectedValueOnce(
      enhanceApiError({
        message: 'Request failed with status code 400',
        response: { status: 400, data: { code: 'VALIDATION_ERROR', detail: 'No model.' } }
      })
    );
    const { result } = render();
    const assistant = send(result);
    await connect();

    expect(mockApi.checkAppChatStatus).not.toHaveBeenCalled();
    expect(messageOf(result, assistant.id).content).toContain('No model.');
    expect(result.current.processing).toBe(false);
  });
});

describe('a lost reply: the stream is the second witness', () => {
  test('a turn whose run the stream has shown is followed although every check fails', async () => {
    const onMessageAccepted = jest.fn();
    let rejectPost;
    mockApi.sendAppChatMessage.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPost = reject;
      })
    );
    mockApi.checkAppChatStatus.mockRejectedValue(noAnswer());
    const { result } = render({ onMessageAccepted });
    const assistant = send(result);
    await connect();
    await startRun(assistant.id);
    await deliver('step/delta', { step: 0, kind: 'text', content: 'So far' });

    await act(async () => {
      rejectPost(timedOut());
      await jest.advanceTimersByTimeAsync(0);
    });

    // One check was made; the stream's word is enough, nothing is waited for.
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
    expect(onMessageAccepted).toHaveBeenCalledWith(CHAT_ID);
    expect(messageOf(result, assistant.id).content).toBe('So far');
    expect(result.current.processing).toBe(true);
    expect(mockStream.detachEventSource).not.toHaveBeenCalled();
    await advance(60000);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
  });

  test('a turn that ended while it was looked for keeps its answer without an error', async () => {
    let rejectPost;
    mockApi.sendAppChatMessage.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPost = reject;
      })
    );
    // The turn ends while the first check is on its way; the server then runs nothing.
    mockApi.checkAppChatStatus.mockResolvedValue({ active: true, processing: false });
    const { result } = render();
    const assistant = send(result);
    await connect();
    await startRun(assistant.id);
    await deliver('step/delta', { step: 0, kind: 'text', content: 'The whole answer' });
    await deliver('run/ended', { status: 'completed', finishReason: 'stop' });
    expect(result.current.processing).toBe(false);

    await act(async () => {
      rejectPost(gatewayTimeout());
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(messageOf(result, assistant.id).content).toBe('The whole answer');
    expect(result.current.processing).toBe(false);
    expect(mockStream.detachEventSource).not.toHaveBeenCalled();
  });

  test('the run of another exchange proves nothing', async () => {
    let rejectPost;
    mockApi.sendAppChatMessage.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPost = reject;
      })
    );
    mockApi.checkAppChatStatus.mockResolvedValue({ active: true, processing: false });
    const { result } = render();
    const assistant = send(result);
    await connect();
    await startRun('msg-of-another-turn');

    await act(async () => {
      rejectPost(timedOut());
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(messageOf(result, assistant.id).content).toContain(TIMEOUT_EN);
    expect(result.current.processing).toBe(false);
  });
});

describe('a lost reply: what it never does', () => {
  test('it never stops the turn, whether the turn is found or not', async () => {
    for (const status of [{ active: true, processing: true }, { active: false }]) {
      mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
      mockApi.checkAppChatStatus.mockResolvedValue(status);
      const { result, unmount } = render();
      send(result);
      await connect();
      await advance(60000);
      unmount();
    }
    mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
    mockApi.checkAppChatStatus.mockRejectedValue(noAnswer());
    const { result } = render();
    send(result);
    await connect();
    await advance(60000);

    expect(mockStream.stopEventSource).not.toHaveBeenCalled();
    expect(mockApi.stopAppChatStream).not.toHaveBeenCalled();
  });

  test('it writes nothing into the chat the user has opened meanwhile', async () => {
    mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
    mockApi.checkAppChatStatus.mockRejectedValue(noAnswer());
    const { result, rerender } = render();
    send(result);
    await connect();
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);

    // The user opens another chat while the second check is due, and sends there.
    rerender({ chatId: 'chat-other' });
    mockApi.sendAppChatMessage.mockReturnValueOnce(new Promise(() => {}));
    const other = send(result, 'in the other chat');
    await connect('chat-other');

    await advance(60000);
    // The search ended with the chat it belonged to…
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
    // …and the chat now open keeps its stream and its answer.
    expect(mockStream.detachEventSource).not.toHaveBeenCalled();
    expect(messageOf(result, other.id).content).toBe('');
    expect(messageOf(result, other.id).loading).toBe(true);
    expect(result.current.processing).toBe(true);
  });

  test.each([
    ['that nothing is running', { active: false }],
    ['that the turn is running', { active: true, processing: true }]
  ])(
    'a check that answers %s after the user moved on changes nothing in the chat now open',
    async (_name, answer) => {
      const onMessageAccepted = jest.fn();
      const check = held();
      mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
      mockApi.checkAppChatStatus.mockReturnValueOnce(check.promise);
      const { result, rerender } = render({ onMessageAccepted });
      send(result);
      await connect();
      expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);

      // The user opens another chat and sends there while the check is on its
      // way; the stream of that chat is not connected yet.
      rerender({ chatId: 'chat-other', onMessageAccepted });
      mockApi.sendAppChatMessage.mockReturnValueOnce(new Promise(() => {}));
      const other = send(result, 'in the other chat');

      await act(async () => {
        check.resolve(answer);
        await jest.advanceTimersByTimeAsync(0);
      });
      await advance(60000);

      // The answer is about the chat that was left: no error text under the
      // answer of the chat now open, and its stream is kept…
      expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);
      expect(onMessageAccepted).not.toHaveBeenCalled();
      expect(mockStream.detachEventSource).not.toHaveBeenCalled();
      expect(messageOf(result, other.id).content).toBe('');
      expect(messageOf(result, other.id).loading).toBe(true);
      expect(result.current.processing).toBe(true);

      // …and its message still goes out when its stream connects.
      await connect('chat-other');
      expect(mockApi.sendAppChatMessage).toHaveBeenCalledTimes(2);
      expect(mockApi.sendAppChatMessage.mock.calls[1].slice(0, 2)).toEqual(['app1', 'chat-other']);
      expect(messageOf(result, other.id).content).toBe('');
      expect(messageOf(result, other.id).loading).toBe(true);
    }
  );

  test('Stop while the turn is looked for ends the search without an error text', async () => {
    mockApi.sendAppChatMessage.mockRejectedValueOnce(timedOut());
    mockApi.checkAppChatStatus
      .mockRejectedValueOnce(noAnswer())
      .mockResolvedValue({ active: false });
    const { result } = render();
    const assistant = send(result);
    await connect();
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(1);

    // Stop long before the second check is due: its own 100 ms guard has passed by then.
    await advance(300);
    act(() => result.current.cancelGeneration());
    await advance(700);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(2);

    await advance(60000);
    expect(mockApi.checkAppChatStatus).toHaveBeenCalledTimes(2);
    expect(messageOf(result, assistant.id).content).not.toContain(TIMEOUT_EN);
    expect(messageOf(result, assistant.id).cancelled).toBe(true);
    expect(result.current.processing).toBe(false);
  });
});
