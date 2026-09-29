/**
 * Tests for the LDAP provider derivation in `utils/ldapProviderConfig.js`
 * (issue #2442).
 *
 * The point of the module is that a provider can name a directory root once
 * instead of repeating it inside three DNs. These tests pin down both halves of
 * that: what an under-specified provider resolves to, and that a provider
 * written the old way — every field explicit, no `baseDn`, no `preset` —
 * resolves exactly as it did before, including group search staying off when
 * nothing points at a group base.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { authenticateResult } from 'ldap-authentication';
import {
  LDAP_PRESETS,
  buildLdapAuthOptions,
  describeLdapProvider,
  extractGroupNames,
  mapLdapUserAttributes,
  resolveLdapProvider
} from '../utils/ldapProviderConfig.js';

describe('resolveLdapProvider', () => {
  it('derives the search bases and the DN template from a single base DN', () => {
    const resolved = resolveLdapProvider({
      name: 'corp',
      url: 'ldap://ldap.example.com:389',
      baseDn: 'dc=example,dc=org'
    });

    assert.equal(resolved.userSearchBase, 'dc=example,dc=org');
    assert.equal(resolved.groupSearchBase, 'dc=example,dc=org');
    assert.equal(resolved.userDn, 'uid={{username}},dc=example,dc=org');
    assert.equal(resolved.usernameAttribute, 'uid');
    assert.equal(resolved.groupClass, 'groupOfNames');
  });

  it('applies the Active Directory preset to the attributes that differ', () => {
    const resolved = resolveLdapProvider({
      name: 'ad',
      url: 'ldap://ad.example.com:389',
      preset: 'activeDirectory',
      baseDn: 'dc=example,dc=com'
    });

    assert.equal(resolved.usernameAttribute, 'sAMAccountName');
    assert.equal(resolved.groupClass, 'group');
    assert.equal(resolved.userDn, 'sAMAccountName={{username}},dc=example,dc=com');
    assert.deepEqual(resolved.attributeMapping.email, ['mail', 'userPrincipalName']);
  });

  it('lets an explicit value win over the preset and the base DN', () => {
    const resolved = resolveLdapProvider({
      name: 'mixed',
      url: 'ldap://ldap.example.com:389',
      preset: 'activeDirectory',
      baseDn: 'dc=example,dc=com',
      userSearchBase: 'ou=staff,dc=example,dc=com',
      usernameAttribute: 'uid',
      userDn: '{{username}}@example.com',
      groupSearchBase: 'ou=groups,dc=example,dc=com',
      groupClass: 'groupOfNames'
    });

    assert.equal(resolved.userSearchBase, 'ou=staff,dc=example,dc=com');
    assert.equal(resolved.usernameAttribute, 'uid');
    assert.equal(resolved.userDn, '{{username}}@example.com');
    assert.equal(resolved.groupSearchBase, 'ou=groups,dc=example,dc=com');
    assert.equal(resolved.groupClass, 'groupOfNames');
  });

  it('keeps group search off for a provider that names no group base', () => {
    // The pre-existing behaviour: without groupSearchBase the login path never
    // ran a group search. Deriving one from a base DN that was never configured
    // would silently start one.
    const resolved = resolveLdapProvider({
      name: 'legacy',
      url: 'ldap://ldap.example.com:389',
      userSearchBase: 'ou=people,dc=example,dc=org'
    });

    assert.equal(resolved.groupSearchBase, '');
    const options = buildLdapAuthOptions(resolved, { username: 'jdoe', password: 'secret' });
    assert.equal(options.groupsSearchBase, undefined);
    assert.equal(options.groupClass, undefined);
  });

  it('falls back to the provider name for the display name', () => {
    assert.equal(resolveLdapProvider({ name: 'corp' }).displayName, 'corp');
    assert.equal(resolveLdapProvider({ name: 'corp', displayName: 'Corp' }).displayName, 'Corp');
  });

  it('accepts a single attribute name as an attribute mapping', () => {
    const resolved = resolveLdapProvider({
      name: 'corp',
      baseDn: 'dc=example,dc=org',
      attributeMapping: { email: 'userPrincipalName', id: ['employeeNumber', 'uid'] }
    });

    assert.deepEqual(resolved.attributeMapping.email, ['userPrincipalName']);
    assert.deepEqual(resolved.attributeMapping.id, ['employeeNumber', 'uid']);
    // Untouched slots still come from the preset.
    assert.deepEqual(resolved.attributeMapping.name, LDAP_PRESETS.openldap.attributeMapping.name);
  });
});

describe('describeLdapProvider', () => {
  it('reports where every effective value came from', () => {
    const { fields } = describeLdapProvider({
      name: 'corp',
      url: 'ldap://ldap.example.com:389',
      baseDn: 'dc=example,dc=org',
      groupClass: 'posixGroup'
    });
    const byKey = Object.fromEntries(fields.map(field => [field.key, field]));

    assert.equal(byKey.userSearchBase.source, 'baseDn');
    assert.equal(byKey.userDn.source, 'derived');
    assert.equal(byKey.usernameAttribute.source, 'preset');
    assert.equal(byKey.groupClass.source, 'explicit');
    assert.equal(byKey.groupClass.value, 'posixGroup');
  });

  it('flags a provider that can never find a user', () => {
    const { problems } = describeLdapProvider({ name: 'broken' });
    assert.equal(problems.length, 2);
    assert.match(problems.join(' '), /URL/);
    assert.match(problems.join(' '), /user search base/);
  });

  it('flags a bind DN without a bind password credential', () => {
    const { problems } = describeLdapProvider({
      name: 'corp',
      url: 'ldap://ldap.example.com:389',
      baseDn: 'dc=example,dc=org',
      adminDn: 'cn=admin,dc=example,dc=org'
    });
    assert.match(problems.join(' '), /bind password/);
  });

  it('warns when no group search will run', () => {
    const { warnings } = describeLdapProvider({
      name: 'corp',
      url: 'ldap://ldap.example.com:389',
      userSearchBase: 'ou=people,dc=example,dc=org',
      adminDn: 'cn=admin,dc=example,dc=org',
      adminPasswordRef: 'ldap_corp'
    });
    assert.match(warnings.join(' '), /no LDAP groups are read/);
  });

  describe('transport encryption', () => {
    const base = { name: 'corp', baseDn: 'dc=example,dc=org' };
    const plainTextWarning = /not encrypted/;

    it('warns that an ldap:// connection without StartTLS sends passwords in plain text', () => {
      const { warnings } = describeLdapProvider({ ...base, url: 'ldap://ldap.example.com:389' });
      assert.match(warnings.join(' '), plainTextWarning);
    });

    it('does not warn once StartTLS is enabled', () => {
      const { warnings } = describeLdapProvider({
        ...base,
        url: 'ldap://ldap.example.com:389',
        starttls: true
      });
      assert.doesNotMatch(warnings.join(' '), plainTextWarning);
    });

    it('does not warn for ldaps://', () => {
      const { warnings } = describeLdapProvider({ ...base, url: 'ldaps://ldap.example.com:636' });
      assert.doesNotMatch(warnings.join(' '), plainTextWarning);
      assert.doesNotMatch(warnings.join(' '), /StartTLS/);
    });

    it('leaves a non-LDAP URL to the URL check', () => {
      const { warnings } = describeLdapProvider({ ...base, url: 'https://ldap.example.com' });
      assert.doesNotMatch(warnings.join(' '), plainTextWarning);
    });

    it('says that StartTLS is ignored for ldaps://', () => {
      const { warnings } = describeLdapProvider({
        ...base,
        url: 'ldaps://ldap.example.com:636',
        starttls: true
      });
      assert.match(warnings.join(' '), /StartTLS is ignored/);
    });
  });
});

describe('buildLdapAuthOptions', () => {
  const resolved = resolveLdapProvider({
    name: 'corp',
    url: 'ldaps://ldap.example.com:636',
    baseDn: 'dc=example,dc=org',
    adminDn: 'cn=admin,dc=example,dc=org',
    tlsOptions: { rejectUnauthorized: false }
  });

  it('binds with the service account when a password is available', () => {
    const options = buildLdapAuthOptions(resolved, {
      username: 'jdoe',
      password: 'secret',
      adminPassword: 'bind-secret'
    });

    assert.equal(options.adminDn, 'cn=admin,dc=example,dc=org');
    assert.equal(options.adminPassword, 'bind-secret');
    assert.equal(options.userPassword, 'secret');
    assert.equal(options.ldapOpts.url, 'ldaps://ldap.example.com:636');
    assert.deepEqual(options.ldapOpts.tlsOptions, { rejectUnauthorized: false });
    assert.equal(options.groupsSearchBase, 'dc=example,dc=org');
  });

  it('keeps the service account selected when its password came back empty', () => {
    // So the library reports `adminPassword` as missing, rather than falling
    // back to a direct user bind and failing for an unrelated-looking reason.
    const options = buildLdapAuthOptions(resolved, { username: 'jdoe', password: 'secret' });
    assert.equal(options.adminDn, 'cn=admin,dc=example,dc=org');
    assert.equal(options.adminPassword, undefined);
  });

  it('binds the user directly when no service account is configured', () => {
    const withoutAdmin = resolveLdapProvider({
      name: 'corp',
      url: 'ldap://ldap.example.com:389',
      baseDn: 'dc=example,dc=org'
    });
    const options = buildLdapAuthOptions(withoutAdmin, { username: 'jdoe', password: 'secret' });
    assert.equal(options.adminDn, undefined);
    assert.equal(options.userDn, 'uid={{username}},dc=example,dc=org');
  });

  it('looks a user up without a password in verifyUserExists mode', () => {
    const options = buildLdapAuthOptions(resolved, {
      username: 'jdoe',
      adminPassword: 'bind-secret',
      verifyUserExists: true
    });

    assert.equal(options.verifyUserExists, true);
    assert.ok(!('userPassword' in options));
  });

  it('leaves StartTLS off unless the provider asks for it', () => {
    const plain = resolveLdapProvider({
      name: 'corp',
      url: 'ldap://ldap.example.com:389',
      baseDn: 'dc=example,dc=org'
    });
    const options = buildLdapAuthOptions(plain, { username: 'jdoe', password: 'secret' });
    assert.ok(!('starttls' in options));
    assert.ok(!('tlsOptions' in options.ldapOpts));
  });

  it('enables StartTLS and names the directory host for the certificate check', () => {
    const startTls = resolveLdapProvider({
      name: 'corp',
      url: 'ldap://ldap.example.com:389',
      baseDn: 'dc=example,dc=org',
      starttls: true,
      tlsOptions: { rejectUnauthorized: false }
    });
    const options = buildLdapAuthOptions(startTls, { username: 'jdoe', password: 'secret' });

    assert.equal(options.starttls, true);
    // Without `host`, Node checks the upgraded socket's certificate against
    // "localhost" (see the end-to-end test below).
    assert.deepEqual(options.ldapOpts.tlsOptions, {
      host: 'ldap.example.com',
      servername: 'ldap.example.com',
      rejectUnauthorized: false
    });
    // The provider's own config object is not modified.
    assert.deepEqual(startTls.tlsOptions, { rejectUnauthorized: false });
  });

  it('sends no SNI server name when the directory is addressed by IP', () => {
    const byIp = resolveLdapProvider({
      name: 'corp',
      url: 'ldap://10.0.0.5:389',
      baseDn: 'dc=example,dc=org',
      starttls: true
    });
    const options = buildLdapAuthOptions(byIp, { username: 'jdoe', password: 'secret' });
    assert.deepEqual(options.ldapOpts.tlsOptions, { host: '10.0.0.5' });
  });

  it('lets explicit tlsOptions override the derived host and server name', () => {
    const explicit = resolveLdapProvider({
      name: 'corp',
      url: 'ldap://10.0.0.5:389',
      baseDn: 'dc=example,dc=org',
      starttls: true,
      tlsOptions: { servername: 'ldap.example.com', host: 'ldap.example.com' }
    });
    const options = buildLdapAuthOptions(explicit, { username: 'jdoe', password: 'secret' });
    assert.deepEqual(options.ldapOpts.tlsOptions, {
      host: 'ldap.example.com',
      servername: 'ldap.example.com'
    });
  });

  it('ignores StartTLS for ldaps://', () => {
    const ldaps = resolveLdapProvider({
      name: 'corp',
      url: 'ldaps://ldap.example.com:636',
      baseDn: 'dc=example,dc=org',
      starttls: true,
      tlsOptions: { rejectUnauthorized: false }
    });
    const options = buildLdapAuthOptions(ldaps, { username: 'jdoe', password: 'secret' });
    assert.ok(!('starttls' in options));
    assert.deepEqual(options.ldapOpts.tlsOptions, { rejectUnauthorized: false });
  });
});

describe('mapLdapUserAttributes', () => {
  const openldap = resolveLdapProvider({ name: 'corp', baseDn: 'dc=example,dc=org' });

  it('maps the usual OpenLDAP attributes and reports which ones it used', () => {
    const mapped = mapLdapUserAttributes(
      { uid: 'jdoe', displayName: 'Jane Doe', mail: 'jane@example.org' },
      openldap,
      'jdoe'
    );

    assert.deepEqual(
      { id: mapped.id, name: mapped.name, email: mapped.email },
      { id: 'jdoe', name: 'Jane Doe', email: 'jane@example.org' }
    );
    assert.deepEqual(mapped.usedAttributes, { id: 'uid', name: 'displayName', email: 'mail' });
  });

  it('unwraps multi-valued attributes and composes a name from givenName and sn', () => {
    const mapped = mapLdapUserAttributes(
      { uid: ['jdoe'], givenName: 'Jane', sn: 'Doe' },
      openldap,
      'jdoe'
    );

    assert.equal(mapped.id, 'jdoe');
    assert.equal(mapped.name, 'Jane Doe');
    assert.equal(mapped.email, null);
    assert.equal(mapped.usedAttributes.name, 'givenName + sn');
  });

  it('falls back to the login name when nothing matches', () => {
    const mapped = mapLdapUserAttributes({}, openldap, 'jdoe');
    assert.equal(mapped.id, 'jdoe');
    assert.equal(mapped.name, 'jdoe');
    assert.equal(mapped.usedAttributes.id, null);
  });

  it('honours an explicit mapping', () => {
    const resolved = resolveLdapProvider({
      name: 'corp',
      baseDn: 'dc=example,dc=org',
      attributeMapping: { id: 'employeeNumber', email: ['userPrincipalName', 'mail'] }
    });
    const mapped = mapLdapUserAttributes(
      { uid: 'jdoe', employeeNumber: '4711', mail: 'jane@example.org' },
      resolved,
      'jdoe'
    );

    assert.equal(mapped.id, '4711');
    assert.equal(mapped.email, 'jane@example.org');
    assert.equal(mapped.usedAttributes.email, 'mail');
  });
});

describe('extractGroupNames', () => {
  it('reads names from strings, cn values and DNs alike', () => {
    assert.deepEqual(
      extractGroupNames([
        'plain',
        { cn: 'from-cn' },
        { cn: ['first-cn', 'second-cn'] },
        { name: 'from-name' },
        { displayName: 'from-display-name' },
        { dn: 'CN=from-dn,OU=Groups,DC=example,DC=com' }
      ]),
      ['plain', 'from-cn', 'first-cn', 'from-name', 'from-display-name', 'from-dn']
    );
  });

  it('returns an empty list when the directory returned nothing', () => {
    assert.deepEqual(extractGroupNames(undefined), []);
    assert.deepEqual(extractGroupNames([]), []);
  });
});

describe('the option contract with ldap-authentication', () => {
  // The library validates its own options and throws an LdapAuthenticationError
  // listing every missing field. Pointing all three bind modes at a closed port
  // proves the options we build are complete: the only thing that fails is the
  // connection. This is what catches a renamed option (the library spells the
  // group base `groupsSearchBase`, not `groupSearchBase`).
  const base = { name: 'corp', url: 'ldap://127.0.0.1:1', baseDn: 'dc=example,dc=org' };
  const withBindAccount = resolveLdapProvider({ ...base, adminDn: 'cn=admin,dc=example,dc=org' });
  const withoutBindAccount = resolveLdapProvider(base);

  const modes = {
    'service-account bind': [
      withBindAccount,
      { username: 'jdoe', password: 'secret', adminPassword: 'bind-secret' }
    ],
    'direct user bind': [withoutBindAccount, { username: 'jdoe', password: 'secret' }],
    'lookup without a password': [
      withBindAccount,
      { username: 'jdoe', adminPassword: 'bind-secret', verifyUserExists: true }
    ]
  };

  for (const [label, [provider, callOptions]] of Object.entries(modes)) {
    it(`builds complete options for a ${label}`, async () => {
      const result = await authenticateResult(buildLdapAuthOptions(provider, callOptions));
      assert.match(result.messages.join(' '), /ECONNREFUSED/);
    });
  }
});

// A stand-in directory that speaks just enough LDAP to answer a StartTLS
// request and a bind, so the tests can watch what actually crosses the wire.
const LDAP_TAG = {
  bindRequest: 0x60,
  bindResponse: 0x61,
  extendedRequest: 0x77,
  extendedResponse: 0x78
};
const STARTTLS_OID = '1.3.6.1.4.1.1466.20037';
const INVALID_CREDENTIALS = 49;

/** BER length at `offset`: `[length, bytes the length itself took]`. */
function readBerLength(buf, offset) {
  const first = buf[offset];
  if (first < 0x80) return [first, 1];
  let length = 0;
  for (let i = 1; i <= (first & 0x7f); i++) length = length * 256 + buf[offset + i];
  return [length, 1 + (first & 0x7f)];
}

/** Message id and operation tag of an LDAPMessage. */
function parseLdapMessage(buf) {
  let offset = 1 + readBerLength(buf, 1)[1]; // SEQUENCE header
  const [idLength, idLengthBytes] = readBerLength(buf, offset + 1); // INTEGER messageID
  let messageId = 0;
  for (let i = 0; i < idLength; i++) {
    messageId = messageId * 256 + buf[offset + 1 + idLengthBytes + i];
  }
  offset += 1 + idLengthBytes + idLength;
  return { messageId, operation: buf[offset] };
}

/** An LDAPResult-shaped response (bind or extended) with the given code. */
function ldapResponse(messageId, operation, resultCode) {
  const result = Buffer.from([0x0a, 0x01, resultCode, 0x04, 0x00, 0x04, 0x00]);
  const body = Buffer.concat([
    Buffer.from([0x02, 0x01, messageId]),
    Buffer.from([operation, result.length]),
    result
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function startFakeDirectory({ key, cert }) {
  const seen = { plainText: Buffer.alloc(0), startTlsRequested: false, tls: false, bind: null };
  const sockets = new Set();

  const server = net.createServer(raw => {
    sockets.add(raw);
    raw.on('error', () => {});
    raw.once('data', chunk => {
      seen.plainText = Buffer.concat([seen.plainText, chunk]);
      const { messageId, operation } = parseLdapMessage(chunk);

      if (operation !== LDAP_TAG.extendedRequest) {
        seen.bind = { chunk, encrypted: false };
        raw.write(ldapResponse(messageId, LDAP_TAG.bindResponse, INVALID_CREDENTIALS));
        return;
      }

      seen.startTlsRequested = chunk.includes(Buffer.from(STARTTLS_OID));
      raw.write(ldapResponse(messageId, LDAP_TAG.extendedResponse, 0));
      const secure = new tls.TLSSocket(raw, { isServer: true, key, cert });
      secure.on('error', () => {});
      secure.on('secure', () => {
        seen.tls = true;
      });
      secure.once('data', bind => {
        seen.bind = { chunk: bind, encrypted: true };
        secure.write(
          ldapResponse(parseLdapMessage(bind).messageId, LDAP_TAG.bindResponse, INVALID_CREDENTIALS)
        );
      });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        seen,
        close: () =>
          new Promise(done => {
            for (const socket of sockets) socket.destroy();
            server.close(done);
          })
      })
    );
  });
}

const opensslAvailable = spawnSync('openssl', ['version']).status === 0;

describe(
  'StartTLS against a directory',
  { skip: !opensslAvailable && 'openssl is needed to issue a test certificate' },
  () => {
    let tmpDir;
    let certificates;

    /** A throwaway self-signed certificate for the given subjectAltName. */
    function issueCertificate(name, subjectAltName) {
      const keyPath = path.join(tmpDir, `${name}.key`);
      const certPath = path.join(tmpDir, `${name}.crt`);
      const { status, stderr } = spawnSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '2',
        '-subj',
        `/CN=${name}`,
        '-addext',
        `subjectAltName=${subjectAltName}`,
        '-keyout',
        keyPath,
        '-out',
        certPath
      ]);
      assert.equal(status, 0, String(stderr));
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-ldap-starttls-'));
      // Deliberately without "localhost", which is what Node checks the
      // certificate against when nobody names the host.
      certificates = {
        matching: issueCertificate('directory', 'IP:127.0.0.1'),
        otherHost: issueCertificate('elsewhere', 'DNS:ldap.elsewhere.test')
      };
    });

    after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const lookup = (port, overrides) =>
      authenticateResult(
        buildLdapAuthOptions(
          resolveLdapProvider({
            name: 'corp',
            url: `ldap://127.0.0.1:${port}`,
            baseDn: 'dc=example,dc=org',
            adminDn: 'cn=admin,dc=example,dc=org',
            ...overrides
          }),
          { username: 'jdoe', adminPassword: 'bind-secret', verifyUserExists: true }
        )
      );

    it('without StartTLS, the bind password crosses the wire in plain text', async () => {
      const directory = await startFakeDirectory(certificates.matching);
      try {
        await lookup(directory.port, {});
        assert.equal(directory.seen.bind?.encrypted, false);
        assert.ok(directory.seen.plainText.includes(Buffer.from('bind-secret')));
      } finally {
        await directory.close();
      }
    });

    it('with StartTLS, the bind happens only after a verified TLS upgrade', async () => {
      const directory = await startFakeDirectory(certificates.matching);
      try {
        const result = await lookup(directory.port, {
          starttls: true,
          tlsOptions: { ca: [certificates.matching.cert.toString()] }
        });

        assert.equal(directory.seen.startTlsRequested, true);
        assert.equal(directory.seen.tls, true);
        assert.equal(directory.seen.bind?.encrypted, true);
        assert.ok(directory.seen.bind.chunk.includes(Buffer.from('cn=admin,dc=example,dc=org')));
        assert.ok(!directory.seen.plainText.includes(Buffer.from('bind-secret')));
        // The directory's own answer (invalid credentials), not a TLS error.
        assert.doesNotMatch(result.messages.join(' '), /certificate|altname/i);
      } finally {
        await directory.close();
      }
    });

    it('rejects a certificate issued for a different host', async () => {
      const directory = await startFakeDirectory(certificates.otherHost);
      try {
        const result = await lookup(directory.port, {
          starttls: true,
          tlsOptions: { ca: [certificates.otherHost.cert.toString()] }
        });

        assert.match(result.messages.join(' '), /altname|certificate/i);
        assert.equal(directory.seen.bind, null);
      } finally {
        await directory.close();
      }
    });
  }
);
