// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * People directory search (#3026): loading trust anchors, the shipped BSI
 * root, and the shipped defaults (the disabled x500bund entry and the "People
 * search" app).
 *
 * The BSI root is checked by signature only, not with a dated handshake, so
 * the test does not break when the x500.bund.de server certificate expires.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCertificates, hasOpenssl } from './fakeLdapServer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..', '..');
const defaultsDir = path.join(serverDir, 'defaults');

// The store lives in the contents directory; give it a throwaway one before
// any module reads CONTENTS_DIR.
const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-dir-contents-'));
process.env.CONTENTS_DIR = contentsDir;

const { peopleDirectoriesFileSchema, peopleDirectorySchema } =
  await import('../../validators/peopleDirectorySchema.js');
const { appConfigSchema } = await import('../../validators/appConfigSchema.js');
const certStore = await import('../../services/peopleDirectory/certStore.js');
const { copyDefaultConfiguration } = await import('../../utils/setupUtils.js');

/** Published by the BSI for PCA-1-Verwaltung-23. */
const BSI_ROOT_FINGERPRINT =
  '1D:32:84:79:E1:65:FD:36:FB:C2:7E:1D:53:11:68:D1:3D:60:D6:6F:A1:9B:1B:81:80:36:C2:68:2D:18:DD:D4';

/** The intermediate x500.bund.de sends ("CA IVBB Deutsche Telekom AG 23"), public. */
const IVBB_INTERMEDIATE = `-----BEGIN CERTIFICATE-----
MIIG4jCCBMqgAwIBAgIFAPj6MKcwDQYJKoZIhvcNAQELBQAwRjELMAkGA1UEBhMC
REUxGTAXBgNVBAoTEFBLSS0xLVZlcndhbHR1bmcxHDAaBgNVBAMTE1BDQS0xLVZl
cndhbHR1bmctMjMwHhcNMjMxMTI3MDAwMDAwWhcNMjkxMTI4MjM1OTU5WjBgMQsw
CQYDVQQGEwJERTEZMBcGA1UEChMQUEtJLTEtVmVyd2FsdHVuZzENMAsGA1UECxME
QnVuZDEnMCUGA1UEAxMeQ0EgSVZCQiBEZXV0c2NoZSBUZWxla29tIEFHIDIzMIIC
IjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA3E7X2u84nmmo6Erh1IfO8pyJ
07TjkyfGXEOJ28993qITaz89Hw+2pAbNazE7SVopru5l/C/mBZyJuZMKlpekq8DG
2I2HxuGpm+lxj59T3vSdjuW8iesQJTZVxFrlb0ZEa1ZYrmnsnVRlAfDxxePnAvkQ
w+SjPVaJ+JgnjpPCdM3x6iG12du10D3zuVaCJWdJkh//18T5yCwDY0aMQYIynmtm
FDvtH/yEIGBj3v2J/4fBxDICwZSC9bwRDUMAxNWneCddkJXh/8yTMa8WI4EURxI9
ulFkZVn8HBVQDylD3UNjCx1xd1Xf61M+JcG2DnuosHRDqMR+wiZA5bxB9E6UGJAh
1WbzRLNzQcLjiHahiRBFUeeQfmjenzSZ799fSsfZpdc8nMYRlV6w7Chl9M96tgvO
rkJnPoDaK0x+hQveqUyL0WITPB2xenMKgwMuXq3HIGVf5ybjIcKN1gwT6v8TQ75a
VPyifD8ysC6X0qGNaJINrMRbHMSA1Uw/iwTs0mgxnS4cFCU0S4V3HCtdQKLfZjU2
nSzjm3P4cF6jFZV9cZ4J+puOjTmSzTxKAWNPWcjFael1eSym5Y2kChGsFRfrrCqS
mNYoav1I/K6XhmYL5DprQbqUfRyRQdw23Le90gK90nHR6NzsUmNOOD46DTascH85
rFTl6dWBINLNyZvh0JsCAwEAAaOCAbswggG3MBIGA1UdEwEB/wQIMAYBAf8CAQMw
PwYDVR0gBDgwNjA0BgsEAH8ABwMGAQEDAzAlMCMGCCsGAQUFBwIBFhdodHRwczov
L3d3dy5ic2kuYnVuZC5kZTAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFNsQxW6L
5CFc1cPEcoN17L5Sx3eDMHIGA1UdIwRrMGmAFJ2BqFcYkLlZ9LOTo6q+LLqE9BnG
oUqkSDBGMQswCQYDVQQGEwJERTEZMBcGA1UEChMQUEtJLTEtVmVyd2FsdHVuZzEc
MBoGA1UEAxMTUENBLTEtVmVyd2FsdHVuZy0yM4IFAKXvkjAwgbwGA1UdHwSBtDCB
sTBioGCgXoZcbGRhcDovL3g1MDAuYnVuZC5kZS9DTj1QQ0EtMS1WZXJ3YWx0dW5n
LTIzLE89UEtJLTEtVmVyd2FsdHVuZyxDPURFP2NlcnRpZmljYXRlUmV2b2NhdGlv
bkxpc3QwS6BJoEeGRWh0dHA6Ly94NTAwLmJ1bmQuZGUvY2dpLWJpbi9zaG93X2F0
dHI/Y249UENBLTEtVmVyd2FsdHVuZy0yMyZhdHRyPWNybDANBgkqhkiG9w0BAQsF
AAOCAgEAR7JgN9IjDfA6To2GHLrnMDjX5yZelXrWNVuQ5ahDh0YKcP1ICkMs6Q71
I1WHWMthB3Ufn1Thi7qx3mvACuAJvksl1/SLqk1oCriV+lPeR8Cx5cpVuXwq1I+5
uYpeu/mXzWLscLYr0H/A0q2At+Abtiga9ybQORmge7lbvhgOa3aWYH/npULQguO+
M07hXHb3pSdZioztSH7vTrRFjlifgMN9sdU5N8p9vWdrDMZcSUMutguCpUGKkQ+o
y7kzNr00dHrFqpUhtvZupQPwtZlHqeBaH9+NCoXHkVoJ8IqNhW+cfCQ2IPEcyyyg
9nir8FdbjF68LJOo9ZRdiKzXMn4XSqgJFGjZmzlAXZIFGqkcEEC3fT71qoof5R21
xJKgPNvZBGlQ4YxPReWJqMz60ZBdJgSHnGBg0glhKRveSIEUiXmYY3/dqzoHalFj
a2vig5WB3mqF1M0K/s6kyAGqkstagx223yUCV7yq1z90OnNCcp/ri+KnQL2qYjV3
atpOXaxtaL6SSWYs0xbdNphHf8qtu0f6eLWhSkReNw7zPPPLMY5KJGR7CgF7DNdO
xDAlal/lRQftw06QDsqD4571DovcCpK6n/9eJjEo6RhxoCr431DU6bVi9MUtn/o8
ZGgUBD0e5qGv050R0X831tCEZJxl7428Wdlzk+3FMyykJJ0JLX4=
-----END CERTIFICATE-----
`;

after(() => fs.rmSync(contentsDir, { recursive: true, force: true }));

describe('shipped BSI root PCA-1-Verwaltung-23', () => {
  const root = new X509Certificate(
    fs.readFileSync(path.join(defaultsDir, 'config', 'certs', 'pca-1-verwaltung-23.pem'))
  );

  it('has the fingerprint and serial the BSI publishes', () => {
    assert.equal(root.fingerprint256, BSI_ROOT_FINGERPRINT);
    assert.equal(root.serialNumber, 'A5EF9230');
    assert.equal(root.ca, true);
    assert.match(root.subject, /CN=PCA-1-Verwaltung-23/);
  });

  it('signed the intermediate that x500.bund.de sends', () => {
    const intermediate = new X509Certificate(IVBB_INTERMEDIATE);
    assert.equal(intermediate.checkIssued(root), true);
    assert.equal(intermediate.verify(root.publicKey), true);
  });

  it('is what the shipped x500bund entry trusts', () => {
    const file = JSON.parse(
      fs.readFileSync(path.join(defaultsDir, 'config', 'peopleDirectories.json'), 'utf8')
    );
    const x500 = file.directories.find(directory => directory.id === 'x500bund');
    assert.deepEqual(x500.tlsCa, ['pca-1-verwaltung-23']);
    assert.equal(x500.url, 'ldaps://x500.bund.de:636');
    assert.equal(x500.enabled, false);
    assert.equal(x500.dataFlow, 'external');
    assert.ok(peopleDirectoriesFileSchema.safeParse(file).success);
  });
});

describe('certificate store', { skip: !hasOpenssl() && 'openssl CLI not available' }, () => {
  let certs;
  before(() => {
    certs = generateCertificates('store.test');
  });

  it('loads named trust anchors from contents/config/certs', async () => {
    const dir = path.join(contentsDir, 'config', 'certs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'test-root.pem'), certs.rootPem);
    fs.writeFileSync(path.join(dir, 'broken.pem'), 'not a certificate');
    const [anchor] = await certStore.loadTrustAnchors(['test-root']);
    assert.equal(
      new X509Certificate(anchor).fingerprint256,
      new X509Certificate(certs.rootPem).fingerprint256
    );
    await assert.rejects(certStore.loadTrustAnchors(['missing']), { code: 'trust_anchor_missing' });
    await assert.rejects(certStore.loadTrustAnchors(['broken']), { code: 'trust_anchor_missing' });
  });

  it('never reads outside the store for a name with path characters', async () => {
    for (const name of ['../platform', 'a/b', 'A-Root', 'x.pem', '', '..']) {
      await assert.rejects(certStore.loadTrustAnchors([name]), { code: 'trust_anchor_missing' });
    }
    const parsed = peopleDirectorySchema.safeParse({
      id: 'corp',
      url: 'ldaps://a.example',
      baseDn: 'o=a',
      tlsCa: ['../../config/platform']
    });
    assert.equal(parsed.success, false);
  });
});

describe('schema', () => {
  const base = { id: 'corp', url: 'ldaps://a.example', baseDn: 'o=a' };

  it('rejects every TLS option except minVersion, maxVersion and ciphers', () => {
    for (const tlsOptions of [
      { rejectUnauthorized: false },
      { checkServerIdentity: 'x' },
      { ca: 'x' },
      { servername: 'x' }
    ]) {
      assert.equal(peopleDirectorySchema.safeParse({ ...base, tlsOptions }).success, false);
    }
    assert.equal(
      peopleDirectorySchema.safeParse({
        ...base,
        tlsOptions: { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3', ciphers: 'HIGH' }
      }).success,
      true
    );
  });

  it('rejects ids that would collide with tool id parsing, and the reserved reference', () => {
    for (const id of ['corp_ad', 'Corp', 'a', '-corp', 'x'.repeat(33)]) {
      assert.equal(peopleDirectorySchema.safeParse({ ...base, id }).success, false, id);
    }
    assert.equal(peopleDirectorySchema.safeParse({ ...base, id: 'corp-ad' }).success, true);
    assert.equal(
      peopleDirectoriesFileSchema.safeParse({ directories: [base, { ...base }] }).success,
      false
    );
  });

  it('rejects inline passwords and mappings onto secret attributes', () => {
    assert.equal(peopleDirectorySchema.safeParse({ ...base, password: 'x' }).success, false);
    assert.equal(
      peopleDirectorySchema.safeParse({
        ...base,
        bind: { mode: 'service', dn: 'cn=svc', passwordRef: 'svc', password: 'x' }
      }).success,
      false
    );
    assert.equal(
      peopleDirectorySchema.safeParse({ ...base, attributeMapping: { email: 'userPassword' } })
        .success,
      false
    );
    assert.equal(
      peopleDirectorySchema.safeParse({ ...base, searchAttributes: ['jpegPhoto'] }).success,
      false
    );
  });

  it('requires URL and base DN without a sign-in provider, and maxResults from 1 to 50', () => {
    assert.equal(peopleDirectorySchema.safeParse({ id: 'corp' }).success, false);
    assert.equal(peopleDirectorySchema.safeParse({ id: 'corp', authProvider: 'ad' }).success, true);
    assert.equal(
      peopleDirectorySchema.safeParse({ ...base, url: 'https://a.example' }).success,
      false
    );
    for (const maxResults of [0, 51, 2.5]) {
      assert.equal(peopleDirectorySchema.safeParse({ ...base, maxResults }).success, false);
    }
  });
});

describe('shipped People search app', () => {
  const appFile = path.join(defaultsDir, 'apps', 'people-directory.json');

  it('passes the app schema, waits for a directory and selects every directory', () => {
    const app = JSON.parse(fs.readFileSync(appFile, 'utf8'));
    const parsed = appConfigSchema.safeParse(app);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    // Shipped on, but users get it only once a directory is configured
    assert.equal(app.enabled, true);
    assert.deepEqual(app.requiredIntegrations, ['peopleDirectories']);
    assert.deepEqual(app.tools, ['peopleDirectories']);
    assert.ok(app.system.en && app.system.de);
  });

  it('is copied into an existing contents directory on startup, without touching other files', async () => {
    const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'people-dir-existing-'));
    try {
      fs.mkdirSync(path.join(existing, 'apps'), { recursive: true });
      fs.writeFileSync(path.join(existing, 'apps', 'chat.json'), '{"id":"chat","custom":true}');
      await copyDefaultConfiguration({ defaultsPath: defaultsDir, contentsPath: existing });
      assert.ok(fs.existsSync(path.join(existing, 'apps', 'people-directory.json')));
      assert.ok(fs.existsSync(path.join(existing, 'config', 'peopleDirectories.json')));
      assert.ok(fs.existsSync(path.join(existing, 'config', 'certs', 'pca-1-verwaltung-23.pem')));
      assert.equal(
        fs.readFileSync(path.join(existing, 'apps', 'chat.json'), 'utf8'),
        '{"id":"chat","custom":true}'
      );
    } finally {
      fs.rmSync(existing, { recursive: true, force: true });
    }
  });
});
