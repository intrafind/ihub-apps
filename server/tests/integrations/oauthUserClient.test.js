// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The shared per-user OAuth client (services/integrations/auth/OAuthUserClient.js):
 * PKCE, the authorization request, code exchange, refresh, revocation, the
 * RFC 9207 `iss` check and scope step-up — against a local token endpoint.
 *
 * Run: node --test server/tests/integrations/oauthUserClient.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  OAuthUserClient,
  OAuthFlowError,
  buildAuthorizationUrl,
  checkAuthorizationResponseIssuer,
  createPkcePair,
  definitiveOAuthRejection,
  parseWwwAuthenticate,
  selectClientAuthMethod,
  stepUpScopes,
  unionScopes
} from '../../services/integrations/auth/OAuthUserClient.js';
import { createFixedEndpointStrategy } from '../../services/integrations/auth/strategies/fixedEndpoint.js';
import { fakeTokenEndpoint } from '../helpers/integrationConnect.js';

const ISSUER = 'https://auth.example.com';

function strategyWith(fetchFn, extra = {}) {
  return createFixedEndpointStrategy({
    id: 'fixed:test',
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    revocationEndpoint: `${ISSUER}/revoke`,
    clientId: 'client-1',
    clientSecret: () => 'client-secret',
    scopes: ['read', 'offline_access'],
    fetchFn,
    ...extra
  });
}

describe('PKCE and the authorization request', () => {
  it('makes an S256 pair whose challenge is the hash of the verifier', () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    assert.match(codeVerifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      codeChallenge,
      crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    );
    assert.notEqual(createPkcePair().codeVerifier, codeVerifier);
  });

  it('builds code + S256 with scope, resource and provider parameters', async () => {
    const client = new OAuthUserClient({
      strategy: strategyWith(fakeTokenEndpoint(), {
        extraAuthorizationParams: { audience: 'api.example.com' }
      })
    });
    const started = await client.startAuthorization({
      redirectUri: 'https://ihub.example/cb',
      state: 's1'
    });
    const url = started.authorizationUrl;
    assert.equal(url.origin + url.pathname, `${ISSUER}/authorize`);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(
      url.searchParams.get('code_challenge'),
      crypto.createHash('sha256').update(started.codeVerifier).digest('base64url')
    );
    assert.equal(url.searchParams.get('scope'), 'read offline_access');
    assert.equal(url.searchParams.get('prompt'), 'consent', 'offline_access needs consent');
    assert.equal(url.searchParams.get('audience'), 'api.example.com');
    assert.equal(url.searchParams.get('state'), 's1');
    assert.equal(started.issuer, ISSUER);
    assert.equal(started.clientId, 'client-1');
    assert.equal(url.searchParams.get('client_secret'), null, 'never a secret in the URL');
  });

  it('refuses a server that cannot do the code flow with S256', () => {
    assert.throws(
      () =>
        buildAuthorizationUrl({
          metadata: {
            authorization_endpoint: `${ISSUER}/a`,
            code_challenge_methods_supported: ['plain']
          },
          clientId: 'c',
          redirectUri: 'https://x/cb',
          codeChallenge: 'x'
        }),
      error => error instanceof OAuthFlowError && error.code === 'discovery_failed'
    );
  });
});

describe('code exchange', () => {
  it('sends code, verifier, redirect URI and the client, and keeps every field', async () => {
    const endpoint = fakeTokenEndpoint([{ user_id: 'nc-user', scope: 'read' }]);
    const client = new OAuthUserClient({ strategy: strategyWith(endpoint) });
    const { tokens } = await client.exchangeCode({
      code: 'the-code',
      codeVerifier: 'the-verifier',
      redirectUri: 'https://ihub.example/cb'
    });
    const params = endpoint.calls[0].params;
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('code'), 'the-code');
    assert.equal(params.get('code_verifier'), 'the-verifier');
    assert.equal(params.get('redirect_uri'), 'https://ihub.example/cb');
    assert.equal(params.get('client_id'), 'client-1');
    assert.equal(params.get('client_secret'), 'client-secret');
    assert.equal(tokens.accessToken, 'access-1');
    assert.equal(tokens.refreshToken, 'refresh-1');
    assert.equal(tokens.expiresIn, 3600);
    assert.equal(tokens.raw.user_id, 'nc-user');
  });

  it('never exchanges at a registration other than the one the sign-in started with', async () => {
    const endpoint = fakeTokenEndpoint();
    const client = new OAuthUserClient({ strategy: strategyWith(endpoint) });
    await assert.rejects(
      client.exchangeCode({
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'https://ihub.example/cb',
        expected: { clientId: 'another-client' }
      }),
      error => error.code === 'exchange_failed'
    );
    assert.equal(endpoint.calls.length, 0);
  });

  it('types invalid_client as such and everything else as exchange_failed', async () => {
    const rejectClient = new OAuthUserClient({
      strategy: strategyWith(
        fakeTokenEndpoint([{ status: 401, body: { error: 'invalid_client' } }])
      )
    });
    await assert.rejects(
      rejectClient.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://x/cb' }),
      error => error.code === 'invalid_client'
    );
    const rejectGrant = new OAuthUserClient({
      strategy: strategyWith(fakeTokenEndpoint([{ status: 400, body: { error: 'invalid_grant' } }]))
    });
    await assert.rejects(
      rejectGrant.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://x/cb' }),
      error => error.code === 'exchange_failed' && !/the-code|v\b/.test(error.message)
    );
  });
});

describe('refresh', () => {
  it('keeps the refresh token when the server does not rotate it, takes a rotated one', async () => {
    const keep = new OAuthUserClient({
      strategy: strategyWith(fakeTokenEndpoint([{ refresh_token: undefined }]))
    });
    const kept = await keep.refresh({ refreshToken: 'r-old' });
    assert.equal(kept.refreshToken, 'r-old');

    const endpoint = fakeTokenEndpoint([{ refresh_token: 'r-new' }]);
    const rotate = new OAuthUserClient({
      strategy: strategyWith(endpoint, { extraRefreshParams: { scope: 'read' } })
    });
    const rotated = await rotate.refresh({ refreshToken: 'r-old' });
    assert.equal(rotated.refreshToken, 'r-new');
    assert.equal(endpoint.calls[0].params.get('grant_type'), 'refresh_token');
    assert.equal(endpoint.calls[0].params.get('refresh_token'), 'r-old');
    assert.equal(endpoint.calls[0].params.get('scope'), 'read');
  });

  it('never sends a refresh token to a client it was not issued to (credentials keyed by issuer)', async () => {
    const endpoint = fakeTokenEndpoint();
    const client = new OAuthUserClient({ strategy: strategyWith(endpoint) });
    await assert.rejects(
      client.refresh({ refreshToken: 'r', binding: { clientId: 'old-client' } }),
      error => error.errorCode === 'other_client'
    );
    await assert.rejects(
      client.refresh({ refreshToken: 'r', binding: { authorizationServerUrl: 'https://other' } }),
      error => error.errorCode === 'other_client'
    );
    assert.equal(endpoint.calls.length, 0);
  });

  it('keeps the error_description for classification, never in the message', async () => {
    const client = new OAuthUserClient({
      strategy: strategyWith(
        fakeTokenEndpoint([
          {
            status: 403,
            body: { error: 'unauthorized_client', error_description: 'refresh_token is invalid' }
          }
        ])
      )
    });
    const error = await client.refresh({ refreshToken: 'r' }).catch(e => e);
    assert.equal(error.errorCode, 'unauthorized_client');
    assert.equal(error.errorDescription, 'refresh_token is invalid');
    assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, /refresh_token is invalid/);
  });

  it('tells a definitive refusal from a transient failure', async () => {
    const answers = [
      [{ status: 400, body: { error: 'invalid_grant' } }, 'invalid_grant'],
      [{ status: 401, body: { error: 'invalid_client' } }, 'invalid_client'],
      [{ status: 400, body: { error: 'unauthorized_client' } }, 'unauthorized_client'],
      [{ status: 503, body: {} }, null],
      [{ status: 429, body: { error: 'temporarily_unavailable' } }, null]
    ];
    for (const [answer, expected] of answers) {
      const client = new OAuthUserClient({ strategy: strategyWith(fakeTokenEndpoint([answer])) });
      const error = await client.refresh({ refreshToken: 'r' }).catch(e => e);
      assert.equal(definitiveOAuthRejection(error), expected, JSON.stringify(answer));
    }
    const offline = new OAuthUserClient({
      strategy: strategyWith(async () => {
        throw new Error('ECONNRESET');
      })
    });
    assert.equal(
      definitiveOAuthRejection(await offline.refresh({ refreshToken: 'r' }).catch(e => e)),
      null
    );
  });
});

describe('revocation (RFC 7009)', () => {
  it('revokes the refresh and the access token, best effort', async () => {
    const endpoint = fakeTokenEndpoint([{}]);
    const client = new OAuthUserClient({ strategy: strategyWith(endpoint) });
    assert.equal(await client.revoke({ tokens: { accessToken: 'a', refreshToken: 'r' } }), true);
    assert.deepEqual(
      endpoint.calls.map(call => [
        call.url,
        call.params.get('token_type_hint'),
        call.params.get('token')
      ]),
      [
        [`${ISSUER}/revoke`, 'refresh_token', 'r'],
        [`${ISSUER}/revoke`, 'access_token', 'a']
      ]
    );
  });

  it('never revokes tokens bound to another authorization server or client', async () => {
    const endpoint = fakeTokenEndpoint([{}]);
    const client = new OAuthUserClient({ strategy: strategyWith(endpoint) });
    for (const binding of [
      { clientId: 'old-client' },
      { authorizationServerUrl: 'https://old-as.example.com/' }
    ]) {
      assert.equal(
        await client.revoke({ tokens: { accessToken: 'a', refreshToken: 'r' }, binding }),
        false
      );
    }
    assert.equal(endpoint.calls.length, 0);
    assert.equal(
      await client.revoke({
        tokens: { accessToken: 'a' },
        binding: { clientId: 'client-1', authorizationServerUrl: ISSUER }
      }),
      true
    );
  });

  it('reports false (and never throws) when there is no endpoint or the server refuses', async () => {
    const noEndpoint = new OAuthUserClient({
      strategy: createFixedEndpointStrategy({
        id: 'fixed:none',
        issuer: ISSUER,
        authorizationEndpoint: `${ISSUER}/a`,
        tokenEndpoint: `${ISSUER}/t`,
        clientId: 'c',
        fetchFn: fakeTokenEndpoint()
      })
    });
    assert.equal(await noEndpoint.revoke({ tokens: { accessToken: 'a' } }), false);
    const refusing = new OAuthUserClient({
      strategy: strategyWith(fakeTokenEndpoint([{ status: 400, body: {} }]))
    });
    assert.equal(await refusing.revoke({ tokens: { accessToken: 'a' } }), false);
  });
});

describe('RFC 9207 iss', () => {
  it('accepts the expected issuer, refuses another and a missing one when promised', () => {
    checkAuthorizationResponseIssuer({ iss: ISSUER, expectedIssuer: ISSUER, issRequired: true });
    checkAuthorizationResponseIssuer({ iss: undefined, expectedIssuer: ISSUER });
    assert.throws(
      () => checkAuthorizationResponseIssuer({ iss: 'https://evil', expectedIssuer: ISSUER }),
      error => error.code === 'issuer_mismatch'
    );
    assert.throws(
      () =>
        checkAuthorizationResponseIssuer({
          iss: undefined,
          expectedIssuer: ISSUER,
          issRequired: true
        }),
      error => error.code === 'issuer_mismatch'
    );
    assert.throws(
      () => checkAuthorizationResponseIssuer({ iss: '', expectedIssuer: ISSUER }),
      error => error.code === 'issuer_mismatch',
      'a repeated parameter (empty) is not an issuer'
    );
  });
});

describe('scope step-up (insufficient_scope → union → re-authorize once)', () => {
  const challenge = 'Bearer error="insufficient_scope", scope="write admin", resource_metadata="x"';

  it('parses a Bearer challenge', () => {
    assert.deepEqual(parseWwwAuthenticate(challenge), {
      scheme: 'Bearer',
      params: { error: 'insufficient_scope', scope: 'write admin', resource_metadata: 'x' }
    });
  });

  it('asks for the union of the granted, the requested and the challenged scopes', () => {
    assert.deepEqual(stepUpScopes({ granted: 'read', requested: ['profile'], challenge }), {
      scopes: ['read', 'profile', 'write', 'admin']
    });
    assert.deepEqual(unionScopes('a b', ['b', 'c'], undefined), ['a', 'b', 'c']);
  });

  it('re-authorizes only once: no step-up when the scopes are already held or it was tried', () => {
    assert.equal(stepUpScopes({ granted: ['read', 'write', 'admin'], challenge }), null);
    assert.equal(stepUpScopes({ granted: 'read', challenge, alreadySteppedUp: true }), null);
    assert.equal(
      stepUpScopes({ granted: 'read', challenge: 'Bearer error="invalid_token"' }),
      null
    );
  });

  it('adds the step-up scopes to the authorization request', async () => {
    const client = new OAuthUserClient({ strategy: strategyWith(fakeTokenEndpoint()) });
    const started = await client.startAuthorization({
      redirectUri: 'https://ihub.example/cb',
      extraScopes: ['write']
    });
    assert.equal(started.authorizationUrl.searchParams.get('scope'), 'read offline_access write');
    assert.deepEqual(started.scopes, ['read', 'offline_access', 'write']);
  });
});

describe('client authentication', () => {
  it('negotiates like RFC 8414 when the strategy does not fix it', () => {
    assert.equal(selectClientAuthMethod({ client_secret: 's' }, []), 'client_secret_basic');
    assert.equal(selectClientAuthMethod({}, []), 'none');
    assert.equal(
      selectClientAuthMethod({ client_secret: 's' }, ['client_secret_post']),
      'client_secret_post'
    );
    assert.equal(
      selectClientAuthMethod({ token_endpoint_auth_method: 'none' }, [
        'none',
        'client_secret_basic'
      ]),
      'none'
    );
  });

  it('builds the authorization URL without resolving the client secret', async () => {
    let resolved = 0;
    const client = new OAuthUserClient({
      strategy: strategyWith(fakeTokenEndpoint(), {
        clientSecret: () => {
          resolved += 1;
          return 'secret';
        }
      })
    });
    await client.startAuthorization({ redirectUri: 'https://ihub.example/cb' });
    assert.equal(resolved, 0);
    await client.refresh({ refreshToken: 'r' });
    assert.equal(resolved, 1);
  });
});
