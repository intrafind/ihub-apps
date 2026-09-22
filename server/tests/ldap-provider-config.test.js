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
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
