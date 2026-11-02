// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test helpers for the integration connection flow: a fake token endpoint and
 * a full connect (begin + callback) through the connection service, so tests
 * exercise the real sign-in path (PKCE, server-side state, token storage,
 * index) without a network.
 */

/**
 * A fetch that answers like an OAuth token endpoint and records every call.
 *
 * @param {Array<Object|((call: Object) => Object)>} answers - Token responses, used in order
 *   (the last one repeats). An answer with `status` >= 400 is an error answer with
 *   the given `body`.
 * @returns {Function & {calls: Array<{url: string, params: URLSearchParams, headers: Object}>}}
 */
export function fakeTokenEndpoint(answers = [{}]) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const params = new URLSearchParams(String(init.body || ''));
    const call = { url: String(url), params, headers: init.headers || {} };
    calls.push(call);
    const pick = answers[Math.min(calls.length - 1, answers.length - 1)];
    const answer = typeof pick === 'function' ? pick(call) : pick;
    const status = answer.status || 200;
    const body =
      status >= 400
        ? answer.body || { error: 'invalid_request' }
        : {
            access_token: `access-${calls.length}`,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: `refresh-${calls.length}`,
            ...answer
          };
    return {
      ok: status < 400,
      status,
      statusText: status < 400 ? 'OK' : 'Error',
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

/**
 * A request as Express hands it over, with `get()` and `hostname`.
 * @param {Object} [options]
 * @returns {Object}
 */
export function fakeRequest({
  headers = {},
  user,
  query = {},
  params = {},
  protocol = 'https'
} = {}) {
  const lower = Object.fromEntries(
    Object.entries({ host: 'ihub.example', ...headers }).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    headers: lower,
    protocol,
    hostname: String(lower['x-forwarded-host'] || lower.host).split(':')[0],
    get: name => lower[name.toLowerCase()],
    user,
    query,
    params
  };
}

/**
 * Connect a user through the connection service: begin (authorization URL
 * with a server-side state) and complete (the callback with a code).
 *
 * @param {Object} params
 * @param {import('../../services/integrations/auth/IntegrationConnectionService.js').IntegrationConnectionService} params.service
 * @param {string} params.installationId
 * @param {string} params.userId
 * @param {Object} [params.alias] - What the callback path names
 * @returns {Promise<{authorizationUrl: URL, outcome: Object}>}
 */
export async function connectThroughService({ service, installationId, userId, alias = {} }) {
  // A member whose groups grant every integration (`permissions.integrations`).
  const user = { id: userId, groups: ['users'], permissions: { integrations: ['*'] } };
  const { authorizationUrl } = await service.beginConnect({
    installationId,
    user,
    req: fakeRequest({ user }),
    returnUrl: '/settings/integrations'
  });
  const state = authorizationUrl.searchParams.get('state');
  const outcome = await service.completeConnect({
    req: fakeRequest({ user, query: { code: 'the-code', state } }),
    alias
  });
  return { authorizationUrl, outcome };
}
