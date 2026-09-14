/**
 * Client ID Metadata Documents (CIMD).
 *
 * A CIMD `client_id` is an HTTPS URL supplied by whoever opened the
 * authorization request, so almost everything here is about refusing one
 * safely: the host allowlist is consulted before any network call, the fetch is
 * SSRF-guarded and bounded, and only a structurally valid document is cached.
 *
 * Also locked in: the RFC 8252 §7.3 loopback-port rule (without it Claude Code
 * cannot complete a single flow), the discovery flag Claude keys off, and the
 * `mcpAuth` kill switch — disabling CIMD or dropping a host must stop tokens
 * that were already issued, not just new authorizations.
 *
 * Native-ESM jest (`NODE_OPTIONS=--experimental-vm-modules`); see the
 * `test:oauth` npm script, which `test:quick` chains in.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {
  platform: {},
  // Stands in for the network. Each entry is what the client's host "serves".
  responses: new Map(),
  fetchCalls: [],
  // Hosts the SSRF guard considers private.
  privateHosts: new Set()
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    get: () => null,
    setCacheEntry: () => {}
  }
}));

jest.unstable_mockModule('../utils/ssrfGuard.js', () => ({
  assertPublicTarget: async parsedUrl =>
    state.privateHosts.has(parsedUrl.hostname)
      ? { ok: false, reason: `host resolves to private IP` }
      : { ok: true, addresses: ['203.0.113.10'] },
  createPinnedLookup: () => () => {}
}));

jest.unstable_mockModule('../utils/httpConfig.js', () => ({
  httpFetch: async (url, options) => {
    state.fetchCalls.push(url);
    const canned = state.responses.get(url);
    if (!canned) throw new Error('ECONNREFUSED');
    if (canned.throws) throw new Error(canned.throws);
    return {
      status: canned.status ?? 200,
      ok: (canned.status ?? 200) < 300,
      headers: {
        get: name => canned.headers?.[name.toLowerCase()] ?? null
      },
      text: async () => canned.body,
      _requestOptions: options
    };
  }
}));

jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: { getPublicKey: () => null, getPrivateKey: () => null }
}));

const {
  clearClientMetadataCache,
  fetchClientMetadata,
  isClientIdUrl,
  isHostAllowed,
  validateClientMetadata
} = await import('../utils/clientIdMetadata.js');
const { buildPolicyCimdClient, resolveOAuthClient, getCimdConfig } =
  await import('../utils/oauthClientResolver.js');
const { allRedirectUrisAreLoopback, isValidRedirectUri } =
  await import('../routes/oauthAuthorize.js');
const { default: registerWellKnownRoutes } = await import('../routes/wellKnown.js');

const CLAUDE_CODE_URL = 'https://claude.ai/oauth/claude-code-client-metadata';

const CLAUDE_CODE_DOC = {
  client_id: CLAUDE_CODE_URL,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none'
};

function serve(url, doc, { status = 200, contentType = 'application/json', headers = {} } = {}) {
  state.responses.set(url, {
    status,
    headers: { 'content-type': contentType, ...headers },
    body: typeof doc === 'string' ? doc : JSON.stringify(doc)
  });
}

function setPlatform({ enabled = true, hosts = ['claude.ai'], ...rest } = {}) {
  state.platform = {
    oauth: {
      enabled: { authz: true, clients: true },
      defaultTokenExpirationMinutes: 60,
      cimd: { enabled, allowedClientHosts: hosts, ...rest }
    }
  };
}

beforeEach(() => {
  clearClientMetadataCache();
  state.responses.clear();
  state.fetchCalls = [];
  state.privateHosts.clear();
  setPlatform();
});

describe('client_id URL detection', () => {
  test('accepts an https URL with a path', () => {
    expect(isClientIdUrl(CLAUDE_CODE_URL)).toBe(true);
  });

  test('rejects stored-style client IDs', () => {
    expect(isClientIdUrl('client_claude_a1b2c3d4')).toBe(false);
    expect(isClientIdUrl('')).toBe(false);
    expect(isClientIdUrl(null)).toBe(false);
  });

  test('rejects http, bare origins, fragments and embedded credentials', () => {
    expect(isClientIdUrl('http://claude.ai/oauth/doc')).toBe(false);
    expect(isClientIdUrl('https://claude.ai')).toBe(false);
    expect(isClientIdUrl('https://claude.ai/')).toBe(false);
    expect(isClientIdUrl('https://claude.ai/doc#frag')).toBe(false);
    expect(isClientIdUrl('https://user:pw@claude.ai/doc')).toBe(false);
  });

  test('rejects an over-long URL', () => {
    expect(isClientIdUrl(`https://claude.ai/${'x'.repeat(2100)}`)).toBe(false);
  });
});

describe('host allowlist', () => {
  test('matches exact hosts only by default', () => {
    expect(isHostAllowed(CLAUDE_CODE_URL, ['claude.ai'])).toBe(true);
    expect(isHostAllowed('https://evil.example/x', ['claude.ai'])).toBe(false);
  });

  test('supports subdomain patterns without matching the bare domain', () => {
    expect(isHostAllowed('https://api.example.com/doc', ['*.example.com'])).toBe(true);
    expect(isHostAllowed('https://api.example.com/doc', ['.example.com'])).toBe(true);
    expect(isHostAllowed('https://example.com/doc', ['*.example.com'])).toBe(false);
  });

  test('an empty list trusts nobody and "*" trusts everyone', () => {
    expect(isHostAllowed(CLAUDE_CODE_URL, [])).toBe(false);
    expect(isHostAllowed('https://anything.example/doc', ['*'])).toBe(true);
  });
});

describe('document validation', () => {
  test('accepts the Claude Code document', () => {
    const result = validateClientMetadata(CLAUDE_CODE_DOC, CLAUDE_CODE_URL);
    expect(result.ok).toBe(true);
    expect(result.metadata.name).toBe('Claude Code');
    expect(result.metadata.redirectUris).toHaveLength(2);
  });

  test('rejects a document whose client_id does not match the URL', () => {
    const result = validateClientMetadata(
      { ...CLAUDE_CODE_DOC, client_id: 'https://claude.ai/other' },
      CLAUDE_CODE_URL
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/client_id/);
  });

  test('rejects a secret-bearing auth method', () => {
    const result = validateClientMetadata(
      { ...CLAUDE_CODE_DOC, token_endpoint_auth_method: 'client_secret_post' },
      CLAUDE_CODE_URL
    );
    expect(result.ok).toBe(false);
  });

  test('rejects dangerous and missing redirect URIs', () => {
    expect(
      validateClientMetadata(
        { ...CLAUDE_CODE_DOC, redirect_uris: ['javascript:alert(1)'] },
        CLAUDE_CODE_URL
      ).ok
    ).toBe(false);
    expect(
      validateClientMetadata({ ...CLAUDE_CODE_DOC, redirect_uris: [] }, CLAUDE_CODE_URL).ok
    ).toBe(false);
  });

  test('rejects unsupported grant and response types', () => {
    expect(
      validateClientMetadata(
        { ...CLAUDE_CODE_DOC, grant_types: ['client_credentials'] },
        CLAUDE_CODE_URL
      ).ok
    ).toBe(false);
    expect(
      validateClientMetadata({ ...CLAUDE_CODE_DOC, response_types: ['token'] }, CLAUDE_CODE_URL).ok
    ).toBe(false);
  });

  test('rejects non-objects', () => {
    expect(validateClientMetadata(null, CLAUDE_CODE_URL).ok).toBe(false);
    expect(validateClientMetadata([CLAUDE_CODE_DOC], CLAUDE_CODE_URL).ok).toBe(false);
  });
});

describe('fetching a metadata document', () => {
  test('fetches, validates and caches', async () => {
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC);

    const first = await fetchClientMetadata(CLAUDE_CODE_URL);
    expect(first.ok).toBe(true);
    expect(first.metadata.name).toBe('Claude Code');

    const second = await fetchClientMetadata(CLAUDE_CODE_URL);
    expect(second.ok).toBe(true);
    // Served from cache: the host is contacted once, not once per authorize.
    expect(state.fetchCalls).toHaveLength(1);
  });

  test('refuses a target that resolves to a private address', async () => {
    serve('https://internal.example.com/doc', CLAUDE_CODE_DOC);
    state.privateHosts.add('internal.example.com');

    const result = await fetchClientMetadata('https://internal.example.com/doc');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SSRF/);
    // The guard runs before the request, so nothing was sent.
    expect(state.fetchCalls).toHaveLength(0);
  });

  test('refuses a redirect, a non-JSON body and an oversize body', async () => {
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC, { status: 302 });
    expect((await fetchClientMetadata(CLAUDE_CODE_URL)).ok).toBe(false);

    clearClientMetadataCache();
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC, { contentType: 'text/html' });
    expect((await fetchClientMetadata(CLAUDE_CODE_URL)).ok).toBe(false);

    clearClientMetadataCache();
    serve(CLAUDE_CODE_URL, { ...CLAUDE_CODE_DOC, padding: 'x'.repeat(9000) });
    expect((await fetchClientMetadata(CLAUDE_CODE_URL)).ok).toBe(false);
  });

  test('refuses a body that lies about its Content-Length', async () => {
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC, { headers: { 'content-length': '999999' } });
    const result = await fetchClientMetadata(CLAUDE_CODE_URL);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds/);
  });

  test('refuses malformed JSON', async () => {
    serve(CLAUDE_CODE_URL, '{not json');
    expect((await fetchClientMetadata(CLAUDE_CODE_URL)).ok).toBe(false);
  });

  test('does not cache a failure', async () => {
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC, { status: 500 });
    expect((await fetchClientMetadata(CLAUDE_CODE_URL)).ok).toBe(false);

    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC);
    expect((await fetchClientMetadata(CLAUDE_CODE_URL)).ok).toBe(true);
  });

  test('clamps the cache TTL to the 300s floor', async () => {
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC, { headers: { 'cache-control': 'max-age=0' } });
    await fetchClientMetadata(CLAUDE_CODE_URL);

    // A max-age of 0 must not turn every authorization into a fetch.
    await fetchClientMetadata(CLAUDE_CODE_URL);
    expect(state.fetchCalls).toHaveLength(1);
  });

  test('serves a stale document when a refresh fails', async () => {
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC, { headers: { 'cache-control': 'max-age=300' } });
    await fetchClientMetadata(CLAUDE_CODE_URL);

    jest.useFakeTimers().setSystemTime(Date.now() + 10 * 60 * 1000);
    try {
      // The host has gone away mid-flow.
      state.responses.delete(CLAUDE_CODE_URL);
      const result = await fetchClientMetadata(CLAUDE_CODE_URL);
      expect(result.ok).toBe(true);
      expect(result.stale).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('an invalid document replaces a cached one rather than falling back to it', async () => {
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC);
    await fetchClientMetadata(CLAUDE_CODE_URL);

    jest.useFakeTimers().setSystemTime(Date.now() + 10 * 60 * 1000);
    try {
      serve(CLAUDE_CODE_URL, {
        ...CLAUDE_CODE_DOC,
        token_endpoint_auth_method: 'client_secret_post'
      });
      const result = await fetchClientMetadata(CLAUDE_CODE_URL);
      expect(result.ok).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('resolveOAuthClient', () => {
  test('builds a public, never-trusted client from the document', async () => {
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC);

    const resolved = await resolveOAuthClient(CLAUDE_CODE_URL, state.platform, {
      allowFetch: true
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.client.kind).toBe('cimd');
    expect(resolved.client.clientType).toBe('public');
    expect(resolved.client.trusted).toBe(false);
    expect(resolved.client.consentRequired).toBe(true);
    expect(resolved.client.host).toBe('claude.ai');
    expect(resolved.client.active).toBe(true);
  });

  test('refuses a host that is not allowlisted without making a request', async () => {
    serve('https://evil.example/x', CLAUDE_CODE_DOC);

    const resolved = await resolveOAuthClient('https://evil.example/x', state.platform, {
      allowFetch: true
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.error).toBe('invalid_client');
    expect(state.fetchCalls).toHaveLength(0);
  });

  test('refuses every URL client when CIMD is off', async () => {
    setPlatform({ enabled: false });
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC);

    const resolved = await resolveOAuthClient(CLAUDE_CODE_URL, state.platform, {
      allowFetch: true
    });
    expect(resolved.ok).toBe(false);
    expect(state.fetchCalls).toHaveLength(0);
  });

  test('will not fetch when fetching is not allowed', async () => {
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC);

    const resolved = await resolveOAuthClient(CLAUDE_CODE_URL, state.platform, {
      allowFetch: false
    });
    expect(resolved.ok).toBe(false);
    expect(state.fetchCalls).toHaveLength(0);
  });

  test('scopes fall back to the DCR default list and can be narrowed', async () => {
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC);
    const wide = await resolveOAuthClient(CLAUDE_CODE_URL, state.platform, { allowFetch: true });
    expect(wide.client.scopes).toEqual(expect.arrayContaining(['openid', 'mcp:tools:call']));

    clearClientMetadataCache();
    setPlatform({ allowedScopes: ['openid', 'mcp:tools:read'] });
    serve(CLAUDE_CODE_URL, CLAUDE_CODE_DOC);
    const narrow = await resolveOAuthClient(CLAUDE_CODE_URL, state.platform, { allowFetch: true });
    expect(narrow.client.scopes).toEqual(['openid', 'mcp:tools:read']);
  });
});

describe('buildPolicyCimdClient — the gateway kill switch', () => {
  test('builds a client from policy with no document and no fetch', () => {
    const client = buildPolicyCimdClient(CLAUDE_CODE_URL, state.platform);
    expect(client).not.toBeNull();
    expect(client.active).toBe(true);
    expect(state.fetchCalls).toHaveLength(0);
  });

  test('returns null once CIMD is disabled', () => {
    setPlatform({ enabled: false });
    expect(buildPolicyCimdClient(CLAUDE_CODE_URL, state.platform)).toBeNull();
  });

  test('returns null once the host is dropped from the allowlist', () => {
    setPlatform({ hosts: ['example.com'] });
    expect(buildPolicyCimdClient(CLAUDE_CODE_URL, state.platform)).toBeNull();
  });

  test('returns null for a stored-style client ID', () => {
    expect(buildPolicyCimdClient('client_claude_a1b2c3d4', state.platform)).toBeNull();
  });
});

describe('getCimdConfig', () => {
  test('is off whenever the authorization server is off', () => {
    state.platform = {
      oauth: { enabled: { authz: false }, cimd: { enabled: true } }
    };
    expect(getCimdConfig(state.platform).enabled).toBe(false);
  });

  test('falls back to the platform token lifetime', () => {
    expect(getCimdConfig(state.platform).tokenExpirationMinutes).toBe(60);
  });
});

describe('loopback redirect matching (RFC 8252 §7.3)', () => {
  const registered = ['http://localhost/callback', 'http://127.0.0.1/callback'];

  test('accepts the exact registered URI', () => {
    expect(isValidRedirectUri('http://localhost/callback', registered)).toBe(true);
  });

  test('accepts any ephemeral port on the same loopback host and path', () => {
    // This is the whole reason the rule exists: Claude Code declares
    // http://localhost/callback and listens on whatever port it was given.
    expect(isValidRedirectUri('http://localhost:53421/callback', registered)).toBe(true);
    expect(isValidRedirectUri('http://127.0.0.1:8912/callback', registered)).toBe(true);
  });

  test('does not treat localhost and 127.0.0.1 as interchangeable', () => {
    expect(
      isValidRedirectUri('http://127.0.0.1:8912/callback', ['http://localhost/callback'])
    ).toBe(false);
  });

  test('rejects a different path, a different scheme and a non-loopback host', () => {
    expect(isValidRedirectUri('http://localhost:53421/evil', registered)).toBe(false);
    expect(isValidRedirectUri('https://localhost:53421/callback', registered)).toBe(false);
    expect(isValidRedirectUri('http://evil.example:80/callback', registered)).toBe(false);
  });

  test('never relaxes a non-loopback registration', () => {
    const https = ['https://claude.ai/api/mcp/auth_callback'];
    expect(isValidRedirectUri('https://claude.ai:8443/api/mcp/auth_callback', https)).toBe(false);
    expect(isValidRedirectUri('https://claude.ai/api/mcp/auth_callback', https)).toBe(true);
  });

  test('flags a client whose every redirect URI is loopback', () => {
    expect(allRedirectUrisAreLoopback(registered)).toBe(true);
    expect(allRedirectUrisAreLoopback(['https://claude.ai/cb', 'http://localhost/cb'])).toBe(false);
    expect(allRedirectUrisAreLoopback([])).toBe(false);
  });
});

describe('discovery metadata', () => {
  function buildApp() {
    const app = express();
    registerWellKnownRoutes(app);
    return app;
  }

  async function metadata() {
    const res = await request(buildApp()).get('/.well-known/oauth-authorization-server');
    return res.body;
  }

  test('advertises the CIMD flag together with "none" when enabled', async () => {
    const doc = await metadata();
    // Claude requires both before it will use a metadata document.
    expect(doc.client_id_metadata_document_supported).toBe(true);
    expect(doc.token_endpoint_auth_methods_supported).toContain('none');
  });

  test('omits the flag entirely when CIMD is off', async () => {
    setPlatform({ enabled: false });
    const doc = await metadata();
    expect(doc.client_id_metadata_document_supported).toBeUndefined();
  });

  test('omits the flag when the authorization server is off', async () => {
    state.platform = {
      oauth: {
        enabled: { authz: false },
        cimd: { enabled: true, allowedClientHosts: ['claude.ai'] }
      }
    };
    const doc = await metadata();
    expect(doc.client_id_metadata_document_supported).toBeUndefined();
  });

  test('keeps advertising the registration endpoint while DCR is on', async () => {
    setPlatform();
    state.platform.oauth.dcr = { enabled: true };
    const doc = await metadata();
    expect(doc.registration_endpoint).toMatch(/\/api\/oauth\/register$/);
    expect(doc.client_id_metadata_document_supported).toBe(true);
  });
});
