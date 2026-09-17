import {
  validateCredential,
  validateCredentialsFile,
  SECRET_FIELDS_BY_TYPE
} from '../../validators/credentialSchema.js';

/**
 * Unit tests for the central credential store schema. Covers each credential
 * type's valid/invalid shapes, discriminated-union rejection of unknown types,
 * and the whole-file validator.
 */

describe('validateCredential — valid profiles per type', () => {
  const valid = {
    secret: { id: 'ntlm', type: 'secret', value: 'pw' },
    bearer: { id: 'mcp_tok', type: 'bearer', token: 'tok' },
    basic: { id: 'mcp_basic', type: 'basic', username: 'u', password: 'pw' },
    oauth2: {
      id: 'jira',
      type: 'oauth2',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid',
      clientSecret: 'csecret'
    },
    apiKeyHeader: { id: 'api_h', type: 'apiKeyHeader', headerName: 'X-Api-Key', key: 'abc' },
    apiKeyQuery: { id: 'api_q', type: 'apiKeyQuery', paramName: 'api_key', key: 'xyz' }
  };

  it.each(Object.entries(valid))('accepts a valid %s profile', (_type, profile) => {
    const result = validateCredential(profile);
    expect(result.success).toBe(true);
    expect(result.data.id).toBe(profile.id);
  });

  it('applies the default grantType for oauth2', () => {
    const result = validateCredential(valid.oauth2);
    expect(result.success).toBe(true);
    expect(result.data.grantType).toBe('client_credentials');
  });

  it('accepts optional localized name/description', () => {
    const result = validateCredential({
      ...valid.secret,
      name: { en: 'NTLM Password', de: 'NTLM Passwort' },
      description: 'Plain string description'
    });
    expect(result.success).toBe(true);
  });
});

describe('validateCredential — invalid profiles', () => {
  it('rejects an unknown discriminator type', () => {
    const result = validateCredential({ id: 'x', type: 'totally-unknown', value: 'v' });
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing secret-bearing field per type', () => {
    expect(validateCredential({ id: 'x', type: 'secret' }).success).toBe(false);
    expect(validateCredential({ id: 'x', type: 'bearer' }).success).toBe(false);
    expect(validateCredential({ id: 'x', type: 'basic', username: 'u' }).success).toBe(false);
    expect(
      validateCredential({ id: 'x', type: 'oauth2', tokenUrl: 'https://e/token', clientId: 'c' })
        .success
    ).toBe(false);
  });

  it('rejects an empty secret value', () => {
    expect(validateCredential({ id: 'x', type: 'secret', value: '' }).success).toBe(false);
  });

  it('rejects an invalid id (illegal characters)', () => {
    expect(validateCredential({ id: 'bad id!', type: 'secret', value: 'v' }).success).toBe(false);
  });

  it('rejects a non-URL oauth2 tokenUrl', () => {
    const result = validateCredential({
      id: 'x',
      type: 'oauth2',
      tokenUrl: 'not-a-url',
      clientId: 'c',
      clientSecret: 's'
    });
    expect(result.success).toBe(false);
  });
});

describe('validateCredentialsFile', () => {
  it('accepts a full credentials file with multiple profiles', () => {
    const file = {
      credentials: {
        jira: {
          id: 'jira',
          type: 'oauth2',
          tokenUrl: 'https://auth.example.com/token',
          clientId: 'cid',
          clientSecret: 'csecret'
        },
        ntlm: { id: 'ntlm', type: 'secret', value: 'pw' }
      }
    };
    const result = validateCredentialsFile(file);
    expect(result.success).toBe(true);
    expect(Object.keys(result.data.credentials)).toEqual(['jira', 'ntlm']);
  });

  it('defaults to an empty credentials map when omitted', () => {
    const result = validateCredentialsFile({});
    expect(result.success).toBe(true);
    expect(result.data.credentials).toEqual({});
  });

  it('rejects a file containing an invalid profile', () => {
    const result = validateCredentialsFile({
      credentials: { bad: { id: 'bad', type: 'secret' } }
    });
    expect(result.success).toBe(false);
  });
});

describe('SECRET_FIELDS_BY_TYPE', () => {
  it('declares the primary secret field for every credential type', () => {
    expect(SECRET_FIELDS_BY_TYPE.secret[0]).toBe('value');
    expect(SECRET_FIELDS_BY_TYPE.bearer[0]).toBe('token');
    expect(SECRET_FIELDS_BY_TYPE.basic[0]).toBe('password');
    expect(SECRET_FIELDS_BY_TYPE.oauth2[0]).toBe('clientSecret');
    expect(SECRET_FIELDS_BY_TYPE.apiKeyHeader[0]).toBe('key');
    expect(SECRET_FIELDS_BY_TYPE.apiKeyQuery[0]).toBe('key');
  });
});
