/**
 * Shared SSE transport for every run-scoped stream (chat, workflow execution,
 * agent run, tool-service progress).
 *
 * Uses `fetch` + `ReadableStream` instead of the native `EventSource` so that
 * custom `Authorization` headers can be injected (Office add-in / PKCE Bearer
 * tokens) and a 401 can be recovered with a silent token refresh. Both
 * `useEventSource` (chat) and `useRunStream` (workflow / agent) sit on top of
 * this module so there is exactly one place that knows how a stream is opened.
 *
 * SSE v2 wire contract: every frame is `event: <type>` + `data: <envelope>`
 * where envelope = `{ v: 2, seq, runId, ts, type, data }` (see
 * shared/runEvents.js and server/services/loop/contracts/sseV2.js).
 *
 * @module shared/utils/openSseStream
 */
import { parseSseStream } from './parseSseStream';
import { getRefreshToken, refreshTokenOrExpireSession } from '../../features/office/api/officeAuth';

/** SSE v2 protocol version accepted by the client reducer. */
export const SSE_PROTOCOL_VERSION = 2;

/** Error code used for envelopes the client synthesises when the transport fails. */
export const TRANSPORT_ERROR_CODES = Object.freeze({
  CONNECTION: 'CONNECTION_ERROR',
  HTTP: 'HTTP_ERROR',
  TIMEOUT: 'CONNECTION_TIMEOUT',
  READ: 'STREAM_READ_ERROR'
});

/**
 * Error thrown when the stream endpoint answers with a non-2xx status.
 */
export class SseHttpError extends Error {
  /**
   * @param {string} message - Human readable message (server `message` or a fallback)
   * @param {number} status - HTTP status code
   * @param {Object|null} body - Parsed JSON body when the server sent one
   */
  constructor(message, status, body = null) {
    super(message);
    this.name = 'SseHttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Build auth headers for stream / re-sync requests.
 * Mirrors the behaviour of apiClient's request interceptor:
 * - Reads `authToken` from localStorage (main app session)
 * - Falls back to `office_ihubtoken` (Office add-in PKCE token)
 *
 * @returns {Object} `{ Authorization }` or an empty object when no token is stored
 */
export function getSseAuthHeaders() {
  let token = null;
  try {
    token = localStorage.getItem('office_ihubtoken') || localStorage.getItem('authToken') || null;
  } catch {
    // localStorage unavailable (privacy mode / sandbox) — fall back to cookies only
  }
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * `fetch` with credentials, Bearer header and a single silent-refresh retry on
 * 401 for the Office add-in (keyed off `getRefreshToken()` so the refresh is
 * attempted even when the access token is already gone but a refresh token
 * exists). `refreshTokenOrExpireSession()` invokes the session-expired callback
 * and throws when the refresh itself fails.
 *
 * @param {string} url - Absolute or relative URL
 * @param {RequestInit} [init] - Fetch options (headers are merged with the auth header)
 * @returns {Promise<Response>}
 */
export async function fetchWithAuthRetry(url, init = {}) {
  const doFetch = () =>
    fetch(url, {
      method: 'GET',
      credentials: 'include',
      ...init,
      headers: { ...(init.headers || {}), ...getSseAuthHeaders() }
    });

  let res = await doFetch();
  if (res.status === 401 && getRefreshToken()) {
    await refreshTokenOrExpireSession();
    res = await doFetch();
  }
  return res;
}

/**
 * Open an SSE stream and pump every dispatched frame into `onEvent(name, data)`.
 * Resolves when the server closes the stream or `signal` is aborted; rejects
 * with `SseHttpError` on a non-OK response, or with the underlying fetch error.
 *
 * @param {string} url - Stream URL
 * @param {Object} options
 * @param {AbortSignal} [options.signal] - Abort to close the stream
 * @param {Function} options.onEvent - `(eventName, payload) => void` for each frame
 * @param {Function} [options.onOpen] - Called once with the Response when headers arrived
 * @returns {Promise<void>}
 */
export async function openSseStream(url, { signal, onEvent, onOpen } = {}) {
  const res = await fetchWithAuthRetry(url, {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
    signal
  });

  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON error body — keep the status-based message
    }
    throw new SseHttpError(
      (body && body.message) || `SSE connection failed (${res.status})`,
      res.status,
      body
    );
  }

  if (!res.body) {
    throw new Error('SSE response has no readable body');
  }

  if (onOpen) onOpen(res);
  await parseSseStream(res.body, onEvent, signal);
}

/**
 * Build a client-side `stream/error` envelope for transport failures so that
 * consumers only ever deal with v2 envelopes. Has no `seq` (it never took part
 * in the server sequence) and is flagged `synthetic: true`.
 *
 * @param {string|null} streamId - Stream id the error belongs to (chatId / executionId)
 * @param {string} message - Human readable message
 * @param {string} [code] - One of TRANSPORT_ERROR_CODES
 * @param {Object} [details] - Extra details (e.g. `{ status }`)
 * @returns {Object} SSE v2 envelope
 */
export function syntheticStreamError(
  streamId,
  message,
  code = TRANSPORT_ERROR_CODES.CONNECTION,
  details = undefined
) {
  return {
    v: SSE_PROTOCOL_VERSION,
    runId: streamId || 'stream',
    ts: new Date().toISOString(),
    type: 'stream/error',
    data: {
      code,
      message,
      retryable: false,
      ...(details !== undefined ? { details } : {})
    },
    synthetic: true
  };
}

/**
 * Normalise a raw SSE frame into an SSE v2 envelope.
 *
 * - `data` that already is a v2 envelope is returned as-is.
 * - A parser-level `error` frame (emitted by parseSseStream on read failures)
 *   becomes a synthetic `stream/error` envelope.
 * - Anything else (heartbeat comments, legacy frames) is dropped (`null`).
 *
 * @param {string} name - SSE event name
 * @param {Object} data - Parsed frame payload
 * @param {string|null} streamId - Stream id used for synthetic errors
 * @returns {Object|null}
 */
export function toRunEnvelope(name, data, streamId) {
  if (
    data &&
    typeof data === 'object' &&
    data.v === SSE_PROTOCOL_VERSION &&
    typeof data.type === 'string'
  ) {
    return data;
  }
  if (name === 'error') {
    return syntheticStreamError(
      streamId,
      (data && data.message) || 'Stream reading error',
      TRANSPORT_ERROR_CODES.READ
    );
  }
  return null;
}
