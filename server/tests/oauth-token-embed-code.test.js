// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The token endpoint refuses a code that another flow stored.
 *
 * The authorization code store also holds the one-time code of the sign-in for a
 * framed iHub (`purpose: 'embed-session'`, see `routes/embedAuth.js`). That code
 * is for its own endpoint. Presented at `POST /api/oauth/token` it must be
 * answered like any unknown code: `invalid_grant`, and it is used up.
 *
 * The control: the same stored data without a `purpose` gets past that check
 * (and stops at a later one), so it is the `purpose` that is refused.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-oauth-embed-code-'));
const clientsFile = path.join(tmpDir, 'oauth-clients.json');

const platform = {
  oauth: { enabled: { authz: true, clients: true }, clientsFile },
  jwt: { algorithm: 'HS256' },
  auth: { jwtSecret: 'test-secret-for-oauth-token-embed-code' },
  rateLimit: { oauthTokenApi: { limit: 10000 } }
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => platform, get: () => null, setCacheEntry: () => {} }
}));

const { default: registerOAuthRoutes } = await import('../routes/oauth.js');
const { createOAuthClient } = await import('../utils/oauthClientManager.js');
const { generateCode, storeCode } = await import('../utils/authorizationCodeStore.js');
const { generateCodeChallenge, generateCodeVerifier } = await import('../utils/pkceUtils.js');

const app = express();
app.use(express.json());
registerOAuthRoutes(app);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const REDIRECT_URI = 'https://client.example.com/callback';
const INVALID_CODE = 'Authorization code is invalid or expired';

async function exchange(extra) {
  const created = await createOAuthClient(
    { name: 'Code client', grantTypes: ['authorization_code'], allowedApps: ['*'] },
    clientsFile,
    'test'
  );
  const verifier = generateCodeVerifier();
  const code = generateCode();
  storeCode(code, {
    clientId: created.clientId,
    redirectUri: REDIRECT_URI,
    userId: 'jane',
    scopes: ['openid'],
    codeChallenge: generateCodeChallenge(verifier),
    codeChallengeMethod: 'S256',
    ...extra
  });
  return request(app).post('/api/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    client_id: created.clientId,
    client_secret: created.clientSecret
  });
}

describe('POST /api/oauth/token grant_type=authorization_code', () => {
  it('answers invalid_grant for a code stored by the embed sign-in', async () => {
    const res = await exchange({ purpose: 'embed-session', sessionToken: 'x.y.z' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(res.body.error_description).toBe(INVALID_CODE);
    expect(res.body.access_token).toBeUndefined();
  });

  it('does not stop a code without a purpose at that check', async () => {
    const res = await exchange({});

    expect(res.body.error_description).not.toBe(INVALID_CODE);
    expect(res.body.access_token).toBeUndefined();
  });
});
