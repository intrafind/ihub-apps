/**
 * Tests for the admin proxy API (server/routes/admin/proxy.js).
 *
 * Covers the contract the admin UI depends on: passwords never leave the server
 * in the clear, a masked password survives a round-trip, `${ENV_VAR}`
 * placeholders are stored verbatim rather than encrypted, invalid URLs and
 * uncompilable `urlPatterns` are rejected by name, and the failure classifier
 * pairs each cause with the next thing to check.
 *
 * The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { stored: {}, platform: {}, refreshed: [] };

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    refreshCacheEntry: async key => {
      state.refreshed.push(key);
      // Mirror the real cache: after a save the platform config reflects the file.
      state.platform = JSON.parse(JSON.stringify(state.stored));
    }
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: async () => JSON.parse(JSON.stringify(state.stored)),
    readJsonStrict: async () => JSON.parse(JSON.stringify(state.stored)),
    writeJson: async (_path, data) => {
      state.stored = JSON.parse(JSON.stringify(data));
    }
  }
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

// A reversible stand-in for AES-GCM: the tests care that secrets are stored
// encrypted and round-trip, not about the cipher.
jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: {
    isEncrypted: v => typeof v === 'string' && v.startsWith('ENC[') && v.endsWith(']'),
    encryptString: v => `ENC[${v}]`,
    decryptString: v => v.slice(4, -1)
  }
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

// The SSRF guard resolves DNS for real; stub it so the suite stays hermetic.
jest.unstable_mockModule('../services/mcp/safeFetch.js', () => ({
  assertSafeHost: async hostname => {
    if (hostname === 'blocked.internal') {
      const error = new Error(`SSRF guard: hostname ${hostname} resolves to private IP 10.0.0.1`);
      error.code = 'SSRF_BLOCKED';
      throw error;
    }
  }
}));

// The test host may itself sit behind a proxy (HTTPS_PROXY in the ambient
// environment), which the provenance resolver legitimately falls back to. Cleared
// before the import because server/config.js snapshots the environment when it is
// first loaded — so the assertions describe the stored config, not the machine.
const PROXY_ENV_VARS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy'
];
const savedEnv = {};
for (const name of PROXY_ENV_VARS) {
  savedEnv[name] = process.env[name];
  delete process.env[name];
}

const {
  default: registerAdminProxyRoutes,
  classifyProxyTestResult,
  clampTestTimeout
} = await import('../routes/admin/proxy.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  registerAdminProxyRoutes(app);
  return app;
}

afterAll(() => {
  for (const name of PROXY_ENV_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

beforeEach(() => {
  state.stored = { ssl: { ignoreInvalidCertificates: false }, proxy: {} };
  state.platform = JSON.parse(JSON.stringify(state.stored));
  state.refreshed = [];
});

describe('GET /api/admin/proxy/config', () => {
  test('masks the proxy password and never returns ciphertext', async () => {
    state.stored.proxy = { enabled: true, https: 'ENC[http://user:s3cr3t@proxy:8080]' };
    state.platform = JSON.parse(JSON.stringify(state.stored));

    const response = await request(createTestApp()).get('/api/admin/proxy/config');

    expect(response.status).toBe(200);
    expect(response.body.config.https).toBe('http://user:***REDACTED***@proxy:8080/');
    expect(JSON.stringify(response.body)).not.toContain('s3cr3t');
    expect(JSON.stringify(response.body)).not.toContain('ENC[');
  });

  test('returns ${ENV_VAR} placeholders verbatim and flags the unresolved one', async () => {
    // Unresolved: configCache leaves the placeholder in place when the variable
    // is not set, so the cached block matches the file.
    state.stored.proxy = { enabled: true, https: '${HTTPS_PROXY}' };
    state.platform = JSON.parse(JSON.stringify(state.stored));

    const response = await request(createTestApp()).get('/api/admin/proxy/config');

    expect(response.body.config.https).toBe('${HTTPS_PROXY}');
    expect(response.body.unresolvedPlaceholders.https).toBe('${HTTPS_PROXY}');
  });

  // configCache substitutes ${ENV_VAR} on load, so the cached block holds the
  // resolved URL. The editor must still receive the placeholder, or the next save
  // would replace the indirection with whatever it happened to resolve to.
  test('shows the placeholder in the editor while reporting the resolved value as effective', async () => {
    state.stored.proxy = { enabled: true, https: '${HTTPS_PROXY}' };
    state.platform = { proxy: { enabled: true, https: 'http://resolved-proxy:8080' } };

    const response = await request(createTestApp()).get('/api/admin/proxy/config');

    expect(response.body.config.https).toBe('${HTTPS_PROXY}');
    expect(response.body.effective.https).toBe('http://resolved-proxy:8080');
  });

  test('reports where each effective field comes from', async () => {
    state.stored.proxy = { enabled: false, noProxy: 'localhost' };
    state.platform = JSON.parse(JSON.stringify(state.stored));

    const response = await request(createTestApp()).get('/api/admin/proxy/config');

    expect(response.body.provenance.enabled).toBe('platform');
    expect(response.body.provenance.noProxy).toBe('platform');
    expect(response.body.provenance.urlPatterns).toBe('default');
    expect(response.body.effective.noProxy).toEqual(['localhost']);
  });
});

describe('PUT /api/admin/proxy/config', () => {
  test('encrypts the proxy URL at rest and applies without a restart', async () => {
    const response = await request(createTestApp())
      .put('/api/admin/proxy/config')
      .send({ enabled: true, https: 'http://user:s3cr3t@proxy:8080', noProxy: 'localhost' });

    expect(response.status).toBe(200);
    expect(state.stored.proxy.https).toBe('ENC[http://user:s3cr3t@proxy:8080]');
    expect(state.refreshed).toContain('config/platform.json');
    expect(JSON.stringify(response.body)).not.toContain('s3cr3t');
  });

  test('keeps the stored password when the mask is sent back', async () => {
    state.stored.proxy = { enabled: true, https: 'ENC[http://user:s3cr3t@proxy:8080]' };
    state.platform = JSON.parse(JSON.stringify(state.stored));

    await request(createTestApp())
      .put('/api/admin/proxy/config')
      .send({ enabled: true, https: 'http://user:***REDACTED***@proxy:8080' });

    expect(state.stored.proxy.https).toBe('ENC[http://user:s3cr3t@proxy:8080/]');
  });

  test('lets the host change while the masked password is kept', async () => {
    state.stored.proxy = { enabled: true, https: 'ENC[http://user:s3cr3t@old:8080]' };
    state.platform = JSON.parse(JSON.stringify(state.stored));

    await request(createTestApp())
      .put('/api/admin/proxy/config')
      .send({ enabled: true, https: 'http://user:***REDACTED***@new:3128' });

    expect(state.stored.proxy.https).toBe('ENC[http://user:s3cr3t@new:3128/]');
  });

  test('stores a ${ENV_VAR} placeholder unencrypted so the indirection survives', async () => {
    await request(createTestApp())
      .put('/api/admin/proxy/config')
      .send({ enabled: true, https: '${HTTPS_PROXY}' });

    expect(state.stored.proxy.https).toBe('${HTTPS_PROXY}');
  });

  test('accepts noProxy as an array as well as a string', async () => {
    const response = await request(createTestApp())
      .put('/api/admin/proxy/config')
      .send({ enabled: true, noProxy: ['localhost', '.local'] });

    expect(response.status).toBe(200);
    expect(state.stored.proxy.noProxy).toEqual(['localhost', '.local']);
    expect(response.body.effective.noProxy).toEqual(['localhost', '.local']);
  });

  test('rejects a proxy URL that is not a URL, naming the field', async () => {
    const response = await request(createTestApp())
      .put('/api/admin/proxy/config')
      .send({ enabled: true, https: 'proxy.example.com:8080' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('proxy.https');
    expect(state.stored.proxy.https).toBeUndefined();
  });

  test('rejects an uncompilable urlPatterns entry, naming the pattern', async () => {
    const response = await request(createTestApp())
      .put('/api/admin/proxy/config')
      .send({ enabled: true, urlPatterns: ['api\\.openai\\.com', '(unclosed'] });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('proxy.urlPatterns.1');
    expect(response.body.error).toContain('(unclosed');
  });
});

describe('POST /api/admin/proxy/test', () => {
  test('refuses a target the SSRF guard blocks, pointing at the allowlist', async () => {
    const response = await request(createTestApp())
      .post('/api/admin/proxy/test')
      .send({ url: 'http://blocked.internal/health' });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('ssrf.allowedHosts');
  });

  test('rejects a non-http(s) scheme', async () => {
    const response = await request(createTestApp())
      .post('/api/admin/proxy/test')
      .send({ url: 'file:///etc/passwd' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('file');
  });

  test('rejects a draft config that would not be accepted on save', async () => {
    const response = await request(createTestApp())
      .post('/api/admin/proxy/test')
      .send({ url: 'https://example.com/', config: { urlPatterns: ['(unclosed'] } });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('proxy.urlPatterns.0');
  });

  test('reports the routing decision for a draft config without saving it', async () => {
    const response = await request(createTestApp())
      .post('/api/admin/proxy/test')
      .send({
        url: 'https://api.internal.test/health',
        timeoutMs: 1000,
        config: { enabled: true, https: 'http://proxy.invalid:8080', noProxy: '.internal.test' }
      });

    expect(response.status).toBe(200);
    expect(response.body.routing.decision).toBe('bypassed');
    // Nothing was written: a test must not change the saved configuration.
    expect(state.stored.proxy).toEqual({});
  });

  // "Test before save" has to answer for the config as it would run, so a draft
  // still holding `${HTTPS_PROXY}` must be tested against the proxy that variable
  // names — not reported as "no proxy configured for this URL".
  test('resolves a ${ENV_VAR} in a draft config before deciding the routing', async () => {
    process.env.HTTPS_PROXY = 'http://resolved-proxy.invalid:8080';
    try {
      const response = await request(createTestApp())
        .post('/api/admin/proxy/test')
        .send({
          url: 'https://example.invalid/',
          timeoutMs: 1000,
          config: { enabled: true, https: '${HTTPS_PROXY}' }
        });

      expect(response.status).toBe(200);
      expect(response.body.routing.decision).toBe('proxied');
      expect(response.body.routing.proxyUrl).toBe('http://resolved-proxy.invalid:8080');
    } finally {
      delete process.env.HTTPS_PROXY;
    }
  }, 15000);

  test('reports the SSL decision the real request would make', async () => {
    // ssl.ignoreInvalidCertificates + a matching domainWhitelist entry is the same
    // admin opt-in createAgent() honors; the test must not report a TLS failure the
    // live traffic never sees.
    state.platform.ssl = { ignoreInvalidCertificates: true, domainWhitelist: ['example.invalid'] };

    const response = await request(createTestApp())
      .post('/api/admin/proxy/test')
      .send({ url: 'https://example.invalid/', timeoutMs: 1000, config: { enabled: false } });

    expect(response.status).toBe(200);
    expect(response.body.ssl.ignoreInvalidCertificates).toBe(true);
  }, 15000);

  test('never echoes the proxy password in the result', async () => {
    const response = await request(createTestApp())
      .post('/api/admin/proxy/test')
      .send({
        url: 'https://example.invalid/',
        timeoutMs: 1000,
        config: { enabled: true, https: 'http://user:s3cr3t@proxy.invalid:8080' }
      });

    expect(response.status).toBe(200);
    expect(response.body.routing.decision).toBe('proxied');
    expect(JSON.stringify(response.body)).not.toContain('s3cr3t');
  }, 15000);
});

describe('clampTestTimeout', () => {
  // The value arrives in a request body and becomes a timer duration and a socket
  // timeout, so it never reaches either unbounded.
  test('keeps a value inside the allowed range', () => {
    expect(clampTestTimeout(5000)).toBe(5000);
    expect(clampTestTimeout('5000')).toBe(5000);
  });

  test('caps a value above the ceiling', () => {
    expect(clampTestTimeout(10 * 60 * 1000)).toBe(30000);
    expect(clampTestTimeout(Number.MAX_SAFE_INTEGER)).toBe(30000);
  });

  test('falls back to the default below the floor or when unparseable', () => {
    expect(clampTestTimeout(0)).toBe(10000);
    expect(clampTestTimeout(-1)).toBe(10000);
    expect(clampTestTimeout('nonsense')).toBe(10000);
    expect(clampTestTimeout(undefined)).toBe(10000);
    expect(clampTestTimeout(Infinity)).toBe(10000);
  });
});

describe('classifyProxyTestResult', () => {
  test('separates a proxy that will not accept a connection from a target failure', () => {
    const verdict = classifyProxyTestResult({
      error: new Error('request to https://x failed'),
      proxyProbe: { reachable: false, code: 'ECONNREFUSED' },
      viaProxy: true
    });
    expect(verdict.classification).toBe('proxy_unreachable');
    expect(verdict.nextStep).toMatch(/proxy host and port/i);
  });

  test('flags 407 as missing proxy credentials', () => {
    expect(classifyProxyTestResult({ status: 407, viaProxy: true }).classification).toBe(
      'proxy_auth_required'
    );
  });

  test('distinguishes an unresolvable proxy host from an unresolvable target', () => {
    expect(
      classifyProxyTestResult({
        error: new Error('boom'),
        proxyProbe: { reachable: false, code: 'ENOTFOUND' },
        viaProxy: true
      }).classification
    ).toBe('proxy_dns_failure');

    expect(
      classifyProxyTestResult({
        error: Object.assign(new Error('boom'), { code: 'ENOTFOUND' }),
        viaProxy: false
      }).classification
    ).toBe('dns_failure');
  });

  test('recognises a certificate failure and suggests the SSL settings', () => {
    const verdict = classifyProxyTestResult({
      error: Object.assign(new Error('self signed certificate in certificate chain'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN'
      }),
      viaProxy: true
    });
    expect(verdict.classification).toBe('tls_failure');
    expect(verdict.nextStep).toMatch(/ssl\.domainWhitelist/);
  });

  test('reports a timeout as its own cause, not a generic failure', () => {
    expect(
      classifyProxyTestResult({
        error: Object.assign(new Error('aborted'), { name: 'AbortError' }),
        viaProxy: true
      }).classification
    ).toBe('timeout');
  });

  test('an HTTP error status still means the transport worked', () => {
    const verdict = classifyProxyTestResult({ status: 404, viaProxy: true });
    expect(verdict.classification).toBe('http_error');
    expect(verdict.nextStep).toMatch(/proxy hop works/i);
  });

  test('a 2xx is a success', () => {
    expect(classifyProxyTestResult({ status: 200, viaProxy: true }).classification).toBe('ok');
  });
});
