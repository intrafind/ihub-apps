// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { X509Certificate, createPrivateKey } from 'node:crypto';
import configStore from '../config/ConfigStore.js';
import { CERTIFICATE_NAME_PATTERN } from '../../validators/peopleDirectorySchema.js';

/**
 * The certificate store: trust anchors in `contents/config/certs/<name>.pem`.
 *
 * A directory whose CA is in no public trust store (a corporate PKI, the
 * German Verwaltungs-PKI behind x500.bund.de) names its anchors in `tlsCa`;
 * only those anchors are then trusted for that directory, and verification
 * stays on. Nothing here is trusted globally, and iHub never adds a root by
 * itself: an anchor is an admin decision, checked against a fingerprint its
 * publisher states.
 *
 * It holds public certificates only. Anything else — a private key above all —
 * is refused on upload.
 */

export const CERT_DIR = 'config/certs';
const PEM_EXTENSION = '.pem';
/** Certificates expiring within this many days get a warning. */
export const EXPIRY_WARNING_DAYS = 90;
const MAX_UPLOAD_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export class CertificateInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CertificateInputError';
  }
}

/**
 * The store path of a certificate, after checking its name: names are
 * `^[a-z0-9-]+$`, so a name can never leave the store directory.
 * @param {string} name
 * @returns {string}
 */
function certificatePath(name) {
  if (typeof name !== 'string' || !CERTIFICATE_NAME_PATTERN.test(name)) {
    throw new CertificateInputError(
      'A certificate name uses 1 to 64 lower-case letters, digits and "-".'
    );
  }
  return `${CERT_DIR}/${name}${PEM_EXTENSION}`;
}

/**
 * Parse uploaded content into exactly one X.509 certificate.
 *
 * @param {string} content - PEM text, or base64-encoded DER
 * @param {'pem'|'base64'} [encoding] - Detected from the content when omitted
 * @returns {{x509: X509Certificate, pem: string}}
 * @throws {CertificateInputError}
 */
export function parseCertificateInput(content, encoding) {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new CertificateInputError('No certificate content was sent.');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_UPLOAD_BYTES) {
    throw new CertificateInputError('The file is too large to be a certificate.');
  }

  if (encoding === 'pem' || content.includes('-----BEGIN')) {
    const labels = [...content.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----/g)].map(match => match[1]);
    if (labels.some(label => label.includes('PRIVATE KEY'))) {
      throw new CertificateInputError(
        'This file contains a private key. The store takes public certificates only; never upload a private key.'
      );
    }
    if (labels.length === 0) {
      throw new CertificateInputError('No PEM block was found.');
    }
    const other = labels.find(label => label !== 'CERTIFICATE');
    if (other) {
      throw new CertificateInputError(
        `Only certificates are accepted; this file contains a "${other}" block.`
      );
    }
    if (labels.length > 1) {
      throw new CertificateInputError(
        'The file contains more than one certificate. Upload each trust anchor on its own.'
      );
    }
    let x509;
    try {
      x509 = new X509Certificate(content);
    } catch {
      throw new CertificateInputError('The PEM block is not a valid X.509 certificate.');
    }
    return { x509, pem: x509.toString() };
  }

  const der = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  if (der.length === 0) {
    throw new CertificateInputError('The content is neither PEM nor base64-encoded DER.');
  }
  try {
    const x509 = new X509Certificate(der);
    return { x509, pem: x509.toString() };
  } catch {
    if (isDerPrivateKey(der)) {
      throw new CertificateInputError(
        'This file contains a private key. The store takes public certificates only; never upload a private key.'
      );
    }
    throw new CertificateInputError('The file is not an X.509 certificate (PEM or DER).');
  }
}

/**
 * Whether DER bytes are a private key, so the refusal can say so.
 * @param {Buffer} der
 * @returns {boolean}
 */
function isDerPrivateKey(der) {
  for (const type of ['pkcs8', 'pkcs1', 'sec1']) {
    try {
      createPrivateKey({ key: der, format: 'der', type });
      return true;
    } catch {
      // not this encoding
    }
  }
  return false;
}

/**
 * The CN of an X.509 distinguished name as Node prints it (one `key=value`
 * per line).
 * @param {string} name
 * @returns {string|null}
 */
function commonName(name) {
  const line = String(name || '')
    .split('\n')
    .find(entry => entry.startsWith('CN='));
  return line ? line.slice(3) : null;
}

/**
 * What the admin page shows of a certificate.
 * @param {X509Certificate} x509
 * @param {number} [now]
 * @returns {Object}
 */
export function describeCertificate(x509, now = Date.now()) {
  const validTo = new Date(x509.validTo);
  const daysUntilExpiry = Math.floor((validTo.getTime() - now) / DAY_MS);
  return {
    subject: x509.subject,
    subjectCN: commonName(x509.subject),
    issuer: x509.issuer,
    issuerCN: commonName(x509.issuer),
    validFrom: x509.validFrom,
    validTo: x509.validTo,
    fingerprint256: x509.fingerprint256,
    serialNumber: x509.serialNumber,
    ca: x509.ca,
    selfSigned: x509.subject === x509.issuer && x509.checkIssued(x509),
    daysUntilExpiry,
    expired: daysUntilExpiry < 0,
    expiringSoon: daysUntilExpiry >= 0 && daysUntilExpiry <= EXPIRY_WARNING_DAYS
  };
}

/**
 * Names of the certificates in the store.
 * @returns {Promise<string[]>}
 */
export async function listCertificateNames() {
  const names = await configStore.listTextFiles(CERT_DIR, PEM_EXTENSION);
  return names.filter(name => CERTIFICATE_NAME_PATTERN.test(name));
}

/**
 * Read one certificate as PEM.
 * @param {string} name
 * @returns {Promise<string|null>} PEM text, or null when the store has no such certificate
 * @throws {CertificateInputError} For a name that is not a certificate name
 */
export async function readCertificatePem(name) {
  return configStore.readText(certificatePath(name));
}

/**
 * Every certificate in the store, described.
 * @returns {Promise<Array<Object>>}
 */
export async function listCertificates() {
  const certificates = [];
  for (const name of await listCertificateNames()) {
    const pem = await readCertificatePem(name);
    if (!pem) continue;
    try {
      certificates.push({ name, ...describeCertificate(new X509Certificate(pem)) });
    } catch {
      certificates.push({ name, invalid: true });
    }
  }
  return certificates;
}

/**
 * The PEM of each named trust anchor, for `tlsOptions.ca`. A missing or
 * unreadable anchor fails the connection instead of quietly trusting less.
 *
 * @param {string[]} names - `tlsCa` of a directory
 * @returns {Promise<string[]>}
 * @throws {Error} With `code: 'trust_anchor_missing'`
 */
export async function loadTrustAnchors(names = []) {
  const anchors = [];
  for (const name of names) {
    let pem = null;
    try {
      pem = await readCertificatePem(name);
      if (pem) new X509Certificate(pem);
    } catch {
      pem = null;
    }
    if (!pem) {
      const error = new Error(
        `Trust anchor "${name}" is not in the certificate store (contents/${CERT_DIR}/${name}${PEM_EXTENSION}) or is not a valid certificate.`
      );
      error.code = 'trust_anchor_missing';
      throw error;
    }
    anchors.push(pem);
  }
  return anchors;
}

/**
 * Add a certificate to the store.
 * @param {string} name
 * @param {string} content
 * @param {'pem'|'base64'} [encoding]
 * @returns {Promise<Object>} The stored certificate, described
 * @throws {CertificateInputError} Invalid name or content; `code: 'exists'` when taken
 */
export async function saveCertificate(name, content, encoding) {
  const relPath = certificatePath(name);
  const { x509, pem } = parseCertificateInput(content, encoding);
  if (await configStore.readText(relPath)) {
    const error = new CertificateInputError(`A certificate named "${name}" already exists.`);
    error.code = 'exists';
    throw error;
  }
  await configStore.writeText(relPath, pem);
  return { name, ...describeCertificate(x509) };
}

/**
 * Remove a certificate from the store.
 * @param {string} name
 * @returns {Promise<boolean>} False when there was none
 */
export async function deleteCertificate(name) {
  return configStore.remove(certificatePath(name));
}
