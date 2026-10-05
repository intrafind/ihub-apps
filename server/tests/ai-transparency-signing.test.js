/**
 * EU AI Act transparency (#2568, #2572, #2575): installation CA, custom
 * certificates, CSR, rotation and rollback; JWS; watermark key groups and
 * encrypted key bundles; the text signpost (C2PA text wrapper).
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { cleanup, setConfig, tempContents } from './helpers/aiTransparencyEnv.js';

const x = await import('../services/provenance/signing/x509.js');
const { default: signingService } =
  await import('../services/provenance/signing/SigningService.js');
const { signJws, verifyJws } = await import('../services/provenance/signing/jws.js');
const { default: keyGroupService } =
  await import('../services/provenance/watermark/KeyGroupService.js');
const signpost = await import('../services/provenance/text/signpost.js');
const { watermarkRequestFields } =
  await import('../services/provenance/watermark/requestParams.js');
const { removeWatermarkOverrides } = await import('../services/provenance/httpProvenance.js');
const { isC2paAvailable } = await import('../services/provenance/signing/c2pa.js');

after(cleanup);
const c2paAvailable = await isC2paAvailable();
setConfig({ platform: { aiTransparency: { signing: { organization: 'ACME GmbH' } } } });

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A tiny customer PKI issuing C2PA-profile certificates. */
async function customerPki() {
  const { x509 } = x;
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '0a',
    name: 'CN=Customer Root, O=Customer',
    notBefore: new Date(Date.now() - 60000),
    notAfter: new Date(Date.now() + 864e8),
    keys,
    signingAlgorithm: alg,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)
    ]
  });
  const issue = async (subject, publicKey, { eku = ['1.3.6.1.5.5.7.3.4'] } = {}) =>
    x509.X509CertificateGenerator.create({
      serialNumber: '0b',
      subject,
      issuer: ca.subject,
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 864e7),
      signingKey: keys.privateKey,
      publicKey,
      signingAlgorithm: alg,
      extensions: [
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension(eku),
        await x509.AuthorityKeyIdentifierExtension.create(ca)
      ]
    });
  return { ca, issue, alg };
}

describe('installation CA', () => {
  it('generates a C2PA-profile chain that validates', async () => {
    const g = await x.generateInstallationCertificate({
      organization: 'ACME GmbH',
      commonName: 'ACME iHub'
    });
    assert.match(g.leaf.subject, /O=ACME GmbH/);
    assert.deepEqual(g.leaf.ekus, ['1.3.6.1.5.5.7.3.4']);
    assert.equal(g.root.selfSigned, true);
    const v = await x.validateSigningBundle({ chainPem: g.chainPem, keyPem: g.keyPem });
    assert.equal(v.ok, true, v.errors.join('; '));
    assert.equal(v.alg, 'es256');
  });

  it('rejects a key that does not belong to the certificate', async () => {
    const a = await x.generateInstallationCertificate({});
    const b = await x.generateInstallationCertificate({});
    const v = await x.validateSigningBundle({ chainPem: a.chainPem, keyPem: b.keyPem });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => /does not belong/.test(e)));
  });

  it('always puts an organization into the subject', async () => {
    const g = await x.generateInstallationCertificate({});
    assert.match(g.leaf.subject, /O=iHub Apps/);
  });

  it('reads a PKCS#12 file written by OpenSSL', { skip: !hasOpenssl() }, async () => {
    const g = await x.generateInstallationCertificate({ organization: 'P12 Org' });
    const dir = fs.mkdtempSync(path.join(tempContents, 'p12-'));
    const [leaf] = g.chainPem.split(/\n(?=-----BEGIN)/);
    fs.writeFileSync(path.join(dir, 'leaf.pem'), leaf);
    fs.writeFileSync(path.join(dir, 'root.pem'), g.rootPem);
    fs.writeFileSync(path.join(dir, 'key.pem'), g.keyPem);
    execFileSync('openssl', [
      'pkcs12',
      '-export',
      '-inkey',
      path.join(dir, 'key.pem'),
      '-in',
      path.join(dir, 'leaf.pem'),
      '-certfile',
      path.join(dir, 'root.pem'),
      '-out',
      path.join(dir, 'b.p12'),
      '-passout',
      'pass:secret'
    ]);
    const parsed = await x.parsePkcs12(fs.readFileSync(path.join(dir, 'b.p12')), 'secret');
    const v = await x.validateSigningBundle(parsed);
    assert.equal(v.ok, true, v.errors.join('; '));
    await assert.rejects(() => x.parsePkcs12(fs.readFileSync(path.join(dir, 'b.p12')), 'wrong'));
  });
});

describe('signing service', () => {
  it('creates a certificate on first use, rotates and keeps old signatures verifiable', async () => {
    const first = await signingService.ensureCertificate();
    assert.equal(first.status, 'active');
    const token = await signingService.signPayload({ hello: 'world' });
    assert.equal((await signingService.verifyPayload(token)).trusted, true);
    const rotated = await signingService.rotateAuto({ actor: 'admin1' });
    assert.equal(rotated.certificate.status, 'active');
    const statuses = (await signingService.status()).certificates.map(c => c.status);
    assert.ok(statuses.includes('detect-only'));
    assert.equal(
      (await signingService.verifyPayload(token)).trusted,
      true,
      'detect-only root is still an anchor'
    );
    // Rollback
    const old = (await signingService.status()).certificates.find(c => c.status === 'detect-only');
    const back = await signingService.activate(old.id);
    assert.equal(back.status, 'active');
  });

  it('never stores a private key in plaintext', async () => {
    await signingService.ensureCertificate();
    const raw = fs.readFileSync(path.join(tempContents, '.ai-provenance', 'keystore.json'), 'utf8');
    assert.equal(raw.includes('BEGIN PRIVATE KEY'), false);
    const status = JSON.stringify(await signingService.status());
    assert.equal(status.includes('PRIVATE KEY'), false);
    assert.equal(status.includes('keyEnc'), false);
  });

  it('completes a CSR with a certificate from the customer PKI', async () => {
    const pki = await customerPki();
    const pending = await signingService.createCsr({
      commonName: 'Customer Signer',
      organization: 'Customer'
    });
    assert.equal(pending.status, 'pending');
    const req = new x.x509.Pkcs10CertificateRequest(pending.csrPem);
    const cert = await pki.issue(req.subject, await req.publicKey.export());
    const done = await signingService.completeCsr(
      pending.id,
      `${cert.toString('pem')}\n${pki.ca.toString('pem')}`,
      { actor: 'admin1' }
    );
    assert.equal(done.certificate.status, 'active');
    assert.equal(done.certificate.source, 'csr');
  });

  it('refuses a custom certificate without a C2PA EKU', async () => {
    const pki = await customerPki();
    const keys = await webcrypto.subtle.generateKey(pki.alg, true, ['sign', 'verify']);
    const cert = await pki.issue('CN=Server, O=Customer', keys.publicKey, {
      eku: ['1.3.6.1.5.5.7.3.1']
    });
    const keyPem = x.x509.PemConverter.encode(
      Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)),
      'PRIVATE KEY'
    );
    await assert.rejects(
      () =>
        signingService.installCustom({
          chainPem: `${cert.toString('pem')}\n${pki.ca.toString('pem')}`,
          keyPem
        }),
      error => error.details?.some(d => /extended key usage/.test(d))
    );
  });

  it('runs a C2PA round trip when the addon is available', { skip: !c2paAvailable }, async () => {
    const result = await signingService.rotateAuto({ actor: 'admin1' });
    assert.equal(result.test.c2pa, 'Trusted');
  });
});

describe('JWS', () => {
  it('detects tampering and untrusted signers', async () => {
    const g = await x.generateInstallationCertificate({});
    const token = signJws({ a: 1 }, { keyPem: g.keyPem, chainPem: g.chainPem });
    assert.equal((await verifyJws(token, { trustAnchors: [g.rootPem] })).trusted, true);
    assert.equal((await verifyJws(token, { trustAnchors: [] })).trusted, false);
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from('{"a":2}').toString('base64url')}.${s}`;
    assert.equal((await verifyJws(forged, { trustAnchors: [g.rootPem] })).valid, false);
  });

  it('trusts only C2PA signers whose issuers are CA certificates', async () => {
    const { x509 } = x;
    const { ca, issue, alg } = await customerPki();
    const pkcs8 = async key =>
      `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await webcrypto.subtle.exportKey('pkcs8', key)).toString('base64')}\n-----END PRIVATE KEY-----\n`;
    const anchors = [ca.toString('pem')];
    const signedBy = async (chain, key) =>
      verifyJws(
        signJws(
          { a: 1 },
          { keyPem: await pkcs8(key), chainPem: chain.map(c => c.toString('pem')).join('\n') }
        ),
        { trustAnchors: anchors }
      );

    const signer = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const good = await issue('CN=Signer, O=Customer', signer.publicKey);
    assert.equal((await signedBy([good, ca], signer.privateKey)).trusted, true);

    // A TLS server certificate from the same CA is not a content signer.
    const tlsKeys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const tls = await issue('CN=www, O=Customer', tlsKeys.publicKey, {
      eku: ['1.3.6.1.5.5.7.3.1']
    });
    assert.equal((await signedBy([tls, ca], tlsKeys.privateKey)).trusted, false);

    // An end-entity certificate cannot issue a trusted signer.
    const leafKeys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const forged = await x509.X509CertificateGenerator.create({
      serialNumber: '0c',
      subject: 'CN=Forged, O=Customer',
      issuer: good.subject,
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 864e7),
      signingKey: signer.privateKey,
      publicKey: leafKeys.publicKey,
      signingAlgorithm: alg,
      extensions: [
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.4'])
      ]
    });
    assert.equal((await signedBy([forged, good, ca], leafKeys.privateKey)).trusted, false);
  });

  it('treats a header or payload that is not a JSON object as not a JWS', async () => {
    const nul = Buffer.from('null').toString('base64url');
    const arr = Buffer.from('[1]').toString('base64url');
    const obj = Buffer.from('{"a":1}').toString('base64url');
    for (const token of [`${nul}.${obj}.x`, `${obj}.${arr}.x`]) {
      const result = await verifyJws(token);
      assert.equal(result.valid, false);
      assert.deepEqual(result.errors, ['Not a JWS']);
    }
  });
});

describe('watermark key groups', () => {
  it('creates, rotates, exports and imports an encrypted bundle', async () => {
    const group = await keyGroupService.create({
      id: 'acme',
      name: 'ACME',
      detectorUrl: 'http://detector'
    });
    assert.equal(group.activeVersion, 1);
    const rotated = await keyGroupService.rotate('acme');
    assert.equal(rotated.activeVersion, 2);
    assert.equal(rotated.versions.find(v => v.version === 1).status, 'detect-only');
    const config = await keyGroupService.vllmConfig('acme');
    assert.match(config.watermarkConfig, /^\{"algorithm":"gumbel","key":\d+,"context_width":4\}$/);
    const bundle = await keyGroupService.exportBundle(['acme'], 'correct horse battery');
    assert.equal(
      JSON.stringify(bundle).includes(JSON.parse(config.watermarkConfig).key.toString()),
      false
    );
    await assert.rejects(() => keyGroupService.importBundle(bundle, 'wrong passphrase!'));
    await keyGroupService.remove('acme');
    const imported = await keyGroupService.importBundle(bundle, 'correct horse battery');
    assert.equal(imported[0].activeVersion, 2);
    const keys = await keyGroupService.detectionKeys('acme');
    assert.equal(keys.keys.length, 2);
    assert.ok(!JSON.stringify(await keyGroupService.list()).includes('keyEnc'));
  });

  it('refuses bundle KDF parameters it did not write', async () => {
    await keyGroupService.create({ id: 'kdf-check', name: 'KDF' });
    const bundle = await keyGroupService.exportBundle(['kdf-check'], 'correct horse battery');
    for (const kdf of [
      { ...bundle.kdf, p: 1000 },
      { ...bundle.kdf, N: 2 ** 20 },
      { ...bundle.kdf, name: 'pbkdf2' }
    ]) {
      await assert.rejects(
        () => keyGroupService.importBundle({ ...bundle, kdf }, 'correct horse battery'),
        /Unsupported key derivation/
      );
    }
    await keyGroupService.remove('kdf-check');
  });

  it('refuses a bundle whose version collides with a different local key', async () => {
    await keyGroupService.create({ id: 'shared', name: 'Shared' });
    const theirs = await keyGroupService.exportBundle(['shared'], 'correct horse battery');
    await keyGroupService.remove('shared');
    // Same id and version 1, created independently here: a different key.
    await keyGroupService.create({ id: 'shared', name: 'Shared' });
    await assert.rejects(
      () => keyGroupService.importBundle(theirs, 'correct horse battery'),
      err => err.status === 409 && /different key/.test(err.message)
    );
    // Re-importing our own bundle is a no-op, not a conflict.
    const ours = await keyGroupService.exportBundle(['shared'], 'correct horse battery');
    await keyGroupService.importBundle(ours, 'correct horse battery');
    await keyGroupService.remove('shared');
  });
});

describe('server-owned watermarking', () => {
  it('derives the per-request flag from the model only and strips client overrides', () => {
    const model = {
      contentMarking: { textWatermark: { scheme: 'vllm-gumbel', keyGroup: 'k', perRequest: true } }
    };
    assert.deepEqual(watermarkRequestFields(model), { watermarking: true });
    assert.deepEqual(watermarkRequestFields({ contentMarking: { textWatermark: 'none' } }), {});
    const body = {
      model: 'x',
      watermarking: false,
      extra_body: { watermarking: false },
      vllm_xargs: {}
    };
    assert.deepEqual(removeWatermarkOverrides(body).sort(), [
      'extra_body',
      'vllm_xargs',
      'watermarking'
    ]);
    assert.deepEqual(body, { model: 'x' });
  });

  it('the vLLM adapter request carries the model setting whatever the caller sends', async () => {
    const { default: vllm } = await import('../adapters/vllm.js');
    const model = {
      id: 'local',
      modelId: 'm',
      url: 'http://localhost/v1/chat/completions',
      provider: 'local',
      contentMarking: { textWatermark: { scheme: 'vllm-gumbel', keyGroup: 'k', perRequest: true } }
    };
    const request = await vllm.createCompletionRequest(
      model,
      [{ role: 'user', content: 'hi' }],
      null,
      {
        watermarking: false,
        extra_body: { watermarking: false }
      }
    );
    assert.equal(request.body.watermarking, true);
    assert.equal(request.body.extra_body, undefined);
  });
});

describe('text signpost', () => {
  it('round-trips through the independent c2pa-text implementation', async () => {
    const { embedManifest, extractManifest } = await import('c2pa-text');
    const payload = Buffer.from('signpost payload é', 'utf8');
    const ours = `Some text.${signpost.encodeWrapper(payload)}`;
    const theirs = extractManifest(ours);
    assert.equal(Buffer.from(theirs.manifest).toString('utf8'), 'signpost payload é');
    assert.equal(theirs.cleanText, 'Some text.');
    const back = signpost.extractWrapper(embedManifest('Other text.', new Uint8Array(payload)));
    assert.equal(back.payload.toString('utf8'), 'signpost payload é');
    assert.equal(back.cleanText, 'Other text.');
  });

  it('signs, verifies and detects edits', async () => {
    const text = 'The answer is forty-two, as computed by a very large machine.';
    const signed = await signpost.applyTextSignpost(text, { contentId: 'prv_testtesttest' });
    assert.notEqual(signed, text);
    assert.equal(signed.startsWith(text), true);
    const ok = await signpost.verifyTextSignpost(signed);
    assert.equal(ok.found && ok.valid && ok.intact && ok.trusted, true);
    assert.equal(ok.payload.cid, 'prv_testtesttest');
    const edited = await signpost.verifyTextSignpost(signed.replace('forty-two', 'forty-three'));
    assert.equal(edited.intact, false);
    assert.equal((await signpost.verifyTextSignpost(text)).found, false);
  });

  it('follows the platform and app switches', () => {
    const cfg = { text: { signpost: { exports: true, clipboard: false } } };
    assert.equal(signpost.signpostEnabled('exports', cfg, null), true);
    assert.equal(signpost.signpostEnabled('clipboard', cfg, null), false);
    assert.equal(
      signpost.signpostEnabled('exports', cfg, {
        aiTransparency: { signpost: { exports: false } }
      }),
      false
    );
  });
});
