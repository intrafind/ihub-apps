#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import office365Router from '../routes/integrations/office365.js';
import Office365Service from '../services/integrations/Office365Service.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tokenStorageService from '../services/TokenStorageService.js';
import credentialService from '../services/CredentialService.js';
import configCache from '../configCache.js';
import {
  IntegrationConnectionService,
  setIntegrationConnectionServiceForTests
} from '../services/integrations/auth/IntegrationConnectionService.js';
import {
  OAuthFlowStore,
  OAUTH_FLOWS_NAMESPACE
} from '../services/integrations/auth/oauthFlowStore.js';
import { fakeTokenEndpoint } from './helpers/integrationConnect.js';
import { IntegrationAuthRequiredError } from '../services/integrations/auth/integrationAuthRequired.js';
import { scratchDocuments } from './helpers/testStorage.js';

const scratch = await scratchDocuments();

// In-memory key material; tokens land in a temp directory.
tokenStorageService.encryptionKey = 'c'.repeat(64);
tokenStorageService.jwtSecret = 'office365-callback-routes-secret';
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'office365-callback-'));
tokenStorageService.storageBasePath = tmpDir;

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
// like a callback landing on a different cluster worker than the connect
// request (`POST /api/integrations/:id/connect`) did.
function handlerFor(path) {
  const route = office365Router.stack.find(layer => layer.route?.path === path).route;
  return route.stack[route.stack.length - 1].handle;
}
const callbackHandler = handlerFor('/:providerId/callback');

// A handler answers errors by throwing a ServiceError (the error middleware would turn that into
// the response); this reports the status and body that response would carry.
async function answerOf(handler, req, res) {
  try {
    await handler(req, res);
    return null;
  } catch (error) {
    return { status: error.status, body: { code: error.code, details: error.details } };
  }
}

// The `office365` installation, its secret and a local token endpoint.
const installed = values => ({
  data: {
    installed: [
      {
        id: 'office365',
        definition: 'com.intrafind/office365',
        enabled: true,
        values: { tenantId: 'tenant-1', clientId: 'c', clientSecretRef: 's', ...values },
        auth: { mode: 'oauth-user' }
      }
    ]
  }
});
configCache.getIntegrations = () => installed({});
credentialService.resolveSecret = () => 'client-secret';
const tokenEndpoint = fakeTokenEndpoint([{}]);
const originalStrategy = Office365Service.oauthStrategy;
Office365Service.oauthStrategy = function oauthStrategyForTest(providerId) {
  const strategy = originalStrategy.call(this, providerId);
  return {
    ...strategy,
    async resolve(ctx) {
      return { ...(await strategy.resolve(ctx)), fetchFn: tokenEndpoint };
    }
  };
};

// Two "workers" that share nothing but the flow store (in production: the
// storage provider's `integration-oauth-flows` namespace).
const sharedFlows = new OAuthFlowStore({ documents: scratch.documents });
const workerA = new IntegrationConnectionService({
  documents: scratch.documents,
  flowStore: sharedFlows
});
const workerB = new IntegrationConnectionService({
  documents: scratch.documents,
  flowStore: sharedFlows
});

const member = id => ({ id, groups: ['users'], permissions: { integrations: ['*'] } });

/** The sign-in as the one connect route starts it, on worker A. */
async function startSignIn(userId = 'u1') {
  setIntegrationConnectionServiceForTests(workerA);
  const { authorizationUrl: url } = await workerA.beginConnect({
    installationId: 'office365',
    user: member(userId),
    returnUrl: '/apps/chat',
    req: {
      headers: { host: 'ihub.example' },
      hostname: 'ihub.example',
      get: () => 'ihub.example',
      protocol: 'https'
    }
  });
  return { url, state: url.searchParams.get('state') };
}

async function callbackRedirect(query, { userId = 'u1', providerId = 'office365' } = {}) {
  setIntegrationConnectionServiceForTests(workerB);
  let location;
  await callbackHandler(
    {
      query,
      params: { providerId },
      user: userId ? member(userId) : undefined,
      headers: { host: 'ihub.example' },
      hostname: 'ihub.example',
      get: () => 'ihub.example',
      protocol: 'https'
    },
    { redirect: (statusOrUrl, url) => (location = url ?? statusOrUrl), setHeader: () => {} }
  );
  return location;
}

const started = await startSignIn();
check(
  'the authorize request goes to the tenant with PKCE and the minimal scopes',
  started.url.pathname === '/tenant-1/oauth2/v2.0/authorize' &&
    started.url.searchParams.get('code_challenge_method') === 'S256' &&
    started.url.searchParams.get('response_mode') === 'query'
);
check('state is an opaque handle, not a ticket', !started.state.includes('.'));

const ok = await callbackRedirect({ code: 'c', state: started.state });
check(
  'callback on another worker succeeds (state and verifier live in the shared flow store)',
  ok === '/apps/chat?integration_connected=office365'
);
check(
  'the token exchange carries the verifier of the original sign-in',
  Boolean(tokenEndpoint.calls[0]?.params.get('code_verifier'))
);
check(
  'tokens are stored for the user who started the flow',
  (await workerB.getUserTokens({ installationId: 'office365', userId: 'u1' })).accessToken ===
    'access-1'
);

const declined = await callbackRedirect({
  error: 'access_denied',
  state: (await startSignIn()).state
});
check(
  'declined consent returns to the original page with access_denied',
  declined === '/apps/chat?integration_error=access_denied&integration=office365'
);

const otherUser = await callbackRedirect(
  { code: 'c', state: (await startSignIn()).state },
  { userId: 'u2' }
);
check(
  'state from another user is refused',
  otherUser === '/settings/integrations?integration_error=user_mismatch&integration=office365'
);

const noUser = await callbackRedirect(
  { code: 'c', state: (await startSignIn()).state },
  { userId: null }
);
check(
  'callback without a signed-in user is refused',
  noUser === '/settings/integrations?integration_error=user_mismatch&integration=office365'
);

const otherProvider = await callbackRedirect(
  { code: 'c', state: (await startSignIn()).state },
  { providerId: 'other' }
);
check(
  'state for another provider is refused',
  otherProvider === '/apps/chat?integration_error=invalid_state&integration=office365'
);

const expiring = await startSignIn();
for (const doc of (await scratch.documents.list(OAUTH_FLOWS_NAMESPACE, { includeData: true }))
  .items) {
  await scratch.documents.put(
    OAUTH_FLOWS_NAMESPACE,
    doc.key,
    { ...doc.data, exp: Date.now() - 1000 },
    { ownerId: 'system' }
  );
}
const expired = await callbackRedirect({ code: 'c', state: expiring.state });
check(
  'expired state reports state_expired',
  expired === '/apps/chat?integration_error=state_expired&integration=office365'
);

const badSecret = fakeTokenEndpoint([{ status: 401, body: { error: 'invalid_client' } }]);
Office365Service.oauthStrategy = function oauthStrategyForTest(providerId) {
  const strategy = originalStrategy.call(this, providerId);
  return {
    ...strategy,
    async resolve(ctx) {
      return { ...(await strategy.resolve(ctx)), fetchFn: badSecret };
    }
  };
};
const rejected = await callbackRedirect({ code: 'c', state: (await startSignIn()).state });
check(
  'expired client secret surfaces invalid_client',
  rejected === '/apps/chat?integration_error=invalid_client&integration=office365'
);
Office365Service.oauthStrategy = originalStrategy;
rmSync(tmpDir, { recursive: true, force: true });

// Graph drive IDs contain `!` (e.g. `b!…` for OneDrive/SharePoint/Teams) and
// must reach the service instead of being rejected with 400.
const itemsHandler = handlerFor('/items');
let listedDrive;
Office365Service.listItems = async (userId, driveId) => {
  listedDrive = driveId;
  return [];
};
async function itemsStatus(driveId) {
  let status = 200;
  const res = {
    setHeader() {},
    status: code => ((status = code), res),
    json: () => res
  };
  const thrown = await answerOf(
    itemsHandler,
    { query: { driveId, providerId: 'office365' }, user: { id: 'u1' } },
    res
  );
  return thrown ? thrown.status : status;
}
const businessDriveId = 'b!Xk3pQ-7zLmN0aBcD_eF9gH1iJ2kL3mN4oP5qR6sT7uV8wX9yZ0';
check('drive ID with ! is accepted', (await itemsStatus(businessDriveId)) === 200);
check('drive ID with ! reaches the service', listedDrive === businessDriveId);
check('drive ID with a slash is still rejected', (await itemsStatus('b!abc/../me')) === 400);

// A user without a usable connection gets the one "connect first" answer (409,
// not 401: the iHub session is fine), which the file browser turns into the
// Connect card.
Office365Service.listItems = async () => {
  throw new IntegrationAuthRequiredError({
    integration: 'office365',
    reason: 'expired',
    message: 'Office 365 authentication expired. Please reconnect your account.'
  });
};
{
  let status = 200;
  let body = null;
  const res = {
    setHeader() {},
    status: code => ((status = code), res),
    json: payload => ((body = payload), res)
  };
  const thrown = await answerOf(
    itemsHandler,
    { query: { providerId: 'office365' }, user: { id: 'u1' } },
    res
  );
  if (thrown) ({ status, body } = thrown);
  check(
    'a missing connection answers 409 INTEGRATION_AUTH_REQUIRED with reason and connect route',
    status === 409 &&
      body?.code === 'INTEGRATION_AUTH_REQUIRED' &&
      body.details?.integration === 'office365' &&
      body.details.reason === 'expired' &&
      body.details.connectUrl === '/api/integrations/office365/connect'
  );
}

// Only the sources the admin enabled are offered (the provider is the
// `office365` installation; its source switches are install values).
configCache.getIntegrations = () => ({
  data: {
    installed: [
      {
        id: 'office365',
        definition: 'com.intrafind/office365',
        enabled: true,
        values: {
          tenantId: 't',
          clientId: 'c',
          clientSecretRef: 's',
          sourceFollowedSites: false,
          sourceTeams: false
        },
        auth: { mode: 'oauth-user' }
      }
    ]
  }
});
async function callJson(handler, req) {
  const out = { status: 200 };
  const res = {
    setHeader() {},
    status: code => ((out.status = code), res),
    json: body => ((out.body = body), res)
  };
  const thrown = await answerOf(
    handler,
    { user: { id: 'u1' }, query: { providerId: 'office365' }, ...req },
    res
  );
  if (thrown) Object.assign(out, thrown);
  return out;
}
const sourcesRes = await callJson(handlerFor('/sources'), {});
check(
  'only enabled sources are listed',
  JSON.stringify(sourcesRes.body.sources.map(source => source.id)) === '["personal"]'
);
const teamsRes = await callJson(handlerFor('/drives/:source'), { params: { source: 'teams' } });
check('drives of a disabled source are refused', teamsRes.status === 403);

// OneDrive lists only the default drive, not hidden system libraries.
const requested = [];
Office365Service.makeApiRequest = async endpoint => {
  requested.push(endpoint);
  return { id: 'b!default', name: 'OneDrive', driveType: 'business' };
};
const personalRes = await callJson(handlerFor('/drives/:source'), {
  params: { source: 'personal' }
});
check(
  'OneDrive returns only the default drive',
  personalRes.body.drives.length === 1 &&
    personalRes.body.drives[0].id === 'b!default' &&
    requested.join() === '/me/drive'
);

if (failures > 0) {
  console.error(`\n❌ ${failures} Office 365 callback route check(s) failed`);
  process.exit(1);
}

console.log('\n🎉 All Office 365 callback route checks passed');
