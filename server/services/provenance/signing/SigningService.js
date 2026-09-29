/**
 * The installation's signing identity (concept §8.5, issue #2568).
 *
 * - **auto**: on first start iHub generates an installation root CA and a
 *   C2PA leaf certificate. The root key signs the leaf and is discarded;
 *   rotation issues a new root.
 * - **custom**: an admin installs a PEM chain + key or a PKCS#12 file from
 *   their PKI or a C2PA Trust-List CA.
 * - **csr**: iHub generates the key and a CSR, so the key never leaves the
 *   installation; the admin uploads the issued certificate.
 *
 * Every switch validates the chain, EKU, key match and expiry and runs a test
 * signature with a verify round-trip first. The previous certificate stays
 * as `detect-only`: it no longer signs, but content signed with it still
 * verifies, and an admin can switch back to it (rollback).
 *
 * @module services/provenance/signing/SigningService
 */
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import keyStore, { openSecret, sealSecret } from '../keyStore.js';
import { getAiTransparencyConfig } from '../config.js';
import {
  describeCertificate,
  generateCsr,
  generateInstallationCertificate,
  orderChain,
  parsePemCertificates,
  parsePkcs12,
  validateSigningBundle
} from './x509.js';
import { signJws, verifyJws } from './jws.js';
import { isC2paAvailable, readAsset, signAsset } from './c2pa.js';
import { getAppVersion } from '../../../utils/versionHelper.js';
import logger from '../../../utils/logger.js';

const COMPONENT = 'SigningService';
const DAY_MS = 24 * 60 * 60 * 1000;

export class SigningError extends Error {
  constructor(message, { details = [], status = 400 } = {}) {
    super(message);
    this.name = 'SigningError';
    this.details = details;
    this.status = status;
  }
}

function newCertId() {
  return `cert-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function certificateEntry({
  source,
  chainPem,
  keyPem,
  rootPem = null,
  createdBy = 'system',
  status = 'active'
}) {
  const certs = orderChain(parsePemCertificates(chainPem));
  const leaf = describeCertificate(certs[0]);
  const now = new Date().toISOString();
  return {
    id: newCertId(),
    source,
    status,
    chainPem,
    rootPem,
    keyEnc: sealSecret(keyPem),
    subject: leaf.subject,
    issuer: leaf.issuer,
    serialNumber: leaf.serialNumber,
    notBefore: leaf.notBefore,
    notAfter: leaf.notAfter,
    fingerprint: leaf.fingerprint,
    createdAt: now,
    createdBy,
    activatedAt: status === 'active' ? now : null,
    retiredAt: null
  };
}

/** A tiny PNG for test signatures. */
function testPng() {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200;
    png.data[i + 1] = 30;
    png.data[i + 2] = (i * 7) % 255;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * Public view of a keystore certificate entry: no key material.
 * @param {Object} entry
 * @param {Date} [now]
 */
export function describeEntry(entry, now = new Date()) {
  let chain = [];
  try {
    chain = orderChain(parsePemCertificates(entry.chainPem || '')).map(describeCertificate);
  } catch {
    chain = [];
  }
  const expiresInDays = entry.notAfter
    ? Math.floor((new Date(entry.notAfter).getTime() - now.getTime()) / DAY_MS)
    : null;
  return {
    id: entry.id,
    source: entry.source,
    status: entry.status,
    subject: entry.subject || null,
    issuer: entry.issuer || null,
    serialNumber: entry.serialNumber || null,
    notBefore: entry.notBefore || null,
    notAfter: entry.notAfter || null,
    expiresInDays,
    expired: expiresInDays !== null && expiresInDays < 0,
    fingerprint: entry.fingerprint || null,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    activatedAt: entry.activatedAt || null,
    retiredAt: entry.retiredAt || null,
    chain,
    csrPem: entry.status === 'pending' ? entry.csrPem || null : undefined
  };
}

class SigningService {
  constructor() {
    this._signerCache = null;
    this._ensuring = null;
  }

  _invalidate() {
    this._signerCache = null;
  }

  /**
   * Make sure an active certificate exists when signing is enabled. Called at
   * startup and lazily before the first signature.
   * @returns {Promise<Object|null>} the active entry
   */
  async ensureCertificate() {
    const cfg = getAiTransparencyConfig();
    if (!cfg.signing.enabled) return null;
    const store = await keyStore.read();
    const active = store.certificates.find(c => c.status === 'active');
    if (active) return active;
    if (!this._ensuring) {
      this._ensuring = (async () => {
        const generated = await this._generate(cfg);
        const entry = certificateEntry({ source: 'auto', ...generated, createdBy: 'system' });
        if (store.certificates.length === 0) {
          const created = await keyStore.createWithCertificate(entry);
          if (created) {
            logger.info('Generated installation C2PA signing certificate', {
              component: COMPONENT,
              subject: entry.subject,
              notAfter: entry.notAfter
            });
            return entry;
          }
          const after = await keyStore.read();
          return after.certificates.find(c => c.status === 'active') || null;
        }
        // Certificates exist but none is active (all retired or pending): add one.
        return keyStore.update(s => {
          const current = s.certificates.find(c => c.status === 'active');
          if (current) return current;
          s.certificates.push(entry);
          return entry;
        });
      })().finally(() => {
        this._ensuring = null;
        this._invalidate();
      });
    }
    return this._ensuring;
  }

  async _generate(cfg) {
    const organization = cfg.signing.organization || cfg.provider.legalEntity || '';
    const commonName =
      cfg.signing.commonName || (organization ? `${organization} iHub` : 'iHub Apps');
    return generateInstallationCertificate({ organization, commonName });
  }

  /**
   * The signer for new content, or null when signing is off or failed.
   * @returns {Promise<{id: string, chainPem: string, keyPem: string, alg: string, tsaUrl: string}|null>}
   */
  async getActiveSigner() {
    const cfg = getAiTransparencyConfig();
    if (!cfg.signing.enabled) return null;
    const store = await keyStore.read();
    let active = store.certificates.find(c => c.status === 'active');
    if (!active) active = await this.ensureCertificate();
    if (!active) return null;
    if (this._signerCache?.id === active.id && this._signerCache.tsaUrl === cfg.signing.tsaUrl) {
      return this._signerCache;
    }
    const keyPem = openSecret(active.keyEnc);
    if (!keyPem) return null;
    const validation = await validateSigningBundle({ chainPem: active.chainPem, keyPem });
    this._signerCache = {
      id: active.id,
      chainPem: active.chainPem,
      keyPem,
      alg: validation.alg || 'es256',
      tsaUrl: cfg.signing.tsaUrl || '',
      notAfter: active.notAfter,
      fingerprint: active.fingerprint
    };
    return this._signerCache;
  }

  /**
   * PEM trust anchors: the roots (or chain tops) of every certificate this
   * installation ever signed with, plus the configured `trustedAnchors`.
   * @returns {Promise<string[]>}
   */
  async getTrustAnchors() {
    const cfg = getAiTransparencyConfig();
    const store = await keyStore.read();
    const anchors = [];
    for (const entry of store.certificates) {
      if (entry.status === 'pending') continue;
      if (entry.rootPem) {
        anchors.push(entry.rootPem);
        continue;
      }
      const certs = orderChain(parsePemCertificates(entry.chainPem || ''));
      if (certs.length) anchors.push(certs[certs.length - 1].toString('pem'));
    }
    for (const pem of cfg.signing.trustedAnchors || []) {
      if (typeof pem === 'string' && pem.includes('BEGIN CERTIFICATE')) anchors.push(pem);
    }
    return anchors;
  }

  /** PEM of this installation's current root (what `/.well-known/ai-provenance` publishes). */
  async getPublishedAnchor() {
    const store = await keyStore.read();
    const active = store.certificates.find(c => c.status === 'active');
    if (!active) return null;
    if (active.rootPem) return active.rootPem;
    const certs = orderChain(parsePemCertificates(active.chainPem || ''));
    return certs.length ? certs[certs.length - 1].toString('pem') : null;
  }

  /**
   * Status for the EU AI Act page. Never includes key material.
   */
  async status() {
    const cfg = getAiTransparencyConfig();
    const store = await keyStore.read();
    const c2paAvailable = await isC2paAvailable();
    const certificates = store.certificates.map(e => describeEntry(e));
    const active = certificates.find(c => c.status === 'active') || null;
    return {
      enabled: cfg.signing.enabled,
      c2paAvailable,
      tsaUrl: cfg.signing.tsaUrl || '',
      timestamping: cfg.signing.tsaUrl ? 'tsa' : 'local-clock',
      active,
      certificates,
      trustedAnchorCount: (cfg.signing.trustedAnchors || []).length
    };
  }

  /**
   * Sign + verify round trip with a candidate signer. Uses C2PA on a PNG
   * when the addon is available, else a JWS.
   */
  async _testRoundTrip({ chainPem, keyPem, alg }, extraAnchors = []) {
    const anchors = [...(await this.getTrustAnchors()), ...extraAnchors];
    const certs = orderChain(parsePemCertificates(chainPem));
    const top = certs[certs.length - 1];
    anchors.push(top.toString('pem'));
    const token = signJws({ test: true, at: new Date().toISOString() }, { keyPem, chainPem, alg });
    const jws = await verifyJws(token, { trustAnchors: anchors });
    if (!jws.valid) {
      throw new SigningError('Test signature failed', { details: jws.errors });
    }
    if (await isC2paAvailable()) {
      const signed = await this._c2paTestSign({ chainPem, keyPem, alg });
      const read = await readAsset(signed, 'image/png', { trustAnchors: anchors });
      if (!read.present || !['Valid', 'Trusted'].includes(read.validationState)) {
        throw new SigningError('C2PA test signature did not validate', {
          details: (read.issues || []).map(i => i.code || i.explanation).filter(Boolean)
        });
      }
      return { c2pa: read.validationState, jws: jws.trusted ? 'Trusted' : 'Valid' };
    }
    return { c2pa: null, jws: jws.trusted ? 'Trusted' : 'Valid' };
  }

  async _c2paTestSign({ chainPem, keyPem, alg }) {
    try {
      return await signAsset(
        testPng(),
        'image/png',
        {
          claim_generator_info: [{ name: 'iHub Apps', version: getAppVersion() }],
          title: 'ihub-signing-test.png',
          format: 'image/png',
          assertions: [
            {
              label: 'c2pa.actions',
              data: {
                actions: [
                  {
                    action: 'c2pa.created',
                    digitalSourceType:
                      'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation'
                  }
                ]
              }
            }
          ]
        },
        { chainPem, keyPem, alg }
      );
    } catch (error) {
      throw new SigningError('C2PA refused to sign with this certificate', {
        details: [String(error?.message || error)]
      });
    }
  }

  async _switchTo(entry) {
    const now = new Date().toISOString();
    await keyStore.update(store => {
      for (const cert of store.certificates) {
        if (cert.status === 'active') {
          cert.status = 'detect-only';
          cert.retiredAt = now;
        }
      }
      const existing = store.certificates.find(c => c.id === entry.id);
      if (existing) {
        Object.assign(existing, entry, { status: 'active', activatedAt: now, retiredAt: null });
      } else {
        store.certificates.push({ ...entry, status: 'active', activatedAt: now });
      }
    });
    this._invalidate();
    return describeEntry({ ...entry, status: 'active', activatedAt: now, retiredAt: null });
  }

  /**
   * Issue a new auto-generated CA + certificate and switch to it (rotation).
   * @param {{actor?: string}} [opts]
   */
  async rotateAuto({ actor = 'system' } = {}) {
    const cfg = getAiTransparencyConfig();
    const generated = await this._generate(cfg);
    const entry = certificateEntry({ source: 'auto', ...generated, createdBy: actor });
    const test = await this._testRoundTrip(
      { chainPem: generated.chainPem, keyPem: generated.keyPem, alg: 'es256' },
      [generated.rootPem]
    );
    const described = await this._switchTo(entry);
    return { certificate: described, test };
  }

  /**
   * Install an admin-provided certificate.
   * @param {Object} input - `{chainPem, keyPem}` or `{pkcs12Base64, password}`
   * @param {{actor?: string}} [opts]
   */
  async installCustom(input, { actor = 'admin' } = {}) {
    let chainPem = input?.chainPem;
    let keyPem = input?.keyPem;
    if (input?.pkcs12Base64) {
      try {
        ({ chainPem, keyPem } = await parsePkcs12(
          Buffer.from(input.pkcs12Base64, 'base64'),
          input.password || ''
        ));
      } catch (error) {
        throw new SigningError(`Could not read the PKCS#12 file: ${error.message}`);
      }
    }
    if (!chainPem || !keyPem)
      throw new SigningError('A certificate chain and a private key are required');
    const validation = await validateSigningBundle({ chainPem, keyPem });
    if (!validation.ok) {
      throw new SigningError('The certificate cannot be used for C2PA signing', {
        details: validation.errors
      });
    }
    const test = await this._testRoundTrip({
      chainPem: validation.chainPem,
      keyPem: validation.keyPem,
      alg: validation.alg
    });
    const entry = certificateEntry({
      source: 'custom',
      chainPem: validation.chainPem,
      keyPem: validation.keyPem,
      createdBy: actor
    });
    const described = await this._switchTo(entry);
    return { certificate: described, test, warnings: validation.warnings };
  }

  /**
   * Generate a key pair and CSR; the pending entry waits for the certificate.
   * @param {{commonName?: string, organization?: string, email?: string}} subject
   * @param {{actor?: string}} [opts]
   */
  async createCsr(subject = {}, { actor = 'admin' } = {}) {
    const cfg = getAiTransparencyConfig();
    const organization =
      subject.organization || cfg.signing.organization || cfg.provider.legalEntity || '';
    const commonName =
      subject.commonName ||
      cfg.signing.commonName ||
      (organization ? `${organization} iHub Content Signer` : 'iHub Content Signer');
    const { csrPem, keyPem } = await generateCsr({
      commonName,
      organization,
      email: subject.email || ''
    });
    const entry = {
      id: newCertId(),
      source: 'csr',
      status: 'pending',
      chainPem: '',
      rootPem: null,
      keyEnc: sealSecret(keyPem),
      csrPem,
      subject: `CN=${commonName}${organization ? `, O=${organization}` : ''}`,
      createdAt: new Date().toISOString(),
      createdBy: actor
    };
    await keyStore.update(store => {
      // One pending CSR at a time: a new request replaces the old one.
      store.certificates = store.certificates.filter(c => c.status !== 'pending');
      store.certificates.push(entry);
    });
    return describeEntry(entry);
  }

  /**
   * Complete a CSR with the issued certificate (chain).
   * @param {string} id
   * @param {string} chainPem
   * @param {{actor?: string}} [opts]
   */
  async completeCsr(id, chainPem, { actor = 'admin' } = {}) {
    const store = await keyStore.read();
    const pending = store.certificates.find(c => c.id === id && c.status === 'pending');
    if (!pending)
      throw new SigningError('No pending certificate request with this id', { status: 404 });
    const keyPem = openSecret(pending.keyEnc);
    const validation = await validateSigningBundle({ chainPem, keyPem });
    if (!validation.ok) {
      throw new SigningError('The certificate does not match the request or cannot sign', {
        details: validation.errors
      });
    }
    const test = await this._testRoundTrip({
      chainPem: validation.chainPem,
      keyPem,
      alg: validation.alg
    });
    const entry = {
      ...certificateEntry({
        source: 'csr',
        chainPem: validation.chainPem,
        keyPem,
        createdBy: actor
      }),
      id: pending.id,
      createdAt: pending.createdAt
    };
    const described = await this._switchTo(entry);
    return { certificate: described, test, warnings: validation.warnings };
  }

  /**
   * Switch back to a detect-only certificate (rollback).
   * @param {string} id
   */
  async activate(id) {
    const store = await keyStore.read();
    const entry = store.certificates.find(c => c.id === id);
    if (!entry) throw new SigningError('Unknown certificate', { status: 404 });
    if (entry.status === 'pending')
      throw new SigningError('A pending request has no certificate yet');
    if (entry.status === 'active') return describeEntry(entry);
    if (new Date(entry.notAfter) < new Date())
      throw new SigningError('The certificate has expired');
    const keyPem = openSecret(entry.keyEnc);
    await this._testRoundTrip(
      {
        chainPem: entry.chainPem,
        keyPem,
        alg: (await validateSigningBundle({ chainPem: entry.chainPem, keyPem })).alg || 'es256'
      },
      entry.rootPem ? [entry.rootPem] : []
    );
    return this._switchTo(entry);
  }

  /**
   * Remove a pending CSR (a signing or detect-only certificate is kept for
   * verification and cannot be removed here).
   * @param {string} id
   */
  async removePending(id) {
    let removed = false;
    await keyStore.update(store => {
      const before = store.certificates.length;
      store.certificates = store.certificates.filter(c => !(c.id === id && c.status === 'pending'));
      removed = store.certificates.length < before;
    });
    return removed;
  }

  /**
   * Sign a payload as a compact JWS with the active certificate.
   * @param {Object} payload
   * @param {{typ?: string}} [opts]
   * @returns {Promise<string|null>} null when signing is unavailable
   */
  async signPayload(payload, { typ } = {}) {
    const signer = await this.getActiveSigner();
    if (!signer) return null;
    return signJws(payload, {
      keyPem: signer.keyPem,
      chainPem: signer.chainPem,
      alg: signer.alg,
      typ
    });
  }

  /**
   * Verify a JWS against this installation's trust anchors.
   * @param {string} token
   * @param {{extraAnchors?: string[]}} [opts]
   */
  async verifyPayload(token, { extraAnchors = [] } = {}) {
    const anchors = [...(await this.getTrustAnchors()), ...extraAnchors];
    return verifyJws(token, { trustAnchors: anchors });
  }
}

const signingService = new SigningService();
export default signingService;
