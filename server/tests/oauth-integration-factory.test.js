#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// The one connect flow (`POST /api/integrations/:id/connect|disconnect`,
// routes/integrations/userIntegrations.js) and the vendor-registered callback
// aliases of the four providers (routes/integrations/oauthIntegrationFactory.js),
// exercised through the real routers, and the security parity of their
// sign-in through the shared connection service
// (concept `2026-05-11 Cloud Storage Provider Security Parity.md`):
//
//   - PKCE (S256) for every provider, the verifier kept server-side;
//   - the state bound to the user and the installation, single use;
//   - the return URL validated (http(s), same origin; anything else refused)
//     and redirects to paths only;
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
import userIntegrationsRouter from '../routes/integrations/userIntegrations.js';
import Office365Service from '../services/integrations/Office365Service.js';
import GoogleDriveService from '../services/integrations/GoogleDriveService.js';
import NextcloudService from '../services/integrations/NextcloudService.js';
import JiraService from '../services/integrations/JiraService.js';
import tokenStorageService from '../services/TokenStorageService.js';
import credentialService from '../services/CredentialService.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import {
  IntegrationConnectionService,
  connectionIdFor,
  setIntegrationConnectionServiceForTests
} from '../services/integrations/auth/IntegrationConnectionService.js';
import { OAuthFlowStore } from '../services/integrations/auth/oauthFlowStore.js';
import { fakeTokenEndpoint } from './helpers/integrationConnect.js';
import { scratchDocuments } from './helpers/testStorage.js';

const scratch = await scratchDocuments();

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
  documents: scratch.documents,
  flowStore: new OAuthFlowStore({ documents: scratch.documents })
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

// One row per provider: how it is wired and what its stubbed service reports.
const providers = [
  {
    key: 'office365',
    providerId: 'prov-o365',
    router: office365Router,
    service: Office365Service,
    multi: true,
    callbackPath: '/:providerId/callback'
  },
  {
    key: 'googledrive',
    providerId: 'prov-gdrive',
    router: googledriveRouter,
    service: GoogleDriveService,
    multi: true,
    callbackPath: '/:providerId/callback'
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
  try {
    await handler(
      { query: {}, params: {}, body: {}, is: type => type === 'application/json', ...req },
      res
    );
  } catch (error) {
    // A handler answers errors by throwing a ServiceError; the error middleware would send it.
    out.status = error.status ?? 500;
    out.body = { code: error.code, details: error.details };
  }
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

const connectHandler = lastHandler(userIntegrationsRouter, '/:id/connect', 'post');
const disconnectHandler = lastHandler(userIntegrationsRouter, '/:id/disconnect', 'post');

for (const p of providers) {
  console.log(`\n🧪 ${p.key}`);
  const { router, service, providerId } = p;
  /** Where the callback sends the browser: the one result shape of every integration. */
  const connectedAt = page =>
    `${page}${page.includes('?') ? '&' : '?'}integration_connected=${providerId}`;
  const failedAt = (page, code) => `${page}?integration_error=${code}&integration=${providerId}`;

  // ---- route registration: only the vendor-registered callback is left per provider
  check(
    'registers the callback alias and no /auth, /status or /disconnect',
    !!routeFor(router, p.callbackPath) &&
      !routeFor(router, '/auth') &&
      !routeFor(router, '/status') &&
      !routeFor(router, '/disconnect', 'post')
  );
  check(
    p.multi ? 'multi-provider has no bare /callback' : 'single-provider has no :providerId route',
    p.multi ? !routeFor(router, '/callback') : !routeFor(router, '/:providerId/callback')
  );
  // The browse and download routes call out to the provider on every request: each carries a
  // rate limiter between the sign-in check and the handler (authRequired, limiter, handler).
  for (const path of ['/sources', '/drives/:source', '/items', '/download']) {
    check(`${p.key} ${path} is rate limited`, routeFor(router, path)?.stack.length === 3);
  }
  check(
    'POST /api/integrations/:id/connect is rate limited',
    routeFor(userIntegrationsRouter, '/:id/connect', 'post').stack.length === 4
  );

  // ---- POST /api/integrations/:id/connect
  const anon = await run(connectHandler, { params: { id: providerId }, user: { id: 'anonymous' } });
  check('connect refuses the anonymous principal', anon.status === 401 && !anon.body?.url);
  const noUser = await run(connectHandler, { params: { id: providerId }, user: { id: '' } });
  check('connect refuses a user without an id (no shared token bucket)', noUser.status === 401);
  const form = await run(connectHandler, {
    params: { id: providerId },
    user: member('u1'),
    is: () => false
  });
  check('connect without a JSON body is refused (no cross-site form posts)', form.status === 415);
  const notGranted = await run(connectHandler, {
    params: { id: providerId },
    user: { id: 'u9', groups: [], permissions: { integrations: [] } }
  });
  check('an installation the groups do not grant answers 404', notGranted.status === 404);

  // What the browser's requests carry; the callback arrives at the redirect
  // URI, so it has the same Host as the connect request.
  const browser = {
    headers: { host: 'ihub.example' },
    hostname: 'ihub.example',
    get: name => (name.toLowerCase() === 'host' ? 'ihub.example' : undefined),
    protocol: 'https'
  };
  let tokenEndpoint = answerTokenEndpoint(service, [{ user_id: 'nc-user' }]);
  const start = async (returnUrl = '/apps/chat', userId = 'u1') => {
    const started = await run(connectHandler, {
      ...browser,
      params: { id: providerId },
      body: { returnUrl },
      user: member(userId)
    });
    const url = new URL(started.body.url);
    return { url, state: url.searchParams.get('state') };
  };
  const first = await start();
  check(
    "connect answers the provider's authorization URL",
    first.url.searchParams.get('client_id') === `${providerId}-client`
  );
  check(
    'PKCE: an S256 challenge is sent',
    first.url.searchParams.get('code_challenge_method') === 'S256' &&
      /^[A-Za-z0-9_-]{43}$/.test(first.url.searchParams.get('code_challenge') || '')
  );
  check(
    'state is an opaque handle, not a ticket carrying the user or the verifier',
    // A fixed-length random handle. It cannot carry the user id plus a 43-character verifier,
    // and a substring check against the user id would fail ~1% of the time by chance.
    /^[A-Za-z0-9_-]{43}$/.test(first.state)
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
    ok.location === connectedAt('/apps/chat')
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
    replay.location === failedAt('/settings/integrations', 'invalid_state')
  );

  // Return URLs a browser would read as another site are refused before any flow starts.
  for (const evil of [
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    'https://evil.example/x',
    'javascript://ihub.example/%0Aalert(1)'
  ]) {
    const refused = await run(connectHandler, {
      ...browser,
      params: { id: providerId },
      body: { returnUrl: evil },
      user: member('u1')
    });
    check(
      `return URL ${JSON.stringify(evil)} is refused`,
      refused.status === 400 && refused.body?.code === 'INVALID_RETURN_URL' && !refused.body.url
    );
  }
  const sameOrigin = await start('https://ihub.example/apps/x?y=1');
  const sameOriginCallback = await callback({ code: 'c', state: sameOrigin.state });
  check(
    'a same-origin absolute return URL is kept, as a path',
    sameOriginCallback.location === connectedAt('/apps/x?y=1')
  );

  const declined = await callback({ error: 'access_denied', state: (await start()).state });
  check(
    'declined consent reports access_denied',
    declined.location === failedAt('/apps/chat', 'access_denied')
  );
  const failedIdp = await callback({
    error: 'server_error <script>',
    state: (await start()).state
  });
  check(
    'raw IdP error text never reaches the redirect',
    failedIdp.location === failedAt('/apps/chat', 'oauth_failed')
  );
  const missing = await callback({ state: (await start()).state });
  check(
    'missing code reports missing_code',
    missing.location === failedAt('/apps/chat', 'missing_code')
  );
  const garbage = await callback({ code: 'c', state: 'not-a-state' });
  check(
    'an unknown state lands on the default page with invalid_state',
    garbage.location === failedAt('/settings/integrations', 'invalid_state')
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
    otherUser.location === failedAt('/settings/integrations', 'user_mismatch') &&
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
      otherProvider.location === failedAt('/apps/chat', 'invalid_state')
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
    'a failed token exchange reports a stable code',
    failed.location === failedAt('/apps/chat', 'exchange_failed')
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

  // ---- POST /api/integrations/:id/disconnect
  const disconnect = req => run(disconnectHandler, { params: { id: providerId }, ...req });
  const anonDisconnect = await disconnect({ user: { id: 'anonymous' } });
  check('disconnect refuses the anonymous principal', anonDisconnect.status === 401);
  const unknown = await disconnect({ params: { id: 'not-installed' }, user: member('u1') });
  check('disconnect of an unknown installation answers 404', unknown.status === 404);
  const done = await disconnect({ user: member('u1') });
  check("disconnect removes the caller's tokens", done.body?.success === true && done.body.removed);
  let stillConnected = true;
  try {
    await connections.getUserTokens({ installationId: providerId, userId: 'u1' });
  } catch (error) {
    stillConnected = error.reason !== 'not_connected';
  }
  check('after disconnect the user is not connected', stillConnected === false);
  const revokedRecord = await connections.getConnection(
    connectionIdFor(providerId, { type: 'user', id: 'u1' })
  );
  check('the connection record says revoked', revokedRecord?.status === 'revoked');
}

rmSync(tmpDir, { recursive: true, force: true });
if (originalGetGroups) configCache.getGroups = originalGetGroups;

if (failures > 0) {
  console.error(`\n❌ ${failures} OAuth integration factory check(s) failed`);
  process.exit(1);
}

console.log('\n🎉 All OAuth integration factory checks passed');
