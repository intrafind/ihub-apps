/**
 * Unit tests for the proxy side of server/utils/httpConfig.js.
 *
 * Covers the two failure modes that used to disable proxying silently:
 *   - one uncompilable `urlPatterns` entry aborting evaluation of the rest
 *   - a `noProxy` array throwing inside a swallowed try/catch, so every bypass
 *     stopped working
 * plus the normalization the rest of the platform now relies on (noProxy is
 * always an array; unresolved `${VAR}` placeholders are not proxy URLs).
 *
 * The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';

const state = { platform: {}, env: {}, decrypt: v => v.replace(/^ENC\[|\]$/g, '') };
const warnings = [];

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => state.platform }
}));

jest.unstable_mockModule('../config.js', () => ({
  default: {
    get HTTP_PROXY() {
      return state.env.HTTP_PROXY;
    },
    get HTTPS_PROXY() {
      return state.env.HTTPS_PROXY;
    },
    get NO_PROXY() {
      return state.env.NO_PROXY;
    }
  }
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: {
    info: () => {},
    debug: () => {},
    warn: (message, meta) => warnings.push({ message, meta }),
    error: () => {}
  }
}));

jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: {
    isEncrypted: value =>
      typeof value === 'string' && value.startsWith('ENC[') && value.endsWith(']'),
    decryptString: value => state.decrypt(value),
    encryptString: value => `ENC[${value}]`
  }
}));

const {
  describeProxyRouting,
  getProxyConfig,
  getProxyProvenance,
  isUnresolvedPlaceholder,
  matchesProxyPattern,
  normalizeNoProxy,
  shouldBypassProxy
} = await import('../utils/httpConfig.js');

// The test host itself may run behind a proxy (HTTPS_PROXY in the ambient
// environment), which getProxyConfig() legitimately falls back to. Clear those
// for the duration of the suite so the assertions describe the config, not the
// machine.
const PROXY_ENV_VARS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy'
];
const savedEnv = {};

beforeAll(() => {
  for (const name of PROXY_ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterAll(() => {
  for (const name of PROXY_ENV_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

beforeEach(() => {
  state.platform = {};
  state.env = {};
  state.decrypt = v => v.replace(/^ENC\[|\]$/g, '');
  warnings.length = 0;
  // getProxyConfig logs once per process; reset so tests don't depend on order.
  delete getProxyConfig._logged;
});

describe('normalizeNoProxy', () => {
  test('accepts a comma-separated string', () => {
    expect(normalizeNoProxy('localhost, 127.0.0.1 ,.local')).toEqual([
      'localhost',
      '127.0.0.1',
      '.local'
    ]);
  });

  test('accepts an array, like ssl.domainWhitelist', () => {
    expect(normalizeNoProxy(['LocalHost', '.Local', '', '  '])).toEqual(['localhost', '.local']);
  });

  test('drops unresolved ${VAR} placeholders instead of treating them as hosts', () => {
    expect(normalizeNoProxy('${NO_PROXY}')).toEqual([]);
    expect(normalizeNoProxy(['localhost', '${NO_PROXY}'])).toEqual(['localhost']);
  });

  test('returns an empty list for unusable input rather than throwing', () => {
    expect(normalizeNoProxy(undefined)).toEqual([]);
    expect(normalizeNoProxy(null)).toEqual([]);
    expect(normalizeNoProxy(42)).toEqual([]);
    expect(normalizeNoProxy([null, 7, 'ok'])).toEqual(['ok']);
  });
});

describe('shouldBypassProxy', () => {
  test('bypasses on an exact hostname match', () => {
    expect(shouldBypassProxy('http://localhost:3000/x', 'localhost')).toBe(true);
    expect(shouldBypassProxy('http://other.example.com/x', 'localhost')).toBe(false);
  });

  test('treats .example.com and *.example.com as subdomains only', () => {
    expect(shouldBypassProxy('https://api.example.com/x', '.example.com')).toBe(true);
    expect(shouldBypassProxy('https://example.com/x', '.example.com')).toBe(false);
    expect(shouldBypassProxy('https://api.example.com/x', '*.example.com')).toBe(true);
    // The wildcard must not match a host that merely ends with the same letters.
    expect(shouldBypassProxy('https://notexample.com/x', '*.example.com')).toBe(false);
  });

  // The regression: an array used to hit `.split()` on a non-string, and the
  // resulting TypeError was swallowed — so every bypass silently stopped working.
  test('works with an array, not just a comma-separated string', () => {
    expect(shouldBypassProxy('http://localhost:3000/x', ['localhost', '.local'])).toBe(true);
    expect(shouldBypassProxy('http://a.local/x', ['localhost', '.local'])).toBe(true);
    expect(shouldBypassProxy('http://a.example.com/x', ['localhost', '.local'])).toBe(false);
  });

  test('returns false for an unparseable URL without throwing', () => {
    expect(shouldBypassProxy('not a url', 'localhost')).toBe(false);
  });
});

describe('matchesProxyPattern', () => {
  test('proxies everything when no patterns are configured', () => {
    expect(matchesProxyPattern('https://api.openai.com/v1', [])).toBe(true);
    expect(matchesProxyPattern('https://api.openai.com/v1', undefined)).toBe(true);
  });

  // The regression: the whole loop sat in one try/catch, so a bad entry aborted
  // evaluation of every pattern after it — and a bad *first* entry meant nothing
  // was ever proxied.
  test.each([
    ['first', ['(unclosed', 'api\\.openai\\.com']],
    ['middle', ['nomatch\\.example', '(unclosed', 'api\\.openai\\.com']],
    ['last', ['api\\.openai\\.com', '(unclosed']]
  ])('still evaluates the remaining patterns with a bad entry %s', (_position, patterns) => {
    expect(matchesProxyPattern('https://api.openai.com/v1/models', patterns)).toBe(true);
  });

  // A distinct pattern per assertion: compiled patterns are cached, so each bad
  // entry is reported once rather than on every request.
  test('names the offending pattern in the warning', () => {
    matchesProxyPattern('https://api.openai.com/v1', ['(only-warned-here']);
    const warning = warnings.find(w => w.meta?.pattern === '(only-warned-here');
    expect(warning).toBeDefined();
    expect(warning.message).toMatch(/not a valid regular expression/i);
  });

  test('returns false when nothing matches', () => {
    expect(matchesProxyPattern('https://example.com/', ['api\\.openai\\.com'])).toBe(false);
  });
});

describe('getProxyConfig', () => {
  test('normalizes noProxy to an array whichever form the admin used', () => {
    state.platform = { proxy: { noProxy: 'localhost,.local' } };
    expect(getProxyConfig().noProxy).toEqual(['localhost', '.local']);

    delete getProxyConfig._logged;
    state.platform = { proxy: { noProxy: ['localhost', '.local'] } };
    expect(getProxyConfig().noProxy).toEqual(['localhost', '.local']);
  });

  // configCache leaves ${VAR} verbatim when the variable is undefined, and the
  // literal string is truthy — it must not become the proxy URL.
  test('ignores a ${VAR} placeholder no environment variable resolved', () => {
    state.platform = { proxy: { enabled: true, https: '${HTTPS_PROXY}' } };
    const config = getProxyConfig();
    expect(config.https).toBeUndefined();
    expect(isUnresolvedPlaceholder('${HTTPS_PROXY}')).toBe(true);
  });

  test('falls back to the environment when platform.json has no URL', () => {
    state.env = { HTTPS_PROXY: 'http://env-proxy:8080' };
    expect(getProxyConfig().https).toBe('http://env-proxy:8080');
    expect(getProxyProvenance().https.source).toBe('environment');
  });

  test('decrypts an ENC[...] proxy URL', () => {
    state.platform = { proxy: { https: 'ENC[http://user:pw@proxy:8080]' } };
    expect(getProxyConfig().https).toBe('http://user:pw@proxy:8080');
  });

  test('ignores a proxy URL it cannot decrypt rather than passing ciphertext on', () => {
    state.decrypt = () => {
      throw new Error('key rotated');
    };
    state.platform = { proxy: { https: 'ENC[unreadable-after-rotation]' } };
    expect(getProxyConfig().https).toBeUndefined();
  });

  test('reports provenance per field', () => {
    state.platform = { proxy: { enabled: false, https: 'http://platform-proxy:8080' } };
    state.env = { HTTP_PROXY: 'http://env-proxy:8080' };
    const provenance = getProxyProvenance();
    expect(provenance.enabled.source).toBe('platform');
    expect(provenance.https.source).toBe('platform');
    expect(provenance.http.source).toBe('environment');
    expect(provenance.urlPatterns.source).toBe('default');
  });

  test('surfaces the placeholder that was ignored', () => {
    state.platform = { proxy: { http: '${HTTP_PROXY}' } };
    expect(getProxyProvenance().http.placeholderIgnored).toBe('${HTTP_PROXY}');
  });

  test('an absent enabled flag still means enabled, so env-only setups keep working', () => {
    state.env = { HTTPS_PROXY: 'http://env-proxy:8080' };
    expect(getProxyConfig().enabled).toBe(true);
  });
});

describe('describeProxyRouting', () => {
  const proxied = {
    enabled: true,
    http: 'http://proxy:8080',
    https: 'http://proxy:8080',
    noProxy: [],
    urlPatterns: []
  };

  test('reports a proxied request with the proxy it would use', () => {
    const routing = describeProxyRouting('https://api.openai.com/v1', proxied);
    expect(routing.decision).toBe('proxied');
    expect(routing.proxyUrl).toBe('http://proxy:8080');
  });

  test('reports the proxy being switched off', () => {
    expect(
      describeProxyRouting('https://api.openai.com/v1', { ...proxied, enabled: false }).decision
    ).toBe('disabled');
  });

  test('reports a noProxy bypass', () => {
    const routing = describeProxyRouting('https://api.internal.test/v1', {
      ...proxied,
      noProxy: ['.internal.test']
    });
    expect(routing.decision).toBe('bypassed');
    expect(routing.proxyUrl).toBeUndefined();
  });

  test('reports exclusion by urlPatterns', () => {
    const routing = describeProxyRouting('https://example.com/', {
      ...proxied,
      urlPatterns: ['api\\.openai\\.com']
    });
    expect(routing.decision).toBe('excluded');
  });

  test('reports direct when no proxy is configured for the scheme', () => {
    const routing = describeProxyRouting('https://api.openai.com/v1', {
      ...proxied,
      https: undefined
    });
    expect(routing.decision).toBe('direct');
  });
});
