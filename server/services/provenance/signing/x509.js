/**
 * X.509 helpers for C2PA signing: the installation CA, certificate chain
 * validation, CSR generation and PKCS#12 import.
 *
 * Node's core crypto can read but not create certificates, so creation and
 * CSRs use `@peculiar/x509` (pure JS over WebCrypto), PKCS#12 uses `pkijs`.
 * Private keys leave this module as PKCS#8 PEM only; callers encrypt them
 * before they touch disk.
 *
 * @module services/provenance/signing/x509
 */
import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto);

/**
 * EKUs C2PA validators accept for claim signing (C2PA 2.x trust model):
 * e-mail protection, document signing, the C2PA claim-signing EKU and
 * Microsoft's C2PA signing EKU.
 */
export const C2PA_ACCEPTED_EKUS = Object.freeze({
  '1.3.6.1.5.5.7.3.4': 'emailProtection',
  '1.3.6.1.5.5.7.3.36': 'documentSigning',
  '1.3.6.1.4.1.62558.2.1': 'c2paClaimSigning',
  '1.3.6.1.4.1.311.76.59.1.9': 'microsoftC2paSigning'
});

const EC_P256 = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const DAY_MS = 24 * 60 * 60 * 1000;

function randomSerial() {
  // Positive 128-bit serial (leading byte < 0x80).
  const bytes = crypto.randomBytes(16);
  bytes[0] &= 0x7f;
  return bytes.toString('hex');
}

function escapeDn(value) {
  return String(value)
    .replace(/([,+"\\<>;=])/g, '\\$1')
    .trim();
}

/**
 * Organization used when the operator entered none. C2PA validators reject a
 * signer certificate without an organization (O) in its subject — c2pa-rs
 * reports it as `claimSignature.mismatch` — so the subject always carries one.
 */
export const DEFAULT_ORGANIZATION = 'iHub Apps';

function buildName({ commonName, organization }) {
  return [
    `CN=${escapeDn(commonName || 'iHub Apps')}`,
    `O=${escapeDn(organization || DEFAULT_ORGANIZATION)}`
  ].join(', ');
}

function hasOrganization(name) {
  return /(^|,\s*)O=/.test(String(name || ''));
}

async function exportPkcs8Pem(privateKey) {
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', privateKey));
  return x509.PemConverter.encode(der, 'PRIVATE KEY');
}

/**
 * Summary of one certificate for status pages and records.
 * @param {x509.X509Certificate} cert
 */
export function describeCertificate(cert) {
  const der = Buffer.from(cert.rawData);
  const eku = cert.getExtension(x509.ExtendedKeyUsageExtension);
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    serialNumber: cert.serialNumber,
    notBefore: cert.notBefore.toISOString(),
    notAfter: cert.notAfter.toISOString(),
    fingerprint: crypto.createHash('sha256').update(der).digest('hex'),
    ekus: eku ? Array.from(eku.usages, String) : [],
    selfSigned: cert.subject === cert.issuer
  };
}

/**
 * Generate an installation root CA and a C2PA leaf signing certificate.
 * ES256 (ECDSA P-256), leaf with critical key usage `digitalSignature` and
 * EKU `emailProtection`. The root key is not returned: it signs the leaf and
 * is discarded; rotation issues a new root.
 *
 * @param {Object} opts
 * @param {string} [opts.organization]
 * @param {string} [opts.commonName]
 * @param {number} [opts.rootValidityDays=3650]
 * @param {number} [opts.leafValidityDays=730]
 * @returns {Promise<{chainPem: string, rootPem: string, keyPem: string, leaf: Object, root: Object}>}
 */
export async function generateInstallationCertificate({
  organization = '',
  commonName = 'iHub Apps',
  rootValidityDays = 3650,
  leafValidityDays = 730
} = {}) {
  const now = new Date(Date.now() - 5 * 60 * 1000); // tolerate small clock skew
  const rootKeys = await webcrypto.subtle.generateKey(EC_P256, true, ['sign', 'verify']);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: buildName({ commonName: `${commonName} Installation Root CA`, organization }),
    notBefore: now,
    notAfter: new Date(now.getTime() + rootValidityDays * DAY_MS),
    keys: rootKeys,
    signingAlgorithm: EC_P256,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true
      ),
      await x509.SubjectKeyIdentifierExtension.create(rootKeys.publicKey)
    ]
  });

  const leafKeys = await webcrypto.subtle.generateKey(EC_P256, true, ['sign', 'verify']);
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: buildName({ commonName: `${commonName} Content Signer`, organization }),
    issuer: root.subject,
    notBefore: now,
    notAfter: new Date(now.getTime() + leafValidityDays * DAY_MS),
    signingKey: rootKeys.privateKey,
    publicKey: leafKeys.publicKey,
    signingAlgorithm: EC_P256,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.4'], false),
      await x509.SubjectKeyIdentifierExtension.create(leafKeys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(root)
    ]
  });

  const rootPem = root.toString('pem');
  return {
    chainPem: `${leaf.toString('pem')}\n${rootPem}\n`,
    rootPem: `${rootPem}\n`,
    keyPem: await exportPkcs8Pem(leafKeys.privateKey),
    leaf: describeCertificate(leaf),
    root: describeCertificate(root)
  };
}

/**
 * Split a PEM bundle into certificates.
 * @param {string} pem
 * @returns {x509.X509Certificate[]}
 */
export function parsePemCertificates(pem) {
  if (typeof pem !== 'string' || !pem.includes('-----BEGIN CERTIFICATE-----')) return [];
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  return blocks.map(block => new x509.X509Certificate(block));
}

/**
 * Order a set of certificates leaf-first: the leaf is the one that issued
 * no other certificate in the set.
 * @param {x509.X509Certificate[]} certs
 * @returns {x509.X509Certificate[]}
 */
export function orderChain(certs) {
  if (certs.length <= 1) return certs;
  const issuers = new Set(certs.filter(c => c.subject !== c.issuer).map(c => c.issuer));
  const leaf = certs.find(c => !issuers.has(c.subject)) || certs[0];
  const ordered = [leaf];
  const rest = certs.filter(c => c !== leaf);
  while (rest.length) {
    const current = ordered[ordered.length - 1];
    if (current.subject === current.issuer) break;
    const idx = rest.findIndex(c => c.subject === current.issuer);
    if (idx === -1) break;
    ordered.push(rest.splice(idx, 1)[0]);
  }
  return ordered.concat(rest);
}

/**
 * The COSE/c2pa signing algorithm for a private key.
 * @param {crypto.KeyObject} key
 * @returns {'es256'|'es384'|'es512'|'ps256'|'ed25519'|null}
 */
export function signingAlgForKey(key) {
  const type = key.asymmetricKeyType;
  if (type === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve === 'prime256v1' || curve === 'P-256') return 'es256';
    if (curve === 'secp384r1' || curve === 'P-384') return 'es384';
    if (curve === 'secp521r1' || curve === 'P-521') return 'es512';
    return null;
  }
  if (type === 'rsa-pss' || type === 'rsa') return 'ps256';
  if (type === 'ed25519') return 'ed25519';
  return null;
}

async function verifiesWith(cert, issuer) {
  try {
    return await cert.verify({ publicKey: issuer.publicKey, signatureOnly: true });
  } catch {
    return false;
  }
}

/**
 * Validate a certificate chain and key for C2PA signing: chain order and
 * signatures, a C2PA-accepted EKU and `digitalSignature` on the leaf, the key
 * matching the leaf, and validity dates.
 *
 * @param {Object} opts
 * @param {string} opts.chainPem - leaf first or in any order; intermediates and root optional
 * @param {string} opts.keyPem - PKCS#8 (or SEC1/PKCS#1) PEM private key
 * @param {Date} [opts.now]
 * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], alg: string|null, chainPem: string, keyPem: string, leaf: Object|null, chain: Object[]}>}
 */
export async function validateSigningBundle({ chainPem, keyPem, now = new Date() }) {
  const errors = [];
  const warnings = [];
  let certs;
  try {
    certs = orderChain(parsePemCertificates(chainPem));
  } catch (error) {
    return {
      ok: false,
      errors: [`Certificate chain is not valid PEM: ${error.message}`],
      warnings,
      alg: null,
      chainPem,
      keyPem,
      leaf: null,
      chain: []
    };
  }
  if (certs.length === 0) {
    return {
      ok: false,
      errors: ['No certificate found in the chain'],
      warnings,
      alg: null,
      chainPem,
      keyPem,
      leaf: null,
      chain: []
    };
  }
  const leaf = certs[0];

  // Private key
  let privateKey;
  let normalizedKeyPem = keyPem;
  let alg = null;
  try {
    privateKey = crypto.createPrivateKey(keyPem);
    normalizedKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    alg = signingAlgForKey(privateKey);
    if (!alg) errors.push(`Unsupported key type ${privateKey.asymmetricKeyType}`);
  } catch (error) {
    errors.push(`Private key is not readable: ${error.message}`);
  }

  // Key matches the leaf
  if (privateKey) {
    try {
      const leafPublic = crypto.createPublicKey(leaf.toString('pem'));
      const probe = crypto.randomBytes(32);
      const algo = privateKey.asymmetricKeyType === 'ed25519' ? null : 'sha256';
      const signOpts =
        privateKey.asymmetricKeyType === 'rsa-pss' || privateKey.asymmetricKeyType === 'rsa'
          ? { key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }
          : privateKey;
      const verifyOpts =
        privateKey.asymmetricKeyType === 'rsa-pss' || privateKey.asymmetricKeyType === 'rsa'
          ? { key: leafPublic, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }
          : leafPublic;
      const sig = crypto.sign(algo, probe, signOpts);
      if (!crypto.verify(algo, probe, verifyOpts, sig)) {
        errors.push('The private key does not belong to the signing certificate');
      }
    } catch (error) {
      errors.push(`Could not check the key against the certificate: ${error.message}`);
    }
  }

  // Leaf profile
  const basic = leaf.getExtension(x509.BasicConstraintsExtension);
  if (basic?.ca)
    errors.push(
      'The signing certificate is a CA certificate; C2PA needs an end-entity certificate'
    );
  // C2PA certificate profile (C2PA spec, "Certificate Profile"): key usage
  // present with digitalSignature, an EKU, and an authority key identifier.
  const ku = leaf.getExtension(x509.KeyUsagesExtension);
  if (!ku || !(ku.usages & x509.KeyUsageFlags.digitalSignature)) {
    errors.push('The signing certificate lacks the digitalSignature key usage');
  }
  if (!leaf.getExtension(x509.AuthorityKeyIdentifierExtension)) {
    errors.push('The signing certificate has no authority key identifier extension');
  }
  const eku = leaf.getExtension(x509.ExtendedKeyUsageExtension);
  const ekus = eku ? Array.from(eku.usages, String) : [];
  if (!ekus.some(e => C2PA_ACCEPTED_EKUS[e])) {
    errors.push(
      `The signing certificate has no C2PA-accepted extended key usage (need one of ${Object.values(C2PA_ACCEPTED_EKUS).join(', ')})`
    );
  }
  if (leaf.subject === leaf.issuer) {
    errors.push(
      'The signing certificate is self-signed; C2PA validators require a certificate issued by a CA'
    );
  }
  if (!hasOrganization(leaf.subject)) {
    errors.push(
      'The signing certificate subject has no organization (O); C2PA validators require one'
    );
  }

  // Validity
  for (const cert of certs) {
    if (cert.notAfter < now)
      errors.push(`Certificate "${cert.subject}" expired on ${cert.notAfter.toISOString()}`);
    if (cert.notBefore > now)
      errors.push(
        `Certificate "${cert.subject}" is not valid before ${cert.notBefore.toISOString()}`
      );
  }
  const daysLeft = Math.floor((leaf.notAfter.getTime() - now.getTime()) / DAY_MS);
  if (daysLeft >= 0 && daysLeft < 30)
    warnings.push(`The signing certificate expires in ${daysLeft} days`);

  // Chain signatures
  for (let i = 0; i < certs.length - 1; i++) {
    if (certs[i].issuer !== certs[i + 1].subject) {
      errors.push(
        `Chain is out of order: "${certs[i].subject}" is not issued by "${certs[i + 1].subject}"`
      );
      break;
    }
    if (!(await verifiesWith(certs[i], certs[i + 1]))) {
      errors.push(`"${certs[i].subject}" is not signed by "${certs[i + 1].subject}"`);
    }
  }
  const top = certs[certs.length - 1];
  if (top.subject !== top.issuer) {
    warnings.push(
      'The chain does not include its root certificate; verifiers need the root as a trust anchor'
    );
  }

  const chainOut = `${certs.map(c => c.toString('pem')).join('\n')}\n`;
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    alg,
    chainPem: chainOut,
    keyPem: normalizedKeyPem,
    leaf: describeCertificate(leaf),
    chain: certs.map(describeCertificate)
  };
}

/**
 * Generate a key pair and a PKCS#10 CSR, so the private key never leaves the
 * installation. The admin sends the CSR to a CA and uploads the certificate.
 *
 * @param {Object} opts
 * @param {string} opts.commonName
 * @param {string} [opts.organization]
 * @param {string} [opts.email]
 * @returns {Promise<{csrPem: string, keyPem: string}>}
 */
export async function generateCsr({ commonName, organization = '', email = '' }) {
  const keys = await webcrypto.subtle.generateKey(EC_P256, true, ['sign', 'verify']);
  const extensions = [
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.4'], false)
  ];
  if (email) {
    extensions.push(new x509.SubjectAlternativeNameExtension([{ type: 'email', value: email }]));
  }
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: buildName({ commonName, organization }),
    keys,
    signingAlgorithm: EC_P256,
    extensions
  });
  return { csrPem: csr.toString('pem'), keyPem: await exportPkcs8Pem(keys.privateKey) };
}

/**
 * Read a PKCS#12 (.p12/.pfx) file into a PEM chain and key. Supports the
 * PBES2/AES files current OpenSSL and PKI tooling write.
 *
 * @param {Buffer} buffer
 * @param {string} password
 * @returns {Promise<{chainPem: string, keyPem: string}>}
 */
export async function parsePkcs12(buffer, password = '') {
  const pkijs = await import('pkijs');
  const asn1js = await import('asn1js');
  pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto }));
  const asn1 = asn1js.fromBER(new Uint8Array(buffer).buffer);
  if (asn1.offset === -1) throw new Error('Not a PKCS#12 file');
  const pfx = new pkijs.PFX({ schema: asn1.result });
  const pw = new TextEncoder().encode(password).buffer;
  await pfx.parseInternalValues({ password: pw, checkIntegrity: true });
  const safeContents = pfx.parsedValue?.authenticatedSafe;
  if (!safeContents) throw new Error('PKCS#12 file has no content');
  await safeContents.parseInternalValues({
    safeContents: safeContents.safeContents.map(() => ({ password: pw }))
  });
  const certs = [];
  let keyDer = null;
  for (const content of safeContents.parsedValue.safeContents) {
    for (const bag of content.value.safeBags) {
      if (bag.bagId === '1.2.840.113549.1.12.10.1.3') {
        certs.push(Buffer.from(bag.bagValue.parsedValue.toSchema().toBER(false)));
      } else if (bag.bagId === '1.2.840.113549.1.12.10.1.2') {
        await bag.bagValue.parseInternalValues({ password: pw });
        keyDer = Buffer.from(bag.bagValue.parsedValue.toSchema().toBER(false));
      } else if (bag.bagId === '1.2.840.113549.1.12.10.1.1') {
        keyDer = Buffer.from(bag.bagValue.toSchema().toBER(false));
      }
    }
  }
  if (!keyDer) throw new Error('PKCS#12 file contains no private key');
  if (certs.length === 0) throw new Error('PKCS#12 file contains no certificate');
  const keyPem = crypto
    .createPrivateKey({ key: keyDer, format: 'der', type: 'pkcs8' })
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const chainPem = certs.map(der => new x509.X509Certificate(der).toString('pem')).join('\n');
  return { chainPem: `${chainPem}\n`, keyPem };
}

/**
 * Verify that `certs` (leaf first) chains up to one of `anchors`.
 * @param {x509.X509Certificate[]} certs
 * @param {x509.X509Certificate[]} anchors
 * Validity dates are not checked here: signed content outlives its
 * certificate, and what counts is the time of signing, which the caller
 * compares with the signed timestamp.
 *
 * @returns {Promise<{trusted: boolean, anchor: Object|null, reason?: string}>}
 */
export async function chainsToAnchor(certs, anchors) {
  if (!certs.length) return { trusted: false, anchor: null, reason: 'no certificate' };
  for (let i = 0; i < certs.length - 1; i++) {
    if (!(await verifiesWith(certs[i], certs[i + 1]))) {
      return { trusted: false, anchor: null, reason: 'broken chain' };
    }
  }
  const byFingerprint = new Map(anchors.map(a => [describeCertificate(a).fingerprint, a]));
  for (const cert of certs) {
    const fp = describeCertificate(cert).fingerprint;
    if (byFingerprint.has(fp)) return { trusted: true, anchor: describeCertificate(cert) };
  }
  const top = certs[certs.length - 1];
  for (const anchor of anchors) {
    if (anchor.subject === top.issuer && (await verifiesWith(top, anchor))) {
      return { trusted: true, anchor: describeCertificate(anchor) };
    }
  }
  return { trusted: false, anchor: null, reason: 'no trust anchor' };
}

export { x509 };
