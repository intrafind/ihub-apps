// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Jira OAuth redirect URI: the installation's value when set, otherwise
 * derived from the request (scheme, host, base path, callback path) — and the
 * same value on the authorize redirect and on the token exchange.
 *
 * Run: node --test server/tests/jira-redirect-uri.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import tokenStorageService from '../services/TokenStorageService.js';
import JiraService from '../services/integrations/JiraService.js';
import {
  JIRA_CALLBACK_PATH,
  getJiraConfig,
  resolveJiraRedirectUri
} from '../services/integrations/jiraConfig.js';
import { redirectUriStep } from '../services/integrations/protocols/native/connectors/jira/index.js';
import jiraRouter from '../routes/integrations/jira.js';
import { runWithContext } from '../utils/requestContext.js';

// In-memory key material for the signed OAuth state; nothing touches disk.
tokenStorageService.encryptionKey = 'd'.repeat(64);
tokenStorageService.jwtSecret = 'jira-redirect-uri-test-secret';

const CONFIGURED = 'https://registered.example/api/integrations/jira/callback';

/** A request as Express would hand it over, with `get()` for headers. */
function fakeRequest({ headers = {}, protocol = 'http', ...rest } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: lower,
    protocol,
    get: name => lower[name.toLowerCase()],
    query: {},
    params: {},
    ...rest
  };
}

function installJira(values) {
  configCache.getIntegrations = () => ({
    data: {
      installed: [{ id: 'jira', definition: 'com.intrafind/jira', enabled: true, values }]
    }
  });
}

/** The route's last handler (after authRequired and the rate limiter). */
function lastHandler(router, routePath, method = 'get') {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function run(handler, req) {
  return new Promise(resolve => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
      redirect(location) {
        resolve({ status: 302, location });
      }
    };
    Promise.resolve(handler(req, res)).catch(error => resolve({ error }));
  });
}

const DERIVED_BASE = 'https://ihub.example/ihub/api/integrations/jira/callback';

describe('resolveJiraRedirectUri', () => {
  const cfgEmpty = { redirectUri: '' };

  it('uses the configured value before anything in the request', () => {
    const req = fakeRequest({ headers: { host: 'other.example' } });
    assert.equal(resolveJiraRedirectUri(req, { redirectUri: CONFIGURED }), CONFIGURED);
    assert.equal(resolveJiraRedirectUri(null, { redirectUri: CONFIGURED }), CONFIGURED);
  });

  it('derives scheme and host from the forwarded headers without a base path', () => {
    const req = fakeRequest({
      headers: {
        host: 'internal:3000',
        'X-Forwarded-Proto': 'https, http',
        'X-Forwarded-Host': 'ihub.example, internal:3000'
      }
    });
    assert.equal(
      resolveJiraRedirectUri(req, cfgEmpty),
      `https://ihub.example${JIRA_CALLBACK_PATH}`
    );
  });

  it('includes the base path of the request context', () => {
    const req = fakeRequest({
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'ihub.example' }
    });
    runWithContext({ basePathPrefix: '/ihub' }, () => {
      assert.equal(resolveJiraRedirectUri(req, cfgEmpty), DERIVED_BASE);
    });
  });

  it("falls back to the request's own protocol and Host header", () => {
    const req = fakeRequest({ headers: { host: 'localhost:3000' }, protocol: 'http' });
    assert.equal(
      resolveJiraRedirectUri(req, cfgEmpty),
      `http://localhost:3000${JIRA_CALLBACK_PATH}`
    );
  });

  it('refuses to derive without a request or a host', () => {
    assert.throws(() => resolveJiraRedirectUri(null, cfgEmpty), /no host/);
    assert.throws(() => resolveJiraRedirectUri(fakeRequest(), cfgEmpty), /no host/);
  });
});

describe('Jira OAuth routes', () => {
  const headers = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'ihub.example' };
  const originalExchange = JiraService.exchangeCodeForTokens;
  const originalStore = JiraService.storeUserTokens;

  beforeEach(() => {
    JiraService.exchangeCodeForTokens = originalExchange;
    JiraService.storeUserTokens = originalStore;
  });

  async function startFlow() {
    const authHandler = lastHandler(jiraRouter, '/auth');
    let started;
    await new Promise(resolve =>
      runWithContext({ basePathPrefix: '/ihub' }, async () => {
        started = await run(authHandler, fakeRequest({ headers, user: { id: 'u1' } }));
        resolve();
      })
    );
    assert.equal(started.status, 302, started.error?.message);
    const authorize = new URL(started.location);
    return { authorize, state: authorize.searchParams.get('state') };
  }

  async function completeFlow(state) {
    let exchangeArgs;
    JiraService.exchangeCodeForTokens = async (...args) => {
      exchangeArgs = args;
      return { accessToken: 'a', refreshToken: 'r' };
    };
    JiraService.storeUserTokens = async () => true;
    const callbackHandler = lastHandler(jiraRouter, '/callback');
    let done;
    await new Promise(resolve =>
      runWithContext({ basePathPrefix: '/ihub' }, async () => {
        done = await run(
          callbackHandler,
          fakeRequest({ headers, user: { id: 'u1' }, query: { code: 'c', state } })
        );
        resolve();
      })
    );
    assert.equal(done.location, '/settings/integrations?jira_connected=true');
    return exchangeArgs;
  }

  it('derives the redirect URI for the authorize step and sends the same one on the exchange', async () => {
    installJira({ clientId: 'client-1', clientSecretRef: 'jira-secret', redirectUri: '' });
    assert.equal(getJiraConfig().redirectUri, '');
    const { authorize, state } = await startFlow();
    assert.equal(authorize.origin, 'https://auth.atlassian.com');
    assert.equal(authorize.searchParams.get('redirect_uri'), DERIVED_BASE);
    assert.equal(authorize.searchParams.get('client_id'), 'client-1');

    const exchangeArgs = await completeFlow(state);
    assert.equal(exchangeArgs[0], 'c');
    assert.equal(exchangeArgs[2], DERIVED_BASE);
  });

  it('sends the configured redirect URI on both steps when one is set', async () => {
    installJira({ clientId: 'client-1', clientSecretRef: 'jira-secret', redirectUri: CONFIGURED });
    const { authorize, state } = await startFlow();
    assert.equal(authorize.searchParams.get('redirect_uri'), CONFIGURED);
    const exchangeArgs = await completeFlow(state);
    assert.equal(exchangeArgs[2], CONFIGURED);
  });
});

describe('connector test: redirect URI step', () => {
  it('accepts a configured callback URL', () => {
    const step = redirectUriStep({ redirectUri: CONFIGURED });
    assert.equal(step.status, 'ok');
    assert.equal(step.message, CONFIGURED);
  });

  it('warns about a configured URL that is not the callback', () => {
    const step = redirectUriStep({ redirectUri: 'https://registered.example/oauth' });
    assert.equal(step.status, 'warn');
    assert.match(step.message, /should end in \/api\/integrations\/jira\/callback/);
  });

  it("reports an empty field as derived, with the admin's own request as the example", () => {
    const req = fakeRequest({
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'ihub.example' }
    });
    runWithContext({ basePathPrefix: '/ihub' }, () => {
      const step = redirectUriStep({ redirectUri: '' }, req);
      assert.equal(step.status, 'ok');
      assert.match(step.message, /derived from the request/);
      assert.ok(step.message.includes(DERIVED_BASE), step.message);
    });
  });

  it('reports the derivation rule when no request is at hand', () => {
    const step = redirectUriStep({ redirectUri: '' });
    assert.equal(step.status, 'ok');
    assert.match(step.message, /<scheme>:\/\/<host><base path>\/api\/integrations\/jira\/callback/);
  });
});
