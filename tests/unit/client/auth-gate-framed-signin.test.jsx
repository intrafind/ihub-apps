// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The auth gate when iHub is shown in a frame of another site (iFinder, a portal).
 *
 * An identity provider such as Microsoft Entra ID refuses to be framed, so the
 * gate must not navigate the frame to it. A click opens a popup instead; the
 * popup hands the frame a one-time code, and the frame redeems it with the PKCE
 * verifier that never left it. The session is then an HttpOnly cookie: the gate
 * never reads or stores a token.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextEncoder } from 'node:util';

const GATE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../../client/src/auth-gate/auth-gate.js'),
  'utf8'
);

const STATUS_ANONYMOUS = {
  success: true,
  authenticated: false,
  authMode: 'oidc',
  embedSignIn: true,
  // The only way in is one provider that redirects at once: the case that breaks in a frame.
  autoRedirect: { provider: 'corp', url: '/api/auth/oidc/corp' },
  authMethods: {
    oidc: { enabled: true, providers: [{ name: 'corp', displayName: 'Corp SSO' }] }
  }
};
const STATUS_SIGNED_IN = { ...STATUS_ANONYMOUS, authenticated: true, user: { id: 'u1' } };

const sha256Base64Url = value => crypto.createHash('sha256').update(value).digest('base64url');

/** Stand-in for the server. `redeem` and `status` answer the two calls the flow makes. */
function installServer({ redeemOk = true, afterRedeem = STATUS_SIGNED_IN } = {}) {
  const calls = [];
  let redeemed = false;
  global.fetch = jest.fn(async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/auth/embed-codes/_redeem')) {
      redeemed = redeemOk;
      return redeemOk
        ? { ok: true, json: async () => ({ expiresInSeconds: 3600 }) }
        : { ok: false };
    }
    return { ok: true, json: async () => (redeemed ? afterRedeem : STATUS_ANONYMOUS) };
  });
  return calls;
}

/** The hashes the gate started: in a browser they are long done before a click. */
let pendingDigests = [];

/** `window.crypto` of the real Node implementation, with its hashing observable. */
const observableCrypto = {
  getRandomValues: array => crypto.webcrypto.getRandomValues(array),
  subtle: {
    digest: (...args) => {
      const done = crypto.webcrypto.subtle.digest(...args);
      pendingDigests.push(done);
      return done;
    }
  }
};

/**
 * Let pending promises settle, including the hash of every verifier the gate made. Hashing runs
 * on Node's thread pool, so waiting for the promise is the only way that holds under load.
 */
const settle = async () => {
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const waiting = pendingDigests.splice(0);
    if (waiting.length === 0) break;
    await Promise.all(waiting);
  }
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let popup;

async function runGate({ framed = true, openPopup = true } = {}) {
  window.history.replaceState({}, '', '/');
  document.body.innerHTML =
    '<div id="auth-gate-root"></div><div id="root" style="display:none"></div>';
  window.__AUTH_GATE_DEV_MODE__ = true;
  window.__BASE_PATH__ = '';
  global.__authGateI18n = { t: key => key };
  global.TextEncoder = TextEncoder;
  pendingDigests = [];
  Object.defineProperty(window, 'crypto', { value: observableCrypto, configurable: true });
  popup = { closed: false, focus: jest.fn() };
  window.open = jest.fn(() => (openPopup ? popup : null));
  new Function('window', GATE_SOURCE)(windowThatIs(framed ? 'framed' : 'top-level'));
  await settle();
}

/**
 * jsdom's `window.top` cannot be redefined, so the gate runs with a `window` of its own that is
 * the real one in every respect but `top`: another window when framed, itself otherwise.
 */
function windowThatIs(kind) {
  return new Proxy(window, {
    get(target, property) {
      if (property === 'top') return kind === 'framed' ? {} : target;
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  });
}

/** The popup tells the frame the code, as the page of the popup does. */
function popupSays(data, { origin = window.location.origin, source = popup } = {}) {
  const event = new MessageEvent('message', { data, origin });
  Object.defineProperty(event, 'source', { value: source });
  window.dispatchEvent(event);
}

const clickProvider = () => document.querySelector('.ag-btn').click();

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  jest.useRealTimers();
  delete global.fetch;
});

test('a framed page does not navigate to the identity provider on its own', async () => {
  installServer();

  await runGate();

  // The login is shown and waits for a click; nothing was opened or navigated.
  expect(document.querySelector('.ag-btn').textContent).toContain('Corp SSO');
  expect(window.open).not.toHaveBeenCalled();
});

test('a click opens the popup on the sign-in page with the PKCE challenge and the provider', async () => {
  installServer();
  await runGate();

  clickProvider();

  expect(window.open).toHaveBeenCalledTimes(1);
  const url = new URL(window.open.mock.calls[0][0], 'https://ihub.example.com');
  expect(url.pathname).toBe('/embed-auth/complete');
  expect(url.searchParams.get('provider')).toBe('corp');
  expect(url.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // The frame says what to do next, and cannot start a second popup.
  expect(document.querySelector('.ag-info').textContent).toBe('signInInProgress');
  expect(document.querySelector('.ag-btn').disabled).toBe(true);
});

test('the code is redeemed with the verifier of the challenge, and no token is stored', async () => {
  const calls = installServer();
  localStorage.setItem('authToken', 'stale.token.from.an.earlier.session');
  await runGate();
  clickProvider();
  const challenge = new URL(
    window.open.mock.calls[0][0],
    'https://ihub.example.com'
  ).searchParams.get('challenge');

  popupSays({ kind: 'ihub.embedAuth.code', code: 'handle.secret' });
  await settle();

  const redeem = calls.find(call => String(call.url).endsWith('/auth/embed-codes/_redeem'));
  expect(redeem.options.method).toBe('POST');
  expect(redeem.options.credentials).toBe('include');
  const body = JSON.parse(redeem.options.body);
  expect(body.code).toBe('handle.secret');
  expect(sha256Base64Url(body.codeVerifier)).toBe(challenge);
  expect(redeem.options.headers.Authorization).toBeUndefined();

  // The session is the cookie: a stale token must not be sent in front of it, and none is stored.
  expect(localStorage.getItem('authToken')).toBeNull();
  const status = calls.filter(call => String(call.url).endsWith('/auth/status')).at(-1);
  expect(status.options.headers.Authorization).toBeUndefined();

  // Signed in: the gate hands over to the app.
  jest.advanceTimersByTime(300);
  expect(document.getElementById('auth-gate-root').classList.contains('ag-hidden')).toBe(true);
});

test('tells the app that the sign-in succeeded', async () => {
  installServer();
  const succeeded = jest.fn();
  window.addEventListener('authGateSuccess', succeeded);
  await runGate();
  clickProvider();

  popupSays({ kind: 'ihub.embedAuth.code', code: 'handle.secret' });
  await settle();
  jest.advanceTimersByTime(300);

  expect(succeeded).toHaveBeenCalled();
  window.removeEventListener('authGateSuccess', succeeded);
});

describe('what the frame does not accept from the popup', () => {
  const message = { kind: 'ihub.embedAuth.code', code: 'handle.secret' };
  const redeemCalls = calls => calls.filter(c => String(c.url).endsWith('/_redeem'));

  test('a message from another origin', async () => {
    const calls = installServer();
    await runGate();
    clickProvider();

    popupSays(message, { origin: 'https://evil.example.com' });
    await settle();

    expect(redeemCalls(calls)).toHaveLength(0);
  });

  test('a message from a window that is not the popup', async () => {
    const calls = installServer();
    await runGate();
    clickProvider();

    popupSays(message, { source: window });
    await settle();

    expect(redeemCalls(calls)).toHaveLength(0);
  });

  test('another kind of message, or one without a code', async () => {
    const calls = installServer();
    await runGate();
    clickProvider();

    popupSays({ kind: 'something.else', code: 'handle.secret' });
    popupSays({ kind: 'ihub.embedAuth.code' });
    popupSays({ kind: 'ihub.embedAuth.code', code: 42 });
    popupSays('handle.secret');
    await settle();

    expect(redeemCalls(calls)).toHaveLength(0);
  });
});

test('says so when the browser blocked the popup', async () => {
  installServer();
  await runGate({ openPopup: false });

  clickProvider();

  expect(document.querySelector('.ag-error').textContent).toBe('signInPopupBlocked');
});

test('says so when the popup is closed before the sign-in is finished', async () => {
  installServer();
  await runGate();
  clickProvider();

  popup.closed = true;
  jest.advanceTimersByTime(3000);

  expect(document.querySelector('.ag-error').textContent).toBe('signInWindowClosed');
  // The login can be started again.
  expect(document.querySelector('.ag-btn').disabled).toBe(false);
});

test('lets a message that arrives just before the popup closes win over the close', async () => {
  const calls = installServer();
  await runGate();
  clickProvider();

  popup.closed = true;
  jest.advanceTimersByTime(500);
  popupSays({ kind: 'ihub.embedAuth.code', code: 'handle.secret' });
  await settle();
  jest.advanceTimersByTime(3000);

  expect(calls.some(c => String(c.url).endsWith('/_redeem'))).toBe(true);
  expect(document.querySelector('.ag-error')).toBeNull();
});

describe('without the sign-in in a frame set up (embedSignIn off), nothing changes', () => {
  const statusWithout = extra => ({ ...STATUS_ANONYMOUS, embedSignIn: false, ...extra });
  const serveStatus = body => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => body }));
  };

  test('a framed page still redirects to the only provider, which may allow framing', async () => {
    serveStatus(statusWithout());

    await runGate();

    // The redirect branch ran (it notes the attempt), so no login is painted and no popup opened.
    expect(sessionStorage.getItem('autoRedirect_corp')).not.toBeNull();
    expect(document.querySelector('.ag-btn')).toBeNull();
    expect(window.open).not.toHaveBeenCalled();
  });

  test('a click on a provider does not open a popup', async () => {
    serveStatus(statusWithout({ autoRedirect: null }));
    await runGate();

    clickProvider();

    expect(window.open).not.toHaveBeenCalled();
    expect(document.querySelector('.ag-error')).toBeNull();
  });
});

test('says so when the code is refused', async () => {
  installServer({ redeemOk: false });
  await runGate();
  clickProvider();

  popupSays({ kind: 'ihub.embedAuth.code', code: 'handle.secret' });
  await settle();

  expect(document.querySelector('.ag-error').textContent).toBe('signInFailed');
});

test('says so when the browser did not keep the session cookie', async () => {
  // The redeem call worked, but the next status check still sees nobody.
  installServer({ afterRedeem: STATUS_ANONYMOUS });
  await runGate();
  clickProvider();

  popupSays({ kind: 'ihub.embedAuth.code', code: 'handle.secret' });
  await settle();

  expect(document.querySelector('.ag-error').textContent).toBe('embedSignInCookieBlocked');
});

test('uses a new verifier for every popup', async () => {
  installServer();
  await runGate();
  clickProvider();
  popup.closed = true;
  jest.advanceTimersByTime(3000);
  await settle();
  popup.closed = false;

  clickProvider();

  const [first, second] = window.open.mock.calls.map(([url]) =>
    new URL(url, 'https://ihub.example.com').searchParams.get('challenge')
  );
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(second).not.toBe(first);
});

describe('a sign-in attempt belongs to the gate that started it', () => {
  const codeMessage = { kind: 'ihub.embedAuth.code', code: 'handle.secret' };
  const redeemCalls = calls => calls.filter(c => String(c.url).endsWith('/_redeem'));

  test('a popup that is still open when the gate is shown again hands nothing to the new gate', async () => {
    const calls = installServer();
    await runGate();
    clickProvider();

    window.__authGate.show({ overlay: true });
    await settle();
    popupSays(codeMessage);
    await settle();

    expect(redeemCalls(calls)).toHaveLength(0);
  });

  test('a redeem that is on its way when the gate is hidden ends without a trace', async () => {
    // The answer to the redeem is held back, so the gate is hidden while it is in flight.
    let answerRedeem;
    let statusCalls = 0;
    global.fetch = jest.fn(async url => {
      if (String(url).endsWith('/_redeem')) {
        await new Promise(resolve => {
          answerRedeem = resolve;
        });
        return { ok: true, json: async () => ({ expiresInSeconds: 3600 }) };
      }
      // The first status call is the gate's own, signed out; a second would be the check after the
      // redeem, which would sign in.
      statusCalls += 1;
      return {
        ok: true,
        json: async () => (statusCalls === 1 ? STATUS_ANONYMOUS : STATUS_SIGNED_IN)
      };
    });
    const succeeded = jest.fn();
    window.addEventListener('authGateSuccess', succeeded);
    await runGate();
    clickProvider();
    popupSays(codeMessage);
    await settle();
    expect(answerRedeem).toBeDefined();

    window.__authGate.hide();
    answerRedeem();
    await settle();
    jest.advanceTimersByTime(300);

    expect(statusCalls).toBe(1);
    expect(succeeded).not.toHaveBeenCalled();
    expect(document.querySelector('.ag-error')).toBeNull();
    window.removeEventListener('authGateSuccess', succeeded);
  });
});
