#!/usr/bin/env node

import office365Router from '../routes/integrations/office365.js';
import Office365Service from '../services/integrations/Office365Service.js';
import {
  INTEGRATION_OAUTH_STATE_TTL_MS,
  issueIntegrationOAuthState
} from '../utils/integrationOAuthState.js';
import tokenStorageService from '../services/TokenStorageService.js';

// In-memory key material; nothing touches disk.
tokenStorageService.encryptionKey = 'c'.repeat(64);
tokenStorageService.jwtSecret = 'office365-callback-routes-secret';

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`✅ ${label}`);
    return;
  }

  failures += 1;
  console.log(`❌ ${label}`);
}

const getRoutes = office365Router.stack
  .filter(layer => layer.route?.methods?.get)
  .map(layer => layer.route.path);

console.log('🧪 Office 365 callback route registration\n');

check(
  'provider-specific callback route is registered',
  getRoutes.includes('/:providerId/callback')
);
check('legacy callback route is removed', !getRoutes.includes('/callback'));

// Drive the handlers directly. Each call gets a fresh request with no session,
// like a callback landing on a different cluster worker than /auth did.
function handlerFor(path) {
  const route = office365Router.stack.find(layer => layer.route?.path === path).route;
  return route.stack[route.stack.length - 1].handle;
}
const authHandler = handlerFor('/auth');
const callbackHandler = handlerFor('/:providerId/callback');

let lastAuthUrlArgs;
Office365Service.generateAuthUrl = (providerId, state, codeVerifier) => {
  lastAuthUrlArgs = { providerId, state, codeVerifier };
  return 'https://login.example/authorize';
};

async function startSignIn(userId = 'u1') {
  await authHandler(
    {
      query: { providerId: 'office365', returnUrl: '/apps/chat' },
      user: { id: userId },
      headers: { host: 'ihub.example' },
      get: () => 'ihub.example',
      protocol: 'https'
    },
    { redirect: () => {}, status: () => ({ json: () => {} }) }
  );
  return lastAuthUrlArgs;
}

async function callbackRedirect(query, { userId = 'u1', providerId = 'office365' } = {}) {
  let location;
  await callbackHandler(
    { query, params: { providerId }, user: userId ? { id: userId } : undefined },
    { redirect: url => (location = url) }
  );
  return location;
}

let exchanged;
Office365Service.exchangeCodeForTokens = async (providerId, code, codeVerifier) => {
  exchanged = { providerId, code, codeVerifier };
  return { accessToken: 'a', refreshToken: 'r' };
};
let storedFor;
Office365Service.storeUserTokens = async userId => {
  storedFor = userId;
};

const started = await startSignIn();
check('state is a signed ticket, not a bare nonce', started.state.includes('.'));
check(
  'state does not carry the PKCE verifier in clear text',
  !Buffer.from(started.state.split('.')[0], 'base64url').toString().includes(started.codeVerifier)
);

const ok = await callbackRedirect({ code: 'c', state: started.state });
check('callback without a session succeeds', ok === '/apps/chat?office365_connected=true');
check(
  'token exchange gets the original PKCE verifier',
  exchanged?.codeVerifier === started.codeVerifier
);
check('tokens are stored for the user who started the flow', storedFor === 'u1');

const declined = await callbackRedirect({ error: 'access_denied', state: started.state });
check(
  'declined consent returns to the original page with access_denied',
  declined === '/apps/chat?office365_error=access_denied'
);

const [payload, signature] = started.state.split('.');
const tampered = await callbackRedirect({
  code: 'c',
  state: `${payload}.${signature.slice(0, -2)}xx`
});
check(
  'tampered state is refused and lands on the default page',
  tampered === '/settings/integrations?office365_error=invalid_state'
);

const otherUser = await callbackRedirect({ code: 'c', state: started.state }, { userId: 'u2' });
check(
  'state from another user is refused',
  otherUser === '/apps/chat?office365_error=invalid_state'
);

const noUser = await callbackRedirect({ code: 'c', state: started.state }, { userId: null });
check(
  'callback without a signed-in user is refused',
  noUser === '/apps/chat?office365_error=invalid_state'
);

const otherProvider = await callbackRedirect(
  { code: 'c', state: started.state },
  { providerId: 'other' }
);
check(
  'state for another provider is refused',
  otherProvider === '/apps/chat?office365_error=invalid_state'
);

const expiredState = issueIntegrationOAuthState({
  service: 'office365',
  providerId: 'office365',
  userId: 'u1',
  returnUrl: '/apps/chat',
  codeVerifier: 'v',
  now: Date.now() - INTEGRATION_OAUTH_STATE_TTL_MS - 1000
});
const expired = await callbackRedirect({ code: 'c', state: expiredState });
check(
  'expired state reports session_expired',
  expired === '/apps/chat?office365_error=session_expired'
);

const jiraState = issueIntegrationOAuthState({
  service: 'jira',
  userId: 'u1',
  returnUrl: '/apps/chat'
});
const crossService = await callbackRedirect({ code: 'c', state: jiraState });
check(
  'state issued for another integration is refused',
  crossService === '/apps/chat?office365_error=invalid_state'
);

Office365Service.exchangeCodeForTokens = async () => {
  const error = new Error('Failed to exchange authorization code for tokens');
  error.code = 'invalid_client';
  throw error;
};
const badSecret = await callbackRedirect({ code: 'c', state: (await startSignIn()).state });
check(
  'expired client secret surfaces invalid_client',
  badSecret === '/apps/chat?office365_error=invalid_client'
);

if (failures > 0) {
  console.error(`\n❌ ${failures} Office 365 callback route check(s) failed`);
  process.exit(1);
}

console.log('\n🎉 All Office 365 callback route checks passed');
