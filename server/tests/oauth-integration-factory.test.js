#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// The shared OAuth route factory (routes/integrations/oauthIntegrationFactory.js),
// exercised through the four real provider routers, and the security parity of
// their sign-in through the shared connection service
// (concept `2026-05-11 Cloud Storage Provider Security Parity.md`):
//
//   - PKCE (S256) for every provider, the verifier kept server-side;
//   - the state bound to the user and the installation, single use;
//   - the return URL validated (http(s), same origin) and redirects to paths only;
//   - stable error codes, never upstream text;
//   - tokens stored for the user who started the flow only;
//   - no token, code or verifier in the logs.
//
// The sign-in runs the real connection service and OAuth client; only each
// provider's token endpoint is answered locally. Nothing touches the network.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import office365Router from '../routes/integrations/office365.js';
import googledriveRouter from '../routes/integrations/googledrive.js';
import nextcloudRouter from '../routes/integrations/nextcloud.js';
import jiraRouter from '../routes/integrations/jira.js';
import Office365Service from '../services/integrations/Office365Service.js';
import GoogleDriveService from '../services/integrations/GoogleDriveService.js';
import NextcloudService from '../services/integrations/NextcloudService.js';
import JiraService from '../services/integrations/JiraService.js';
import tokenStorageService from '../services/TokenStorageService.js';
import credentialService from '../services/CredentialService.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { createUnavailableError } from '../services/integrations/oauthRefreshError.js';
import {
  IntegrationConnectionService,
  connectionIdFor,
  setIntegrationConnectionServiceForTests
} from '../services/integrations/auth/IntegrationConnectionService.js';
import { OAuthFlowStore } from '../services/integrations/auth/oauthFlowStore.js';
import { fakeTokenEndpoint } from './helpers/integrationConnect.js';

// In-memory key material; tokens land in a temp directory.
tokenStorageService.encryptionKey = 'd'.repeat(64);
tokenStorageService.jwtSecret = 'oauth-integration-factory-secret';
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'oauth-factory-'));
tokenStorageService.storageBasePath = tmpDir;

// One installation per provider; the client secrets resolve to a fixed value.
const installation = (id, definition, values) => ({
  id,
  definition,
  enabled: true,
  values: { clientId: `${id}-client`, clientSecretRef: `${id}-secret`, ...values },
  auth: { mode: 'oauth-user' }
});
const integrations = {
  installed: [
    installation('prov-o365', 'com.intrafind/office365', { tenantId: 'tenant-1' }),
    installation('prov-gdrive', 'com.intrafind/google-drive', {}),
    installation('prov-nc', 'com.intrafind/nextcloud', { serverUrl: 'https://nc.example.com' }),
    installation('jira', 'com.intrafind/jira', {})
  ]
};
configCache.getIntegrations = () => ({ data: integrations });
configCache.get = key => (key === 'config/integrations.json' ? { data: integrations } : undefined);
const originalGetGroups = configCache.getGroups?.bind(configCache);
configCache.getGroups = () => ({
  data: { groups: { users: { id: 'users', permissions: { integrations: ['*'] } } } }
});
credentialService.resolveSecret = ref => `secret-of-${ref}`;
credentialService.tryResolveSecret = ref => `secret-of-${ref}`;

// Everything logged, to prove no token, code or verifier is.
const logged = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  const original = logger[level].bind(logger);
  logger[level] = (...args) => {
    logged.push(JSON.stringify(args));
    return original(...args);
  };
}

const connections = new IntegrationConnectionService({
  documents: null,
  flowStore: new OAuthFlowStore({ documents: null })
});
setIntegrationConnectionServiceForTests(connections);

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`✅ ${label}`);
    return;
  }
  failures += 1;
  console.log(`❌ ${label}`);
}

const expiringInfo = { expiresAt: '2030-01-01T00:00:00.000Z', minutesUntilExpiry: 5 };

// One row per provider: how it is wired and what its stubbed service reports.
const providers = [
  {
    key: 'office365',
    providerId: 'prov-o365',
    router: office365Router,
    service: Office365Service,
    multi: true,
    callbackPath: '/:providerId/callback',
    userInfo: {
      displayName: 'Ada',
      mail: 'ada@example.com',
      userPrincipalName: 'ada@corp',
      jobTitle: 'Eng',
      secret: 'must-not-leak'
    },
    expectedUserInfo: {
      displayName: 'Ada',
      mail: 'ada@example.com',
      userPrincipalName: 'ada@corp',
      jobTitle: 'Eng'
    }
  },
  {
    key: 'googledrive',
    providerId: 'prov-gdrive',
    router: googledriveRouter,
    service: GoogleDriveService,
    multi: true,
    callbackPath: '/:providerId/callback',
    userInfo: { displayName: 'Ada', mail: 'ada@example.com', picture: 'p.png', secret: 'x' },
    expectedUserInfo: { displayName: 'Ada', mail: 'ada@example.com', picture: 'p.png' }
  },
  {
    key: 'nextcloud',
    providerId: 'prov-nc',
    router: nextcloudRouter,
    service: NextcloudService,
    multi: true,
    callbackPath: '/:providerId/callback',
    userInfo: { displayName: 'Ada', email: 'ada@example.com', id: 'ada', serverUrl: 'https://nc' },
    expectedUserInfo: {
      displayName: 'Ada',
      email: 'ada@example.com',
      userPrincipalName: 'ada',
      serverUrl: 'https://nc'
    }
  },
  {
    key: 'jira',
    providerId: 'jira',
    router: jiraRouter,
    service: JiraService,
    multi: false,
    callbackPath: '/callback',
    userInfo: {
      displayName: 'Ada',
      emailAddress: 'ada@example.com',
      accountType: 'atlassian',
      active: true,
      secret: 'x'
    },
    expectedUserInfo: {
      displayName: 'Ada',
      emailAddress: 'ada@example.com',
      accountType: 'atlassian',
      active: true
    }
  }
];

function routeFor(router, path, method = 'get') {
  return router.stack.find(layer => layer.route?.path === path && layer.route.methods[method])
    ?.route;
}

function lastHandler(router, path, method = 'get') {
  const route = routeFor(router, path, method);
  return route.stack[route.stack.length - 1].handle;
}

/** Run a handler against a fake response and report what it did. */
async function run(handler, req) {
  const out = { status: 200 };
  const res = {
    redirect: (statusOrUrl, url) => (out.location = url ?? statusOrUrl),
    setHeader: () => {},
    status: code => ((out.status = code), res),
    json: body => ((out.body = body), res)
  };
  await handler({ query: {}, params: {}, body: {}, ...req }, res);
  return out;
}

/** Answer the provider's token endpoint locally, keeping its real endpoints and client. */
function answerTokenEndpoint(service, answers) {
  const endpoint = fakeTokenEndpoint(answers);
  const original = Object.getPrototypeOf(service).oauthStrategy;
  service.oauthStrategy = function oauthStrategyForTest(...args) {
    const strategy = original.apply(this, args);
    return {
      ...strategy,
      async resolve(ctx) {
        return { ...(await strategy.resolve(ctx)), fetchFn: endpoint };
      }
    };
  };
  return endpoint;
}

/** A signed-in user whose groups grant every integration. */
const member = id => ({ id, groups: ['users'], permissions: { integrations: ['*'] } });

const s256 = verifier => crypto.createHash('sha256').update(verifier).digest('base64url');

for (const p of providers) {
  console.log(`\n🧪 ${p.key}`);
  const { router, service, key } = p;

  // ---- route registration
  check(
    'registers /auth, the callback, /status and /disconnect',
    !!routeFor(router, '/auth') &&
      !!routeFor(router, p.callbackPath) &&
      !!routeFor(router, '/status') &&
      !!routeFor(router, '/disconnect', 'post')
  );
  check(
    p.multi ? 'multi-provider has no bare /callback' : 'single-provider has no :providerId route',
    p.multi ? !routeFor(router, '/callback') : !routeFor(router, '/:providerId/callback')
  );
  // authRequired + rate limiter + handler on /auth for every provider (Jira included).
  check('/auth is rate limited', routeFor(router, '/auth').stack.length === 3);

  // ---- /auth
  const providerId = p.providerId;
  const queryId = p.multi ? providerId : undefined;
  const authHandler = lastHandler(router, '/auth');
  const anon = await run(authHandler, {
    query: { providerId: queryId },
    user: { id: 'anonymous' }
  });
  check('/auth refuses the anonymous principal', anon.status === 401 && !anon.location);
  const noUser = await run(authHandler, { query: { providerId: queryId }, user: { id: '' } });
  check('/auth refuses a user without an id (no shared token bucket)', noUser.status === 401);

  if (p.multi) {
    const noProvider = await run(authHandler, { user: { id: 'u1' } });
    check('/auth without providerId is a 400', noProvider.status === 400);
    const unknown = await run(authHandler, {
      query: { providerId: 'no-such-installation', returnUrl: '/apps/chat' },
      user: member('u1')
    });
    check(
      '/auth that cannot start redirects to the settings page, not to a URL from the request',
      typeof unknown.location === 'string' && unknown.location.startsWith('/settings/integrations?')
    );
  }

  // What the browser's requests carry; the callback arrives at the redirect
  // URI, so it has the same Host as /auth.
  const browser = {
    headers: { host: 'ihub.example' },
    hostname: 'ihub.example',
    get: name => (name.toLowerCase() === 'host' ? 'ihub.example' : undefined),
    protocol: 'https'
  };
  let tokenEndpoint = answerTokenEndpoint(service, [{ user_id: 'nc-user' }]);
  const start = async (returnUrl = '/apps/chat', userId = 'u1') => {
    const started = await run(authHandler, {
      ...browser,
      query: { providerId: queryId, returnUrl },
      user: member(userId)
    });
    const url = new URL(started.location);
    return { url, state: url.searchParams.get('state') };
  };
  const first = await start();
  check(
    "/auth redirects to the provider's authorization endpoint",
    first.url.searchParams.get('client_id') === `${providerId}-client`
  );
  check(
    'PKCE: an S256 challenge is sent',
    first.url.searchParams.get('code_challenge_method') === 'S256' &&
      /^[A-Za-z0-9_-]{43}$/.test(first.url.searchParams.get('code_challenge') || '')
  );
  check(
    'state is an opaque handle, not a ticket carrying the user or the verifier',
    /^[A-Za-z0-9_-]{43}$/.test(first.state) && !first.state.includes('u1')
  );

  // ---- callback (an alias of /api/integrations/oauth/callback)
  const callbackHandler = lastHandler(router, p.callbackPath);
  const callback = (query, { userId = 'u1', pathId = providerId } = {}) =>
    run(callbackHandler, {
      ...browser,
      query,
      params: { providerId: pathId },
      user: member(userId)
    });

  const ok = await callback({ code: 'the-code', state: first.state });
  check(
    'callback succeeds and returns to the original page',
    ok.location === `/apps/chat?${key}_connected=true`
  );
  const exchange = tokenEndpoint.calls[0]?.params;
  check(
    'PKCE: the exchange sends the verifier behind the challenge',
    Boolean(exchange) &&
      s256(exchange.get('code_verifier')) === first.url.searchParams.get('code_challenge')
  );
  check(
    'the exchange sends the redirect URI the authorization request sent',
    exchange?.get('redirect_uri') === first.url.searchParams.get('redirect_uri')
  );
  const stored = await connections.getUserTokens({ installationId: providerId, userId: 'u1' });
  check('tokens are stored for the user who started the flow', stored?.accessToken === 'access-1');
  const record = await connections.getConnection(
    connectionIdFor(providerId, { type: 'user', id: 'u1' })
  );
  check(
    'the connection is indexed as active with a secretRef, never the token',
    record?.status === 'active' &&
      /^tokenstore:/.test(record.secretRef) &&
      !JSON.stringify(record).includes('access-1')
  );
  const replay = await callback({ code: 'the-code', state: first.state });
  check(
    'a replayed state is refused (single use)',
    replay.location === `/settings/integrations?${key}_error=invalid_state`
  );

  // Return URLs a browser would read as another site fall back to the default page.
  for (const evil of [
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    'https://evil.example/x',
    'javascript://ihub.example/%0Aalert(1)'
  ]) {
    const flow = await start(evil);
    const evilCallback = await callback({ code: 'c', state: flow.state });
    check(
      `return URL ${JSON.stringify(evil)} falls back to the default page`,
      evilCallback.location === `/settings/integrations?${key}_connected=true`
    );
  }
  const sameOrigin = await start('https://ihub.example/apps/x?y=1');
  const sameOriginCallback = await callback({ code: 'c', state: sameOrigin.state });
  check(
    'a same-origin absolute return URL is kept, as a path',
    sameOriginCallback.location === `/apps/x?y=1&${key}_connected=true`
  );

  const declined = await callback({ error: 'access_denied', state: (await start()).state });
  check(
    'declined consent reports access_denied',
    declined.location === `/apps/chat?${key}_error=access_denied`
  );
  const failedIdp = await callback({
    error: 'server_error <script>',
    state: (await start()).state
  });
  check(
    'raw IdP error text never reaches the redirect',
    failedIdp.location === `/apps/chat?${key}_error=oauth_failed`
  );
  const missing = await callback({ state: (await start()).state });
  check(
    'missing code reports missing_code',
    missing.location === `/apps/chat?${key}_error=missing_code`
  );
  const garbage = await callback({ code: 'c', state: 'not-a-state' });
  check(
    'an unknown state lands on the default page with invalid_state',
    garbage.location === `/settings/integrations?${key}_error=invalid_state`
  );

  // Per-user isolation: a state started by u1 cannot complete in u2's session.
  const victimFlow = await start();
  const callsBefore = tokenEndpoint.calls.length;
  const otherUser = await callback(
    { code: 'attacker-code', state: victimFlow.state },
    {
      userId: 'u2'
    }
  );
  check(
    'a state from another user is refused, without an exchange',
    otherUser.location === `/settings/integrations?${key}_error=invalid_state` &&
      tokenEndpoint.calls.length === callsBefore
  );
  let u2Connected = true;
  try {
    await connections.getUserTokens({ installationId: providerId, userId: 'u2' });
  } catch (error) {
    u2Connected = error.reason !== 'not_connected';
  }
  check('the other user is not connected by it', u2Connected === false);

  if (p.multi) {
    const otherProvider = await callback(
      { code: 'c', state: (await start()).state },
      { pathId: 'prov-other' }
    );
    check(
      "a state for another installation is refused at this installation's callback",
      otherProvider.location === `/apps/chat?${key}_error=invalid_state`
    );
  }

  answerTokenEndpoint(service, [
    {
      status: 400,
      body: { error: 'invalid_grant', error_description: '<script>alert(1)</script>' }
    }
  ]);
  const failed = await callback({ code: 'c', state: (await start()).state });
  check(
    'a failed token exchange reports a stable callback_failed code',
    failed.location === `/apps/chat?${key}_error=callback_failed`
  );

  check(
    'no token, code or verifier is ever logged',
    !logged.some(
      line =>
        line.includes('access-1') ||
        line.includes('refresh-1') ||
        line.includes('the-code') ||
        line.includes(exchange?.get('code_verifier') || 'no-verifier')
    )
  );
  delete service.oauthStrategy;

  // ---- /status
  const statusHandler = lastHandler(router, '/status');
  const status = req => run(statusHandler, { user: { id: 'u1' }, query: { providerId }, ...req });

  const anonStatus = await status({ user: { id: 'anonymous' } });
  check('/status refuses the anonymous principal', anonStatus.status === 401);

  service.isUserAuthenticated = async () => false;
  const disconnected = await status();
  check(
    '/status reports a disconnected account',
    disconnected.body?.connected === false && /not connected/.test(disconnected.body.message)
  );

  service.isUserAuthenticated = async () => true;
  service.getUserInfo = async () => p.userInfo;
  service.getTokenExpirationInfo = async () => ({
    ...expiringInfo,
    isExpiring: false,
    isExpired: false
  });
  const connected = await status();
  check(
    '/status returns only the whitelisted user fields',
    JSON.stringify(connected.body?.userInfo) === JSON.stringify(p.expectedUserInfo)
  );
  check(
    '/status reports token expiry and a success message',
    connected.body?.tokenInfo?.expiresAt === expiringInfo.expiresAt &&
      /connected successfully/.test(connected.body.message)
  );

  service.getTokenExpirationInfo = async () => ({
    ...expiringInfo,
    isExpiring: true,
    isExpired: false
  });
  const expiring = await status();
  check('/status flags expiring tokens', /expiring soon/.test(expiring.body?.message));

  service.getUserInfo = async () => {
    throw new Error('profile endpoint is down');
  };
  const profileDown = await status();
  if (key === 'nextcloud') {
    check(
      'a failing profile lookup still reports connected (nextcloud)',
      profileDown.status === 200 &&
        profileDown.body?.connected === true &&
        profileDown.body.userInfo === null
    );
  } else {
    check('a failing profile lookup is a 500', profileDown.status === 500);
  }

  service.isUserAuthenticated = async () => {
    throw new Error(`${key} authentication required`);
  };
  const expired = await status();
  check(
    'an "authentication required" failure reports an expired connection',
    expired.body?.connected === false && /authentication expired/.test(expired.body.message)
  );

  service.isUserAuthenticated = () => Promise.reject(createUnavailableError('Provider'));
  const unavailable = await status();
  check(
    'a temporary refresh failure keeps the account connected and does not say to reconnect',
    unavailable.status === 200 &&
      unavailable.body?.connected === true &&
      unavailable.body.temporarilyUnavailable === true &&
      /temporarily unavailable/.test(unavailable.body.message) &&
      !/reconnect|expired/i.test(unavailable.body.message)
  );

  // ---- /disconnect
  const disconnectHandler = lastHandler(router, '/disconnect', 'post');
  let deletedArgs;
  service.deleteUserTokens = async (userId, id, request) => {
    deletedArgs = [userId, id, request];
    return true;
  };
  const disconnect = req => run(disconnectHandler, { user: { id: 'u1' }, ...req });

  const anonDisconnect = await disconnect({ user: { id: 'anonymous' } });
  check('/disconnect refuses the anonymous principal', anonDisconnect.status === 401);

  const fromBody = await disconnect({ body: { providerId: 'from-body' } });
  check('/disconnect succeeds', fromBody.body?.success === true);
  // Jira's service takes (userId, req); the storage services (userId, providerId, req).
  const requestArg = p.multi ? deletedArgs[2] : deletedArgs[1];
  check(
    '/disconnect hands the request on for the audit entry',
    Boolean(requestArg?.user?.id === 'u1')
  );
  check(
    p.multi ? 'providerId is read from the JSON body' : 'single-provider ignores any providerId',
    p.multi ? deletedArgs[1] === 'from-body' : !deletedArgs.includes('from-body')
  );
  if (p.multi) {
    await disconnect({ query: { providerId: 'from-query' }, body: { providerId: 'from-body' } });
    check('providerId in the query wins over the body', deletedArgs[1] === 'from-query');
  }

  service.deleteUserTokens = async () => false;
  const nothing = await disconnect();
  check('/disconnect reports when there was nothing to remove', nothing.body?.success === false);
}

rmSync(tmpDir, { recursive: true, force: true });
if (originalGetGroups) configCache.getGroups = originalGetGroups;

if (failures > 0) {
  console.error(`\n❌ ${failures} OAuth integration factory check(s) failed`);
  process.exit(1);
}

console.log('\n🎉 All OAuth integration factory checks passed');
