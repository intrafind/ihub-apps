import crypto from 'crypto';

/**
 * PKCE (Proof Key for Code Exchange) utilities – RFC 7636.
 *
 * Only the S256 method is implemented. The `plain` method provides no
 * real security benefit over a confidential client and is therefore
 * intentionally omitted to prevent misconfigured clients from bypassing
 * the protection PKCE is meant to provide.
 *
 * Typical flow:
 *   1. Client generates a random code verifier via `generateCodeVerifier()`.
 *   2. Client computes the code challenge via `generateCodeChallenge(verifier)`.
 *   3. Client sends the challenge in the authorization request.
 *   4. Server stores the challenge alongside the authorization code.
 *   5. On the token request the client sends the original verifier.
 *   6. Server calls `verifyCodeChallenge(verifier, storedChallenge, 'S256')`.
 *
 * @module pkceUtils
 */

/**
 * Verify a PKCE code verifier against a previously stored code challenge.
 *
 * Only the S256 method is accepted. The comparison is performed with
 * `crypto.timingSafeEqual` to prevent timing-based side-channel attacks.
 *
 * @param {string} codeVerifier - The plain-text verifier sent in the token request.
 * @param {string} codeChallenge - The BASE64URL-encoded challenge stored during authorization.
 * @param {string} codeChallengeMethod - The method used to derive the challenge; must be 'S256'.
 * @returns {boolean} True when the verifier correctly produces the stored challenge.
 *
 * @example
 * const verifier = generateCodeVerifier();
 * const challenge = generateCodeChallenge(verifier);
 * verifyCodeChallenge(verifier, challenge, 'S256'); // true
 * verifyCodeChallenge('wrongvalue', challenge, 'S256'); // false
 */
export function verifyCodeChallenge(codeVerifier, codeChallenge, codeChallengeMethod) {
  if (!codeVerifier || !codeChallenge) {
    return false;
  }

  if (codeChallengeMethod !== 'S256') {
    // 'plain' is insecure; reject any unknown method as well.
    return false;
  }

  // S256: BASE64URL(SHA256(ASCII(code_verifier)))
  const hash = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');

  // timingSafeEqual requires both buffers to have the same length.
  // If they differ the challenge cannot match, so return false immediately.
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'utf8'), Buffer.from(codeChallenge, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Derive a PKCE S256 code challenge from a code verifier.
 *
 * Computes BASE64URL(SHA256(ASCII(codeVerifier))) as defined in RFC 7636
 * section 4.2. Useful for generating test fixtures and in client-side
 * code that needs to produce a challenge before the authorization request.
 *
 * @param {string} codeVerifier - The code verifier (43–128 URL-safe characters).
 * @returns {string} BASE64URL-encoded SHA-256 hash of the verifier.
 */
export function generateCodeChallenge(codeVerifier) {
  return crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

/**
 * Generate a cryptographically random PKCE code verifier.
 *
 * Produces a 43-character BASE64URL string (32 bytes of entropy), which
 * satisfies the RFC 7636 requirement of 43–128 characters drawn from the
 * unreserved character set [A-Z / a-z / 0-9 / "-" / "." / "_" / "~"].
 *
 * @returns {string} A random, URL-safe code verifier string.
 */
export function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}
