// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Entra directory connector's installation test and the token cache it
 * relies on (#3080 review): a token is cached per tenant, client *and* secret,
 * `fresh` keeps the test out of the shared cache both ways, and a secret
 * credential that does not resolve is reported instead of silently replaced
 * by `AZURE_CLIENT_SECRET`.
 *
 * The token endpoint and Graph are faked through `httpFetch`.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const httpFetch = jest.fn();
jest.unstable_mockModule('../../utils/httpConfig.js', () => ({ httpFetch }));

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../utils/logger.js', () => ({ default: logger }));

jest.unstable_mockModule('../../configCache.js', () => ({
  default: { getIntegrations: () => ({ data: { installed: [] } }) }
}));

// Credentials by id; a missing id resolves to nothing like a deleted one.
const credentials = new Map();
jest.unstable_mockModule('../../services/CredentialService.js', () => ({
  default: { tryResolveSecret: ref => credentials.get(ref) }
}));

const { default: entraService } = await import('../../services/integrations/EntraService.js');
const { entraConfigFromInstance } = await import('../../services/integrations/entraConfig.js');
const { default: connector } =
  await import('../../services/integrations/protocols/native/connectors/entra/index.js');

const TOKEN_URL = 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token';
const GOOD_SECRET = 'correct-horse';

function cfg(overrides = {}) {
  return {
    enabled: true,
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecretRef: '',
    clientSecret: GOOD_SECRET,
    clientSecretSource: 'env',
    ...overrides
  };
}

function jsonResponse(status, body) {
  return { ok: status < 400, status, json: async () => body };
}

/** The token endpoint accepts GOOD_SECRET only; Graph lists one user. */
let issued = 0;
function fakeNetwork() {
  httpFetch.mockImplementation(async (url, options = {}) => {
    if (url === TOKEN_URL) {
      const params = new URLSearchParams(options.body.toString());
      if (params.get('client_secret') !== GOOD_SECRET) {
        return jsonResponse(401, { error: 'invalid_client' });
      }
      issued += 1;
      return jsonResponse(200, { access_token: `token-${issued}`, expires_in: 3600 });
    }
    if (url.startsWith('https://graph.microsoft.com/v1.0/users')) {
      return jsonResponse(200, { value: [{ id: 'u1', displayName: 'Ada' }] });
    }
    throw new Error(`unexpected request ${url}`);
  });
}

function tokenRequests() {
  return httpFetch.mock.calls
    .filter(([url]) => url === TOKEN_URL)
    .map(([, options]) => new URLSearchParams(options.body.toString()).get('client_secret'));
}

const savedEnv = {};
beforeEach(() => {
  issued = 0;
  httpFetch.mockReset();
  fakeNetwork();
  credentials.clear();
  entraService.resetConfig();
  for (const key of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('EntraService token cache', () => {
  it('reuses a token for the same tenant, client and secret', async () => {
    expect(await entraService._getAccessToken(cfg())).toBe('token-1');
    expect(await entraService._getAccessToken(cfg())).toBe('token-1');
    expect(tokenRequests()).toEqual([GOOD_SECRET]);
  });

  it('does not hand out a token acquired with another secret', async () => {
    expect(await entraService._getAccessToken(cfg())).toBe('token-1');
    // Same tenant and client, different secret: the cached token is not it.
    await expect(entraService._getAccessToken(cfg({ clientSecret: 'wrong' }))).rejects.toThrow(
      'Failed to acquire access token.'
    );
    expect(tokenRequests()).toEqual([GOOD_SECRET, 'wrong']);
    // The cache still serves the secret it was acquired with.
    expect(await entraService._getAccessToken(cfg())).toBe('token-1');
    expect(tokenRequests()).toHaveLength(2);
  });

  it('keeps the secret out of the cache key', () => {
    expect(JSON.stringify(entraService)).not.toContain(GOOD_SECRET);
  });

  it('fresh: fetches anew and neither reads nor fills the shared cache', async () => {
    expect(await entraService._getAccessToken(cfg())).toBe('token-1');
    // Bypasses the cached token-1 and asks the tenant again …
    expect(await entraService._getAccessToken(cfg(), { fresh: true })).toBe('token-2');
    // … without replacing what the runtime uses.
    expect(await entraService._getAccessToken(cfg())).toBe('token-1');

    entraService.resetConfig();
    expect(await entraService._getAccessToken(cfg(), { fresh: true })).toBe('token-3');
    // Nothing was stored: the next runtime call fetches its own token.
    expect(await entraService._getAccessToken(cfg())).toBe('token-4');
    expect(tokenRequests()).toHaveLength(4);
  });
});

describe('entra connector test', () => {
  const values = { tenantId: 'tenant-1', clientId: 'client-1', clientSecretRef: 'cred-entra' };

  function stepsById(steps) {
    return Object.fromEntries(steps.map(step => [step.id, step]));
  }

  it('passes with a credential that holds the right secret', async () => {
    credentials.set('cred-entra', GOOD_SECRET);
    const steps = stepsById(await connector.test({ instance: { id: 'entra' }, values }));
    expect(steps.settings.status).toBe('ok');
    expect(steps.settings.message).not.toContain('AZURE_CLIENT_SECRET');
    expect(steps.token.status).toBe('ok');
    expect(steps.graph).toMatchObject({ status: 'ok', message: expect.stringContaining('Ada') });
  });

  it('fails on a wrong draft secret although the runtime holds a token for the tenant', async () => {
    // The runtime acquired a token with the saved (right) secret …
    expect(await entraService._getAccessToken(cfg())).toBe('token-1');
    // … and the admin tests a draft that points at a credential with a wrong value.
    credentials.set('cred-entra', 'expired-secret');
    const steps = stepsById(await connector.test({ instance: { id: 'entra' }, values }));
    expect(steps.settings.status).toBe('ok');
    expect(steps.token.status).toBe('fail');
    expect(steps.graph).toBeUndefined();
    // The entered secret was sent, not the cached token reused.
    expect(tokenRequests()).toEqual([GOOD_SECRET, 'expired-secret']);
  });

  it('does not leave the test token in the shared cache', async () => {
    credentials.set('cred-entra', GOOD_SECRET);
    await connector.test({ instance: { id: 'entra' }, values });
    expect(tokenRequests()).toEqual([GOOD_SECRET]);
    expect(await entraService._getAccessToken(cfg())).toBe('token-2');
  });

  it('warns when the credential does not resolve and AZURE_CLIENT_SECRET stood in', async () => {
    process.env.AZURE_CLIENT_SECRET = GOOD_SECRET;
    const steps = stepsById(await connector.test({ instance: { id: 'entra' }, values }));
    expect(steps.settings).toMatchObject({
      status: 'warn',
      message:
        'Credential "cred-entra" has no value or does not exist; the secret came from AZURE_CLIENT_SECRET'
    });
    // The test goes on with the variable's secret so the rest is still checked.
    expect(steps.token.status).toBe('ok');
    expect(steps.graph.status).toBe('ok');
  });

  it('fails when the credential does not resolve and there is no environment fallback', async () => {
    credentials.set('cred-entra', '');
    const steps = await connector.test({ instance: { id: 'entra' }, values });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: 'settings', status: 'fail' });
    expect(steps[0].message).toContain('Credential "cred-entra" has no value or does not exist');
    expect(steps[0].message).toContain('Missing: clientSecret');
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('says so when the secret comes from the environment on purpose', async () => {
    process.env.AZURE_CLIENT_SECRET = GOOD_SECRET;
    const steps = stepsById(
      await connector.test({
        instance: { id: 'entra' },
        values: { tenantId: 'tenant-1', clientId: 'client-1' }
      })
    );
    expect(steps.settings).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('(secret from AZURE_CLIENT_SECRET)')
    });
  });
});

describe('entraConfigFromInstance', () => {
  it('names where the secret came from', () => {
    const instance = { id: 'entra', values: { clientSecretRef: 'cred-entra' } };
    expect(entraConfigFromInstance(instance, {}).clientSecretSource).toBe('');
    expect(entraConfigFromInstance(instance, { AZURE_CLIENT_SECRET: 'env-secret' })).toMatchObject({
      clientSecret: 'env-secret',
      clientSecretSource: 'env'
    });
    credentials.set('cred-entra', 'cred-secret');
    expect(entraConfigFromInstance(instance, { AZURE_CLIENT_SECRET: 'env-secret' })).toMatchObject({
      clientSecret: 'cred-secret',
      clientSecretSource: 'credential'
    });
  });
});
