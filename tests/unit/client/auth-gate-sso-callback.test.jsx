// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The auth gate after an SSO provider (OIDC, NTLM) sent the browser back.
 *
 * The provider callback sets the httpOnly `authToken` cookie and no longer puts
 * the token in the redirect URL. The server reads an `Authorization: Bearer`
 * header before the cookie, and the gate sends whatever `authToken` is in
 * localStorage. An old token there (expired, or another user's) therefore
 * answered "not signed in" for the fresh cookie, the gate painted the login
 * screen again, and the user went round in circles. Before the token left the
 * URL the callback overwrote the stored one, which hid this.
 */
import fs from 'node:fs';
import path from 'node:path';

const GATE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../../client/src/auth-gate/auth-gate.js'),
  'utf8'
);

const STATUS_ANONYMOUS = {
  success: true,
  authenticated: false,
  authMode: 'oidc',
  authMethods: {
    oidc: { enabled: true, providers: [{ name: 'corp', displayName: 'Corp SSO' }] }
  }
};
const STATUS_SIGNED_IN = { ...STATUS_ANONYMOUS, authenticated: true, user: { id: 'u1' } };

/**
 * Stand-in for the server: the Authorization header wins over the cookie, and
 * the cookie of this test is a valid session. Only a stored token that is
 * *not* sent lets the cookie through.
 */
function installServer() {
  const calls = [];
  global.fetch = jest.fn(async (url, options = {}) => {
    const authorization = options.headers && options.headers.Authorization;
    calls.push({ url, authorization });
    const body = authorization ? STATUS_ANONYMOUS : STATUS_SIGNED_IN;
    return { ok: true, json: async () => body };
  });
  return calls;
}

async function runGate(search) {
  window.history.replaceState({}, '', `/${search}`);
  document.body.innerHTML =
    '<div id="auth-gate-root"></div><div id="root" style="display:none"></div>';
  window.__AUTH_GATE_DEV_MODE__ = true;
  window.__BASE_PATH__ = '';
  global.__authGateI18n = { t: key => key };
  new Function(GATE_SOURCE)();
  // Let the status promise chain settle.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('authToken', 'stale.token.from.an.earlier.session');
});

afterEach(() => {
  jest.useRealTimers();
  delete global.fetch;
});

test.each([
  ['OIDC', '?oidc=success&provider=corp'],
  ['NTLM', '?ntlm=success']
])(
  'after the %s callback the stored token is not sent in front of the new cookie',
  async (_, query) => {
    const calls = installServer();

    await runGate(query);

    expect(localStorage.getItem('authToken')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBeUndefined();
    // Signed in: the gate hands over to the app instead of showing the login again.
    jest.advanceTimersByTime(300);
    expect(document.getElementById('auth-gate-root').classList.contains('ag-hidden')).toBe(true);
    expect(document.querySelector('.ag-btn')).toBeNull();
  }
);

test('a plain page load keeps the stored token (Teams, add-in and extension rely on it)', async () => {
  const calls = installServer();

  await runGate('');

  expect(localStorage.getItem('authToken')).toBe('stale.token.from.an.earlier.session');
  expect(calls[0].authorization).toBe('Bearer stale.token.from.an.earlier.session');
});
