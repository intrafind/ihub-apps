// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Records the outbound HTTP requests one piece of work makes, so an admin can
 * see "the request as sent" when testing an integration action (#2974).
 *
 * The two outbound choke points report into it: `httpFetch`
 * (`utils/httpConfig.js`) and `safeFetch` (`services/mcp/safeFetch.js`, the
 * SSRF-guarded fetch of OpenAPI, MCP and A2A). Outside {@link recordOutbound}
 * nothing is recorded and reporting costs one `AsyncLocalStorage` lookup.
 *
 * What is kept is raw (headers and body as sent) and bounded; whoever shows
 * it redacts it first (`utils/secretRedaction.js`). The recording lives only
 * as long as the call that started it.
 *
 * @module utils/outboundRecorder
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Most requests one recording keeps. */
export const MAX_RECORDED_REQUESTS = 20;
/** Most characters of one request body kept. */
const MAX_BODY_CHARS = 64 * 1024;

const store = new AsyncLocalStorage();

/**
 * Run `fn` and record the outbound requests it makes.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{result?: T, error?: unknown, requests: Array<Object>}>}
 *   the requests, in the order they were sent, with the result or the error
 */
export async function recordOutbound(fn) {
  const requests = [];
  try {
    const result = await store.run({ requests }, fn);
    return { result, requests };
  } catch (error) {
    return { error, requests };
  }
}

/** A body as text, when it is one we can show. */
function bodyText(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return body.slice(0, MAX_BODY_CHARS);
  if (body?.constructor?.name === 'URLSearchParams')
    return body.toString().slice(0, MAX_BODY_CHARS);
  if (body instanceof Uint8Array) return `[${body.byteLength} bytes]`;
  if (typeof body.pipe === 'function' || typeof body.getReader === 'function') return '[stream]';
  if (typeof body === 'object') {
    try {
      return JSON.stringify(body).slice(0, MAX_BODY_CHARS);
    } catch {
      return '[unserializable]';
    }
  }
  return String(body).slice(0, MAX_BODY_CHARS);
}

/** Headers as a plain object (Headers, Map, array of pairs or object). */
function plainHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
    headers.forEach((value, key) => {
      out[key] = String(value);
    });
  } else if (Array.isArray(headers)) {
    for (const pair of headers) if (Array.isArray(pair)) out[pair[0]] = String(pair[1]);
  } else if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) out[key] = String(value);
  }
  return out;
}

/**
 * Report a request about to be sent. Returns a handle for its outcome, or
 * null outside a recording (or past the cap).
 *
 * @param {string|URL} url
 * @param {Object} [init] - fetch options (`method`, `headers`, `body`)
 * @returns {{done: (response: {status?: number}|null, error?: unknown) => void}|null}
 */
export function noteOutboundRequest(url, init = {}) {
  const recording = store.getStore();
  if (!recording || recording.requests.length >= MAX_RECORDED_REQUESTS) return null;
  const started = Date.now();
  const entry = {
    method: String(init?.method || 'GET').toUpperCase(),
    url: String(url),
    headers: plainHeaders(init?.headers),
    body: bodyText(init?.body),
    status: null,
    durationMs: null,
    error: null
  };
  recording.requests.push(entry);
  return {
    done(response, error) {
      entry.durationMs = Date.now() - started;
      if (response && Number.isInteger(response.status)) entry.status = response.status;
      if (error) entry.error = String(error?.message || error).slice(0, 500);
    }
  };
}

/**
 * Wrap a fetch-like call so it is recorded (when a recording is active).
 *
 * @template T
 * @param {string|URL} url
 * @param {Object} init
 * @param {() => Promise<T>} send
 * @returns {Promise<T>}
 */
export async function withOutboundRecording(url, init, send) {
  const handle = noteOutboundRequest(url, init);
  if (!handle) return send();
  try {
    const response = await send();
    handle.done(response);
    return response;
  } catch (error) {
    handle.done(null, error);
    throw error;
  }
}
