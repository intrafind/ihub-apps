import { jest } from '@jest/globals';

/**
 * Unit tests for CredentialService — the single access point for the central
 * credential store (`contents/config/credentials.json`).
 *
 * configCache is mocked so the test controls exactly which decrypted profiles
 * the service "sees" without touching disk or the encryption key. The mock's
 * `getCredentials()` returns the same shape the real cache returns: the
 * already-decrypted credentials map ({ credentials: { id: profile } }).
 */

// Mutable store the mocked configCache reads from. Each test mutates this in
// place; CredentialService.list() pulls it fresh on every call.
const store = { credentials: {} };

jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getCredentials: () => store
  }
}));

// logger is imported by CredentialService for dangling-ref errors — stub it so
// the test output stays clean.
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {}
  }
}));

const { default: credentialService } = await import('../../services/CredentialService.js');

/** Seed the mocked store with a fresh set of profiles for a test. */
function setProfiles(profiles) {
  store.credentials = profiles;
}

beforeEach(() => {
  setProfiles({});
});

describe('CredentialService.resolve', () => {
  it('returns the decrypted profile for a known ref', () => {
    const profile = { id: 'jira', type: 'secret', value: 's3cr3t' };
    setProfiles({ jira: profile });

    expect(credentialService.resolve('jira')).toBe(profile);
  });

  it('throws on a dangling ref', () => {
    setProfiles({ jira: { id: 'jira', type: 'secret', value: 's3cr3t' } });

    expect(() => credentialService.resolve('does-not-exist')).toThrow(
      /Unknown credentialRef: "does-not-exist"/
    );
  });

  it('throws when ref is empty or not a string', () => {
    expect(() => credentialService.resolve('')).toThrow(/non-empty credentialRef/);
    expect(() => credentialService.resolve(undefined)).toThrow(/non-empty credentialRef/);
    expect(() => credentialService.resolve(null)).toThrow(/non-empty credentialRef/);
  });
});

describe('CredentialService.resolveSecret', () => {
  // One representative profile per credential type, mapped to the secret value
  // that SECRET_FIELDS_BY_TYPE designates as primary.
  const cases = [
    { type: 'secret', profile: { value: 'opaque' }, expected: 'opaque' },
    { type: 'bearer', profile: { token: 'tok' }, expected: 'tok' },
    { type: 'basic', profile: { username: 'u', password: 'pw' }, expected: 'pw' },
    {
      type: 'oauth2',
      profile: {
        tokenUrl: 'https://example.com/token',
        clientId: 'cid',
        clientSecret: 'csecret'
      },
      expected: 'csecret'
    },
    { type: 'apiKeyHeader', profile: { headerName: 'X-Key', key: 'abc' }, expected: 'abc' },
    { type: 'apiKeyQuery', profile: { paramName: 'key', key: 'xyz' }, expected: 'xyz' }
  ];

  it.each(cases)('returns the primary secret for a $type profile', ({ type, profile, expected }) => {
    setProfiles({ cred: { id: 'cred', type, ...profile } });
    expect(credentialService.resolveSecret('cred')).toBe(expected);
  });

  it('throws on a dangling ref', () => {
    expect(() => credentialService.resolveSecret('missing')).toThrow(/Unknown credentialRef/);
  });
});

describe('CredentialService.tryResolve / tryResolveSecret', () => {
  it('tryResolve returns the profile when present', () => {
    const profile = { id: 'ntlm', type: 'secret', value: 'pw' };
    setProfiles({ ntlm: profile });
    expect(credentialService.tryResolve('ntlm')).toBe(profile);
  });

  it('tryResolve returns null for missing or invalid refs', () => {
    expect(credentialService.tryResolve('missing')).toBeNull();
    expect(credentialService.tryResolve('')).toBeNull();
    expect(credentialService.tryResolve(undefined)).toBeNull();
  });

  it('tryResolveSecret returns the secret when present', () => {
    setProfiles({ ntlm: { id: 'ntlm', type: 'secret', value: 'pw' } });
    expect(credentialService.tryResolveSecret('ntlm')).toBe('pw');
  });

  it('tryResolveSecret returns undefined for missing or invalid refs', () => {
    expect(credentialService.tryResolveSecret('missing')).toBeUndefined();
    expect(credentialService.tryResolveSecret('')).toBeUndefined();
    expect(credentialService.tryResolveSecret(undefined)).toBeUndefined();
  });
});

describe('CredentialService.has', () => {
  it('reflects presence of a ref in the store', () => {
    setProfiles({ jira: { id: 'jira', type: 'secret', value: 's' } });
    expect(credentialService.has('jira')).toBe(true);
    expect(credentialService.has('nope')).toBe(false);
    expect(credentialService.has('')).toBe(false);
  });
});

describe('CredentialService.list', () => {
  it('returns the raw credentials map', () => {
    const profiles = { a: { id: 'a', type: 'secret', value: '1' } };
    setProfiles(profiles);
    expect(credentialService.list()).toBe(profiles);
  });

  it('returns an empty object when the store is empty', () => {
    store.credentials = undefined;
    expect(credentialService.list()).toEqual({});
  });
});
