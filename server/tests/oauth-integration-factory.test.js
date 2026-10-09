#!/usr/bin/env node

// The shared OAuth route factory (routes/integrations/oauthIntegrationFactory.js),
// exercised through the four real provider routers. Handlers are driven directly
// with stubbed services; nothing touches the network or the disk.

import office365Router from '../routes/integrations/office365.js';
import googledriveRouter from '../routes/integrations/googledrive.js';
import nextcloudRouter from '../routes/integrations/nextcloud.js';
import jiraRouter from '../routes/integrations/jira.js';
import Office365Service from '../services/integrations/Office365Service.js';
import GoogleDriveService from '../services/integrations/GoogleDriveService.js';
import NextcloudService from '../services/integrations/NextcloudService.js';
import JiraService from '../services/integrations/JiraService.js';
import { issueIntegrationOAuthState } from '../utils/integrationOAuthState.js';
import tokenStorageService from '../services/TokenStorageService.js';
import { createUnavailableError } from '../services/integrations/oauthRefreshError.js';

// In-memory key material; nothing touches disk.
tokenStorageService.encryptionKey = 'd'.repeat(64);
tokenStorageService.jwtSecret = 'oauth-integration-factory-secret';

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
    router: office365Router,
    service: Office365Service,
    multi: true,
    pkce: true,
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
    router: googledriveRouter,
    service: GoogleDriveService,
    multi: true,
    pkce: true,
    callbackPath: '/:providerId/callback',
    userInfo: { displayName: 'Ada', mail: 'ada@example.com', picture: 'p.png', secret: 'x' },
    expectedUserInfo: { displayName: 'Ada', mail: 'ada@example.com', picture: 'p.png' }
  },
  {
    key: 'nextcloud',
    router: nextcloudRouter,
    service: NextcloudService,
    multi: true,
    pkce: false,
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
    router: jiraRouter,
    service: JiraService,
    multi: false,
    pkce: true,
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
    redirect: url => (out.location = url),
    status: code => ((out.status = code), res),
    json: body => ((out.body = body), res)
  };
  await handler({ query: {}, params: {}, body: {}, ...req }, res);
  return out;
}

for (const p of providers) {
  console.log(`\n🧪 ${p.key}`);
  const { router, service, key } = p;
  const providerId = p.multi ? 'prov-1' : undefined;

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
  let authArgs;
  const stubAuthUrl = (...args) => {
    authArgs = args;
    return 'https://idp.example/authorize';
  };
  if (key === 'jira') service.generateAuthUrl = (state, verifier) => stubAuthUrl(state, verifier);
  else if (key === 'nextcloud') service.generateAuthUrl = (id, state) => stubAuthUrl(id, state);
  else service.generateAuthUrl = (id, state, verifier) => stubAuthUrl(id, state, verifier);

  const authHandler = lastHandler(router, '/auth');
  const anon = await run(authHandler, { query: { providerId }, user: { id: 'anonymous' } });
  check('/auth refuses the anonymous principal', anon.status === 401 && !anon.location);

  if (p.multi) {
    const noProvider = await run(authHandler, { user: { id: 'u1' } });
    check('/auth without providerId is a 400', noProvider.status === 400);
  }

  const started = await run(authHandler, {
    query: { providerId, returnUrl: '/apps/chat' },
    user: { id: 'u1' },
    headers: { host: 'ihub.example' },
    get: () => 'ihub.example',
    protocol: 'https'
  });
  check(
    '/auth redirects to the identity provider',
    started.location === 'https://idp.example/authorize'
  );
  const state = key === 'jira' ? authArgs[0] : authArgs[1];
  const verifier = key === 'jira' ? authArgs[1] : authArgs[2];
  check('state is a signed ticket', typeof state === 'string' && state.includes('.'));
  check(
    p.pkce ? 'a PKCE verifier is generated' : 'no PKCE verifier is generated',
    p.pkce ? typeof verifier === 'string' && verifier.length > 20 : verifier === undefined
  );

  // ---- callback
  let exchanged;
  service.exchangeCodeForTokens = async (...args) => {
    exchanged = args;
    return { accessToken: 'a', refreshToken: 'r' };
  };
  let storedFor;
  service.storeUserTokens = async userId => {
    storedFor = userId;
  };

  const callbackHandler = lastHandler(router, p.callbackPath);
  const callback = query =>
    run(callbackHandler, { query, params: { providerId }, user: { id: 'u1' } });

  const ok = await callback({ code: 'c', state });
  check(
    'callback succeeds and returns to the original page',
    ok.location === `/apps/chat?${key}_connected=true`
  );
  check('tokens are stored for the user who started the flow', storedFor === 'u1');
  const expectedExchange =
    key === 'jira'
      ? ['c', verifier]
      : key === 'nextcloud'
        ? [providerId, 'c']
        : [providerId, 'c', verifier];
  check(
    'code exchange gets the provider-specific arguments',
    JSON.stringify(exchanged.slice(0, expectedExchange.length)) === JSON.stringify(expectedExchange)
  );

  // The signed return URL is the only redirect target the callback uses, so /auth must never
  // sign one that a browser reads as another site (`\` counts as `/`, tabs are dropped).
  for (const evil of [
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    'https://evil.example/x'
  ]) {
    await run(authHandler, { query: { providerId, returnUrl: evil }, user: { id: 'u1' } });
    const evilState = key === 'jira' ? authArgs[0] : authArgs[1];
    const evilCallback = await callback({ code: 'c', state: evilState });
    check(
      `return URL ${JSON.stringify(evil)} falls back to the default page`,
      evilCallback.location === `/settings/integrations?${key}_connected=true`
    );
  }

  const declined = await callback({ error: 'access_denied', state });
  check(
    'declined consent reports access_denied',
    declined.location === `/apps/chat?${key}_error=access_denied`
  );
  const failedIdp = await callback({ error: 'server_error <script>', state });
  check(
    'raw IdP error text never reaches the redirect',
    failedIdp.location === `/apps/chat?${key}_error=oauth_failed`
  );

  const missing = await callback({ state });
  check(
    'missing code reports missing_code',
    missing.location === `/apps/chat?${key}_error=missing_code`
  );

  const garbage = await callback({ code: 'c', state: 'not-a-ticket' });
  check(
    'unsigned state lands on the default page with invalid_state',
    garbage.location === `/settings/integrations?${key}_error=invalid_state`
  );

  const otherService = issueIntegrationOAuthState({
    service: key === 'jira' ? 'office365' : 'jira',
    providerId: providerId ?? '',
    userId: 'u1',
    returnUrl: '/apps/chat'
  });
  const crossService = await callback({ code: 'c', state: otherService });
  check(
    'state minted for another integration is refused',
    crossService.location === `/apps/chat?${key}_error=invalid_state`
  );

  const otherUser = await run(callbackHandler, {
    query: { code: 'c', state },
    params: { providerId },
    user: { id: 'u2' }
  });
  check(
    'state from another user is refused',
    otherUser.location === `/apps/chat?${key}_error=invalid_state`
  );

  if (p.multi) {
    const otherProvider = await run(callbackHandler, {
      query: { code: 'c', state },
      params: { providerId: 'other' },
      user: { id: 'u1' }
    });
    check(
      'state for another provider is refused',
      otherProvider.location === `/apps/chat?${key}_error=invalid_state`
    );
  }

  service.exchangeCodeForTokens = async () => {
    throw new Error('upstream said <script>alert(1)</script>');
  };
  const failed = await callback({ code: 'c', state });
  check(
    'a failed token exchange reports a stable callback_failed code',
    failed.location === `/apps/chat?${key}_error=callback_failed`
  );

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

  service.isUserAuthenticated = async () => {
    throw createUnavailableError('Provider');
  };
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
  service.deleteUserTokens = async (userId, id) => {
    deletedArgs = [userId, id];
    return true;
  };
  const disconnect = req => run(disconnectHandler, { user: { id: 'u1' }, ...req });

  const anonDisconnect = await disconnect({ user: { id: 'anonymous' } });
  check('/disconnect refuses the anonymous principal', anonDisconnect.status === 401);

  const fromBody = await disconnect({ body: { providerId: 'from-body' } });
  check('/disconnect succeeds', fromBody.body?.success === true);
  check(
    p.multi ? 'providerId is read from the JSON body' : 'single-provider ignores any providerId',
    p.multi ? deletedArgs[1] === 'from-body' : deletedArgs[1] === undefined
  );
  if (p.multi) {
    await disconnect({ query: { providerId: 'from-query' }, body: { providerId: 'from-body' } });
    check('providerId in the query wins over the body', deletedArgs[1] === 'from-query');
  }

  service.deleteUserTokens = async () => false;
  const nothing = await disconnect();
  check('/disconnect reports when there was nothing to remove', nothing.body?.success === false);
}

if (failures > 0) {
  console.error(`\n❌ ${failures} OAuth integration factory check(s) failed`);
  process.exit(1);
}

console.log('\n🎉 All OAuth integration factory checks passed');
