// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The token endpoint issues a client-credentials (machine) token only to a
 * client registered for that grant.
 *
 * A machine token is granted exactly the client's lists and is bound to no
 * user. A confidential client registered for the authorization-code flow only
 * must therefore not be able to mint one with its secret, whatever its lists
 * hold. The refusal uses the OAuth error format (`error`, `error_description`).
 *
 * The client manager and the token route are the real ones; the clients file
 * is a temporary file.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-oauth-grant-check-'));
const clientsFile = path.join(tmpDir, 'oauth-clients.json');

const platform = {
  oauth: { enabled: { authz: true, clients: true }, clientsFile },
  // HS256 with a test secret, so a granted request yields a signed token.
  jwt: { algorithm: 'HS256' },
  auth: { jwtSecret: 'test-secret-for-client-credentials-grant-check' },
  rateLimit: { oauthTokenApi: { limit: 10000 } }
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => platform,
    get: () => null,
    setCacheEntry: () => {}
  }
}));

const { default: registerOAuthRoutes } = await import('../routes/oauth.js');
const { createOAuthClient, updateOAuthClients } = await import('../utils/oauthClientManager.js');

const app = express();
app.use(express.json());
registerOAuthRoutes(app);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Creates a confidential client with these grant types and returns its credentials. */
async function clientWith(grantTypes) {
  const created = await createOAuthClient(
    { name: `Client ${grantTypes.join('+')}`, grantTypes, allowedApps: ['*'] },
    clientsFile,
    'test'
  );
  return { clientId: created.clientId, clientSecret: created.clientSecret };
}

function requestMachineToken({ clientId, clientSecret }) {
  return request(app).post('/api/oauth/token').send({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });
}

describe('POST /api/oauth/token grant_type=client_credentials', () => {
  it('refuses a confidential authorization-code-only client with unauthorized_client', async () => {
    const creds = await clientWith(['authorization_code', 'refresh_token']);

    const res = await requestMachineToken(creds);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(typeof res.body.error_description).toBe('string');
    expect(res.body.access_token).toBeUndefined();
  });

  it('does not refuse a client registered for client_credentials', async () => {
    const creds = await clientWith(['client_credentials']);

    const res = await requestMachineToken(creds);

    expect(res.status).toBe(200);
    expect(typeof res.body.access_token).toBe('string');
  });

  it('treats a stored client without grantTypes as a client-credentials client', async () => {
    const creds = await clientWith(['client_credentials']);
    await updateOAuthClients(clientsFile, clientsConfig => {
      delete clientsConfig.clients[creds.clientId].grantTypes;
    });

    const res = await requestMachineToken(creds);

    expect(res.status).toBe(200);
    expect(typeof res.body.access_token).toBe('string');
  });
});
