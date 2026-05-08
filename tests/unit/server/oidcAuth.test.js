import { describe, it, expect } from '@jest/globals';
import { decodeIdTokenClaims } from '../../../server/utils/oidcIdToken.js';

function encodeJwt(header, payload, signature = 'sig') {
  const b64 = obj =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64(header)}.${b64(payload)}.${signature}`;
}

describe('decodeIdTokenClaims', () => {
  it('decodes a base64url-encoded JWT payload', () => {
    const token = encodeJwt(
      { alg: 'RS256', typ: 'JWT' },
      {
        sub: 'user-123',
        email: 'a@b.com',
        groups: ['11111111-1111-1111-1111-111111111111']
      }
    );
    const claims = decodeIdTokenClaims(token);
    expect(claims).toMatchObject({
      sub: 'user-123',
      email: 'a@b.com',
      groups: ['11111111-1111-1111-1111-111111111111']
    });
  });

  it('handles payloads requiring base64 padding', () => {
    const token = encodeJwt({ alg: 'RS256' }, { a: 1 });
    expect(decodeIdTokenClaims(token)).toEqual({ a: 1 });
  });

  it('preserves the Entra overage indicator', () => {
    const token = encodeJwt(
      { alg: 'RS256' },
      {
        sub: 'user-456',
        _claim_names: { groups: 'src1' },
        _claim_sources: {
          src1: {
            endpoint: 'https://graph.microsoft.com/v1.0/users/abc/getMemberObjects'
          }
        }
      }
    );
    expect(decodeIdTokenClaims(token)).toMatchObject({
      _claim_names: { groups: 'src1' }
    });
  });

  it('returns null for falsy or non-string input', () => {
    expect(decodeIdTokenClaims(null)).toBeNull();
    expect(decodeIdTokenClaims(undefined)).toBeNull();
    expect(decodeIdTokenClaims('')).toBeNull();
    expect(decodeIdTokenClaims(123)).toBeNull();
  });

  it('returns null for tokens that are not three dot-separated parts', () => {
    expect(decodeIdTokenClaims('not.a.jwt.token')).toBeNull();
    expect(decodeIdTokenClaims('header.payload')).toBeNull();
  });

  it('returns null when the payload is not valid base64-encoded JSON', () => {
    expect(decodeIdTokenClaims('aaa.!!!.sig')).toBeNull();
    const notJson = Buffer.from('hello world').toString('base64url');
    expect(decodeIdTokenClaims(`aaa.${notJson}.sig`)).toBeNull();
  });
});
