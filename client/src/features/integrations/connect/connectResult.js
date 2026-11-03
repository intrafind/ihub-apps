// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The outcome of a sign-in the browser just came back from.
 *
 * Every integration's sign-in returns to the page it started on (the return
 * URL) with the same parameters:
 *
 *   ?integration_connected=<installation id>
 *   ?integration_error=<code>&integration=<installation id>
 *
 * {@link readConnectResult} reads them once per page (path) and keeps the
 * result for that path, so every reader — the Connect cards, the chat's
 * retry, Settings → Integrations — sees the same answer. Readers use it
 * through `useConnectResult`, which reads during render and, in an effect,
 * removes the parameters from the URL ({@link consumeConnectResult}), so a
 * reload does not show the result again.
 *
 * @module features/integrations/connect/connectResult
 */

/** Query parameters the integration OAuth callback adds to the return URL. */
export const CONNECT_RESULT_PARAMS = Object.freeze([
  'integration_connected',
  'integration_error',
  'integration'
]);

/** Error codes with their own message (`integrations.connect.errors.<code>`). */
export const CONNECT_ERROR_CODES = Object.freeze([
  'access_denied',
  'oauth_failed',
  'missing_code',
  'invalid_state',
  'state_expired',
  'user_mismatch',
  'integration_not_found',
  'exchange_failed',
  'discovery_failed',
  'registration_failed',
  'issuer_mismatch',
  'public_url_mismatch',
  'invalid_client',
  'callback_failed'
]);

const EMPTY_RESULT = Object.freeze({ connected: null, error: null, errorIntegration: null });

/** The result read for one page (path). */
let consumed = null;

/**
 * Read the parameters from a URL without touching anything.
 *
 * @param {string} href
 * @returns {{connected: string|null, error: string|null, errorIntegration: string|null}}
 */
export function parseConnectResult(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return EMPTY_RESULT;
  }
  const error = url.searchParams.get('integration_error');
  return {
    connected: url.searchParams.get('integration_connected'),
    error: error ? (CONNECT_ERROR_CODES.includes(error) ? error : 'oauth_failed') : null,
    errorIntegration: error ? url.searchParams.get('integration') : null
  };
}

/**
 * The URL without the result parameters — where a sign-in should return to.
 *
 * @param {string} [href]
 * @returns {string}
 */
export function currentReturnUrl(href = window.location.href) {
  const url = new URL(href);
  for (const name of CONNECT_RESULT_PARAMS) url.searchParams.delete(name);
  return url.toString();
}

/**
 * The sign-in result of this page, read from the URL on the first call and
 * kept for that path. No side effect on the page (the URL is left alone), so
 * it may run during render — a `useState` initializer, for instance.
 *
 * @returns {{connected: string|null, error: string|null, errorIntegration: string|null}}
 */
export function readConnectResult() {
  if (typeof window === 'undefined' || !window.location) return EMPTY_RESULT;
  const path = window.location.pathname;
  if (consumed && consumed.path === path) return consumed.result;
  const result = parseConnectResult(window.location.href);
  consumed = { path, result };
  return result;
}

/**
 * The sign-in result of this page ({@link readConnectResult}), then the
 * result parameters removed from the URL (history entry replaced, the router
 * told through a `popstate`). Changes the history and dispatches an event:
 * call it from an effect or an event handler, never during render.
 *
 * @returns {{connected: string|null, error: string|null, errorIntegration: string|null}}
 */
export function consumeConnectResult() {
  const result = readConnectResult();
  if (typeof window === 'undefined' || !window.location) return result;
  const url = new URL(window.location.href);
  if (CONNECT_RESULT_PARAMS.some(name => url.searchParams.has(name))) {
    for (const name of CONNECT_RESULT_PARAMS) url.searchParams.delete(name);
    try {
      window.history.replaceState(window.history.state, '', url.toString());
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    } catch {
      /* a sandboxed frame may refuse; the result is still read once */
    }
  }
  return result;
}

/** Test seam: forget the result read for this page load. */
export function resetConnectResultForTests() {
  consumed = null;
}
