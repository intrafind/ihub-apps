/**
 * Decode the JWT payload of an OIDC ID token without verifying its signature.
 *
 * Signature verification is intentionally skipped: the token came directly from
 * the IdP's token endpoint over TLS to passport-oauth2 in this same process, so
 * its claims are used here only as a side-channel alongside userinfo (e.g., to
 * pick up a `groups` claim that some IdPs put only in the ID token).
 *
 * @param {string} idToken - The serialized JWT.
 * @returns {object|null} The decoded payload, or null if the token is missing,
 *   malformed, or unparseable.
 */
export function decodeIdTokenClaims(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}
