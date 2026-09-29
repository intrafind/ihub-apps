/**
 * Compact JWS (RFC 7515) signed with the installation's C2PA signing key,
 * carrying the certificate chain in `x5c`. Used where C2PA has no embedding
 * for a format yet (PDF, OOXML, HTML, Markdown, JSON exports, the text
 * signpost) and for signed detection and compliance reports.
 *
 * A verifier needs nothing but the token and a trust anchor: the signature
 * is checked against the leaf in `x5c`, and the chain against the anchors.
 *
 * @module services/provenance/signing/jws
 */
import crypto from 'node:crypto';
import { chainsToAnchor, describeCertificate, parsePemCertificates, x509 } from './x509.js';

const JWS_ALGS = {
  es256: { jwa: 'ES256', hash: 'sha256', dsaEncoding: 'ieee-p1363' },
  es384: { jwa: 'ES384', hash: 'sha384', dsaEncoding: 'ieee-p1363' },
  es512: { jwa: 'ES512', hash: 'sha512', dsaEncoding: 'ieee-p1363' },
  ps256: { jwa: 'PS256', hash: 'sha256', padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
  ed25519: { jwa: 'EdDSA', hash: null }
};
const BY_JWA = Object.fromEntries(
  Object.entries(JWS_ALGS).map(([k, v]) => [v.jwa, { ...v, alg: k }])
);

const b64u = buf => Buffer.from(buf).toString('base64url');

/**
 * Canonical JSON (sorted keys) so a payload hashes the same everywhere.
 * @param {any} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter(k => value[k] !== undefined)
    .sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * Sign a JSON payload.
 * @param {Object} payload
 * @param {{keyPem: string, chainPem: string, alg?: string, typ?: string, leafOnly?: boolean}} signer
 * @returns {string} compact JWS
 */
export function signJws(
  payload,
  { keyPem, chainPem, alg = 'es256', typ = 'ihub-provenance+jws', leafOnly = false }
) {
  const spec = JWS_ALGS[alg];
  if (!spec) throw new Error(`Unsupported signing algorithm ${alg}`);
  const certs = parsePemCertificates(chainPem);
  if (!certs.length) throw new Error('No signing certificate');
  // `leafOnly` keeps small carriers (the text signpost) small: the verifier
  // holds the root as its trust anchor anyway.
  const embedded = leafOnly ? certs.slice(0, 1) : certs;
  const header = {
    alg: spec.jwa,
    typ,
    x5c: embedded.map(c => Buffer.from(c.rawData).toString('base64')),
    kid: describeCertificate(certs[0]).fingerprint.slice(0, 32)
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(canonicalJson(payload))}`;
  const key = crypto.createPrivateKey(keyPem);
  const opts = { key };
  if (spec.dsaEncoding) opts.dsaEncoding = spec.dsaEncoding;
  if (spec.padding) opts.padding = spec.padding;
  const signature = crypto.sign(spec.hash, Buffer.from(signingInput), opts);
  return `${signingInput}.${b64u(signature)}`;
}

/**
 * Decode without verifying.
 * @param {string} token
 * @returns {{header: Object, payload: Object}|null}
 */
export function decodeJws(token) {
  if (typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    };
  } catch {
    return null;
  }
}

/**
 * Verify a compact JWS: signature against the `x5c` leaf, chain against the
 * trust anchors.
 *
 * @param {string} token
 * @param {{trustAnchors?: string[]}} [opts] - PEM trust anchors
 * @returns {Promise<{valid: boolean, trusted: boolean, payload: Object|null, header: Object|null, signer: Object|null, errors: string[]}>}
 */
export async function verifyJws(token, { trustAnchors = [] } = {}) {
  const errors = [];
  const decoded = decodeJws(token);
  if (!decoded) {
    return {
      valid: false,
      trusted: false,
      payload: null,
      header: null,
      signer: null,
      errors: ['Not a JWS']
    };
  }
  const { header, payload } = decoded;
  const spec = BY_JWA[header.alg];
  if (!spec) errors.push(`Unsupported algorithm ${header.alg}`);
  let certs = [];
  try {
    certs = (header.x5c || []).map(der => new x509.X509Certificate(Buffer.from(der, 'base64')));
  } catch {
    errors.push('Certificate chain in the signature is unreadable');
  }
  if (!certs.length) errors.push('Signature carries no certificate');
  let valid = false;
  if (spec && certs.length) {
    const [h, p, s] = token.trim().split('.');
    try {
      const key = crypto.createPublicKey(certs[0].toString('pem'));
      const opts = { key };
      if (spec.dsaEncoding) opts.dsaEncoding = spec.dsaEncoding;
      if (spec.padding) opts.padding = spec.padding;
      valid = crypto.verify(spec.hash, Buffer.from(`${h}.${p}`), opts, Buffer.from(s, 'base64url'));
      if (!valid) errors.push('Signature does not match');
    } catch (error) {
      errors.push(`Signature check failed: ${error.message}`);
    }
  }
  let trusted = false;
  if (valid) {
    const anchors = trustAnchors.flatMap(pem => {
      try {
        return parsePemCertificates(pem);
      } catch {
        return [];
      }
    });
    const result = await chainsToAnchor(certs, anchors);
    trusted = result.trusted;
    if (!trusted) errors.push(`Signer is not trusted (${result.reason})`);
  }
  return {
    valid,
    trusted,
    payload,
    header,
    signer: certs.length ? describeCertificate(certs[0]) : null,
    errors
  };
}
