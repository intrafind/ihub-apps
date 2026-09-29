/**
 * Rules of the EU AI Act Certificates tab, kept out of the component:
 * expiry severity, which actions a certificate allows, and validation /
 * request bodies for installing a custom certificate or completing a CSR.
 *
 * Certificate shape (`GET /admin/ai-transparency/certificates`):
 * `{ id, source: 'auto'|'custom'|'csr', status: 'active'|'detect-only'|'pending',
 *    subject, issuer, serialNumber, notBefore, notAfter, expiresInDays, expired,
 *    fingerprint, createdAt, createdBy, activatedAt, retiredAt, chain: [...], csrPem? }`
 *
 * @module features/admin/components/euAiAct/certificatesModel
 */

/** Days before expiry from which the tab warns (matches the start-page warning). */
export const EXPIRY_WARNING_DAYS = 30;

export const PEM_CERTIFICATE_MARKER = '-----BEGIN CERTIFICATE-----';
export const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;

/** Custom certificate upload modes. */
export const CUSTOM_CERTIFICATE_MODES = Object.freeze(['pem', 'pkcs12']);

/**
 * Severity of a certificate's remaining validity.
 *
 * @param {{ expired?: boolean, expiresInDays?: number|null }} certificate
 * @returns {'expired'|'expiring'|'ok'|'unknown'}
 */
export function getExpiryState(certificate) {
  if (!certificate) return 'unknown';
  if (certificate.expired) return 'expired';
  const days = certificate.expiresInDays;
  if (typeof days !== 'number') return 'unknown';
  if (days < 0) return 'expired';
  if (days < EXPIRY_WARNING_DAYS) return 'expiring';
  return 'ok';
}

/**
 * A detect-only certificate that has not expired can be made active again.
 * @param {{ status: string, expired?: boolean }} certificate
 * @returns {boolean}
 */
export function canRollback(certificate) {
  return certificate?.status === 'detect-only' && !certificate.expired;
}

/**
 * Only a pending CSR can be removed; active and detect-only certificates stay
 * so that older content remains verifiable.
 * @param {{ status: string }} certificate
 * @returns {boolean}
 */
export function canRemove(certificate) {
  return certificate?.status === 'pending';
}

/**
 * @typedef {Object} CustomCertificateForm
 * @property {'pem'|'pkcs12'} mode
 * @property {string} chainPem - Leaf first, then intermediates (PEM mode)
 * @property {string} keyPem - Private key (PEM mode)
 * @property {string} pkcs12Base64 - File content as base64 (PKCS#12 mode)
 * @property {string} pkcs12FileName - Only for display
 * @property {string} password - PKCS#12 password (may be empty)
 */

/** Empty form state for the custom-certificate dialog. */
export const EMPTY_CUSTOM_CERTIFICATE_FORM = Object.freeze({
  mode: 'pem',
  chainPem: '',
  keyPem: '',
  pkcs12Base64: '',
  pkcs12FileName: '',
  password: ''
});

/**
 * Client-side checks before uploading, so obvious mistakes (key pasted into
 * the chain field, no file) are caught next to the field. The server still
 * validates chain, EKU, key match and expiry and runs a test signature.
 *
 * @param {CustomCertificateForm} form
 * @returns {Object<string, 'required'|'pemCertificate'|'pemKey'>} field → error code
 */
export function validateCustomCertificateForm(form) {
  const errors = {};
  if (form.mode === 'pkcs12') {
    if (!form.pkcs12Base64) errors.pkcs12 = 'required';
    return errors;
  }
  if (!form.chainPem.trim()) errors.chainPem = 'required';
  else if (!form.chainPem.includes(PEM_CERTIFICATE_MARKER)) errors.chainPem = 'pemCertificate';
  if (!form.keyPem.trim()) errors.keyPem = 'required';
  else if (!PEM_PRIVATE_KEY_PATTERN.test(form.keyPem)) errors.keyPem = 'pemKey';
  return errors;
}

/**
 * Body for `POST /admin/ai-transparency/certificates/custom`.
 *
 * @param {CustomCertificateForm} form
 * @returns {{ chainPem: string, keyPem: string } | { pkcs12Base64: string, password: string }}
 */
export function buildCustomCertificateBody(form) {
  if (form.mode === 'pkcs12') {
    return { pkcs12Base64: form.pkcs12Base64, password: form.password || '' };
  }
  return { chainPem: form.chainPem.trim(), keyPem: form.keyPem.trim() };
}

/**
 * Validate the issued certificate pasted for a pending CSR.
 * @param {string} chainPem
 * @returns {'required'|'pemCertificate'|null}
 */
export function validateIssuedCertificate(chainPem) {
  if (!chainPem || !chainPem.trim()) return 'required';
  if (!chainPem.includes(PEM_CERTIFICATE_MARKER)) return 'pemCertificate';
  return null;
}

/**
 * Body for `POST /admin/ai-transparency/certificates/csr`; empty values are
 * left out so the server falls back to the signing/provider settings.
 *
 * @param {{ commonName?: string, organization?: string, email?: string }} form
 * @returns {Object}
 */
export function buildCsrBody(form) {
  const body = {};
  for (const key of ['commonName', 'organization', 'email']) {
    const value = String(form?.[key] ?? '').trim();
    if (value) body[key] = value;
  }
  return body;
}

/** Loose e-mail check for the CSR form (the server validates strictly). */
export function isPlausibleEmail(value) {
  const text = String(value ?? '').trim();
  return text === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/**
 * File name for a downloaded CSR, derived from the certificate id.
 * @param {{ id: string }} certificate
 * @returns {string}
 */
export function csrFileName(certificate) {
  const safe = String(certificate?.id || 'request').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `ihub-signing-${safe}.csr`;
}
