import { describe, it, expect } from '@jest/globals';
import {
  validateRedirectUri,
  validateRegistrationRequest,
  DCR_DEFAULT_ALLOWED_SCOPES
} from '../utils/dcrValidation.js';

describe('DCR redirect URI validation', () => {
  it('accepts https URIs', () => {
    expect(validateRedirectUri('https://claude.ai/api/mcp/auth_callback').ok).toBe(true);
  });

  it('accepts loopback http URIs', () => {
    expect(validateRedirectUri('http://localhost:3334/callback').ok).toBe(true);
    expect(validateRedirectUri('http://127.0.0.1:8080/cb').ok).toBe(true);
    expect(validateRedirectUri('http://[::1]:8080/cb').ok).toBe(true);
  });

  it('rejects non-loopback http URIs', () => {
    expect(validateRedirectUri('http://evil.example.com/cb').ok).toBe(false);
  });

  it('accepts private-use native app schemes', () => {
    expect(validateRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback').ok).toBe(true);
  });

  it('rejects dangerous schemes', () => {
    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'vbscript:x',
      'about:blank'
    ]) {
      expect(validateRedirectUri(uri).ok).toBe(false);
    }
  });

  it('rejects URIs with fragments', () => {
    expect(validateRedirectUri('https://example.com/cb#frag').ok).toBe(false);
  });

  it('rejects non-string and malformed values', () => {
    expect(validateRedirectUri(null).ok).toBe(false);
    expect(validateRedirectUri('').ok).toBe(false);
    expect(validateRedirectUri('not a uri').ok).toBe(false);
    expect(validateRedirectUri('x'.repeat(2001)).ok).toBe(false);
  });
});

describe('DCR registration request validation', () => {
  const minimal = { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] };

  it('accepts a minimal Claude-style registration with sane defaults', () => {
    const result = validateRegistrationRequest(minimal);
    expect(result.ok).toBe(true);
    expect(result.clientMetadata.name).toBe('MCP Client');
    expect(result.clientMetadata.grantTypes).toEqual(['authorization_code', 'refresh_token']);
    expect(result.clientMetadata.tokenEndpointAuthMethod).toBe('none');
    expect(result.clientMetadata.scopes).toEqual([...DCR_DEFAULT_ALLOWED_SCOPES]);
  });

  it('requires redirect_uris', () => {
    expect(validateRegistrationRequest({}).ok).toBe(false);
    expect(validateRegistrationRequest({ redirect_uris: [] }).ok).toBe(false);
    const tooMany = { redirect_uris: Array(11).fill('https://example.com/cb') };
    expect(validateRegistrationRequest(tooMany).ok).toBe(false);
  });

  it('rejects non-object bodies', () => {
    expect(validateRegistrationRequest(null).ok).toBe(false);
    expect(validateRegistrationRequest([]).ok).toBe(false);
    expect(validateRegistrationRequest('x').ok).toBe(false);
  });

  it('rejects the client_credentials grant', () => {
    const result = validateRegistrationRequest({
      ...minimal,
      grant_types: ['client_credentials']
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_client_metadata');
  });

  it('requires authorization_code in grant_types', () => {
    const result = validateRegistrationRequest({ ...minimal, grant_types: ['refresh_token'] });
    expect(result.ok).toBe(false);
  });

  it('rejects unsupported response types', () => {
    expect(validateRegistrationRequest({ ...minimal, response_types: ['token'] }).ok).toBe(false);
    expect(validateRegistrationRequest({ ...minimal, response_types: ['code'] }).ok).toBe(true);
  });

  it('rejects unsupported token endpoint auth methods', () => {
    expect(
      validateRegistrationRequest({ ...minimal, token_endpoint_auth_method: 'private_key_jwt' }).ok
    ).toBe(false);
    const confidential = validateRegistrationRequest({
      ...minimal,
      token_endpoint_auth_method: 'client_secret_post'
    });
    expect(confidential.ok).toBe(true);
    expect(confidential.clientMetadata.tokenEndpointAuthMethod).toBe('client_secret_post');
  });

  it('filters requested scopes against the allowlist', () => {
    const result = validateRegistrationRequest({
      ...minimal,
      scope: 'openid mcp:tools:call admin:everything'
    });
    expect(result.ok).toBe(true);
    expect(result.clientMetadata.scopes).toEqual(['openid', 'mcp:tools:call']);
  });

  it('rejects a scope request with no grantable scopes', () => {
    const result = validateRegistrationRequest({ ...minimal, scope: 'admin:everything' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_client_metadata');
  });

  it('honors a custom scope allowlist', () => {
    const result = validateRegistrationRequest(
      { ...minimal, scope: 'openid mcp:tools:call' },
      { allowedScopes: ['openid'] }
    );
    expect(result.ok).toBe(true);
    expect(result.clientMetadata.scopes).toEqual(['openid']);
  });

  it('sanitizes the client name', () => {
    const result = validateRegistrationRequest({
      ...minimal,
      client_name: '  Claude\x00\x1f Desktop  '
    });
    expect(result.ok).toBe(true);
    expect(result.clientMetadata.name).toBe('Claude Desktop');
  });
});
