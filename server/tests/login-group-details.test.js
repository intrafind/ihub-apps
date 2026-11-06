// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Specs for the groups a login records in its audit entry (issue #3332).
 *
 * Admins could not see which groups an Entra/OIDC user got from the identity
 * provider: the groups arrive in the token at every login and are mapped at
 * runtime, but nothing kept them. Each login through an external provider now
 * writes them into the `details` of its login audit entry — the groups the
 * provider sent, the iHub groups each one mapped to, and the groups an admin
 * assigned by hand — and the audit log opens that entry in a detail view.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The audit log writes below CONTENTS_DIR, which is read when the config loads.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-login-groups-')));
process.env.CONTENTS_DIR = path.join(ROOT, 'contents');
const AUDIT_DIR = path.join(ROOT, 'contents', 'data', 'audit-log');

const { default: configCache } = await import('../configCache.js');
const { buildLoginGroupDetails, MAX_EXTERNAL_GROUPS } =
  await import('../utils/loginGroupDetails.js');
const { validateAndPersistExternalUser } = await import('../utils/userManager.js');
const { logAudit, flushAuditLog, queryAuditLog } = await import('../services/AuditLogService.js');
const { validateAuditEntry } = await import('../validators/auditEntrySchema.js');

const GROUPS = {
  groups: {
    admins: {
      id: 'admins',
      name: 'Admins',
      permissions: { adminAccess: true },
      mappings: ['entra-admins-guid']
    },
    users: {
      id: 'users',
      name: 'Users',
      mappings: ['entra-staff-guid', 'entra-admins-guid']
    },
    authenticated: { id: 'authenticated', name: 'Authenticated', mappings: [] },
    finance: { id: 'finance', name: 'Finance', mappings: [] }
  }
};

const baseDir = ROOT;
const originals = {};

before(() => {
  originals.getGroups = configCache.getGroups;
  originals.getPlatform = configCache.getPlatform;
  configCache.getGroups = () => ({ data: GROUPS });
});

after(async () => {
  configCache.getGroups = originals.getGroups;
  configCache.getPlatform = originals.getPlatform;
  await fsp.rm(ROOT, { recursive: true, force: true });
});

/** Write a scratch users.json holding these records and return its path. */
function seed(users = {}) {
  const dir = fs.mkdtempSync(path.join(baseDir, 'users-'));
  const file = path.join(dir, 'users.json');
  fs.writeFileSync(file, JSON.stringify({ users, metadata: { version: '2.0.0' } }), 'utf8');
  return file;
}

describe('buildLoginGroupDetails', () => {
  it('pairs each provider group with the iHub groups it maps to', () => {
    const details = buildLoginGroupDetails({
      external: ['entra-admins-guid', 'entra-staff-guid', 'unknown-guid'],
      manual: ['finance']
    });

    assert.deepEqual(details, {
      groups: {
        external: [
          { name: 'entra-admins-guid', mappedTo: ['admins', 'users'] },
          { name: 'entra-staff-guid', mappedTo: ['users'] },
          { name: 'unknown-guid', mappedTo: [] }
        ],
        manual: ['finance']
      }
    });
  });

  it('drops duplicates and non-string values', () => {
    const details = buildLoginGroupDetails({
      external: ['entra-staff-guid', 'entra-staff-guid', '', null, 42],
      manual: ['finance', 'finance', undefined]
    });
    assert.deepEqual(details.groups.external, [{ name: 'entra-staff-guid', mappedTo: ['users'] }]);
    assert.deepEqual(details.groups.manual, ['finance']);
  });

  it('caps the provider groups and keeps the total', () => {
    const many = Array.from({ length: MAX_EXTERNAL_GROUPS + 25 }, (_, i) => `group-${i}`);
    const details = buildLoginGroupDetails({ external: many, manual: [] });
    assert.equal(details.groups.external.length, MAX_EXTERNAL_GROUPS);
    assert.equal(details.groups.externalTotal, MAX_EXTERNAL_GROUPS + 25);
  });

  it('does not treat inherited object keys as mappings', () => {
    const details = buildLoginGroupDetails({ external: ['constructor', 'toString'] });
    assert.deepEqual(
      details.groups.external.map(g => g.mappedTo),
      [[], []]
    );
  });

  it('records nothing when the login carried no group information', () => {
    assert.equal(buildLoginGroupDetails(undefined), undefined);
    assert.equal(buildLoginGroupDetails(null), undefined);
  });
});

describe('validateAndPersistExternalUser loginGroups', () => {
  const platformFor = file => ({
    localAuth: { enabled: true, usersFile: file },
    oidcAuth: { enabled: true, allowSelfSignup: true },
    ldapAuth: { enabled: true, allowSelfSignup: true }
  });

  // The admin rescue looks at the live platform config to decide whether the
  // local admin below can still sign in.
  beforeEach(() => {
    configCache.getPlatform = () => ({ localAuth: { enabled: true } });
  });

  it('keeps the raw token groups and the manual groups of an existing OIDC user', async () => {
    const file = seed({
      user_1: {
        id: 'user_1',
        username: 'alice@example.com',
        email: 'alice@example.com',
        name: 'Alice',
        active: true,
        authMethods: ['oidc'],
        internalGroups: ['finance'],
        oidcData: { subject: 'alice-sub', provider: 'entra' }
      },
      user_2: {
        id: 'user_2',
        username: 'root',
        active: true,
        authMethods: ['local'],
        internalGroups: ['admins']
      }
    });

    const user = await validateAndPersistExternalUser(
      {
        id: 'alice-sub',
        email: 'alice@example.com',
        name: 'Alice',
        provider: 'entra',
        authMethod: 'oidc',
        groups: ['authenticated'],
        externalGroups: ['entra-staff-guid', 'unknown-guid']
      },
      platformFor(file)
    );

    assert.deepEqual(user.loginGroups, {
      external: ['entra-staff-guid', 'unknown-guid'],
      manual: ['finance']
    });
    // Authorization is unchanged: mapped + automatic + manual.
    assert.deepEqual([...user.groups].sort(), ['authenticated', 'finance', 'users']);

    // Nothing of it is written to users.json.
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')).users.user_1;
    assert.equal(stored.loginGroups, undefined);
    assert.equal(stored.externalGroups, undefined);
    assert.deepEqual(stored.internalGroups, ['finance']);
  });

  it('lists the admin group the first-user rescue just granted as manual', async () => {
    const file = seed({
      user_1: {
        id: 'user_1',
        username: 'alice@example.com',
        email: 'alice@example.com',
        active: true,
        authMethods: ['oidc'],
        internalGroups: [],
        oidcData: { subject: 'alice-sub', provider: 'entra' }
      }
    });

    const user = await validateAndPersistExternalUser(
      {
        id: 'alice-sub',
        email: 'alice@example.com',
        provider: 'entra',
        authMethod: 'oidc',
        groups: ['authenticated'],
        externalGroups: ['entra-staff-guid']
      },
      platformFor(file)
    );

    assert.deepEqual(user.loginGroups.manual, ['admins']);
  });

  it('takes the directory groups of an LDAP login, which maps them itself', async () => {
    const file = seed({
      user_9: { id: 'user_9', username: 'root', active: true, internalGroups: ['admins'] }
    });

    const user = await validateAndPersistExternalUser(
      {
        id: 'bob',
        username: 'bob',
        name: 'Bob',
        authMethod: 'ldap',
        provider: 'corp-ldap',
        groups: ['users', 'authenticated'],
        ldapData: { subject: 'bob', provider: 'corp-ldap', ldapGroups: ['CN=Staff'] }
      },
      platformFor(file)
    );

    assert.deepEqual(user.loginGroups, { external: ['CN=Staff'], manual: [] });
  });
});

describe('login audit entry details', () => {
  beforeEach(() => {
    fs.rmSync(AUDIT_DIR, { recursive: true, force: true });
    configCache.getPlatform = () => ({ audit: {} });
  });

  afterEach(async () => {
    await flushAuditLog().catch(() => {});
  });

  it('stores the group breakdown on the entry and passes schema validation', () => {
    const details = buildLoginGroupDetails({
      external: ['entra-admins-guid'],
      manual: []
    });
    const entry = logAudit({
      action: 'login',
      resource: 'auth',
      resourceId: 'user_1',
      actor: { id: 'user_1', username: 'alice', groups: ['admins', 'users'], authenticated: true },
      details
    });

    assert.deepEqual(entry.details, details);
    assert.equal(validateAuditEntry(entry).success, true);
  });

  it('leaves out empty, non-object and oversized details', () => {
    const base = { action: 'login', resource: 'auth', actor: { id: 'u', authenticated: true } };
    assert.equal('details' in logAudit({ ...base }), false);
    assert.equal('details' in logAudit({ ...base, details: {} }), false);
    assert.equal('details' in logAudit({ ...base, details: ['a'] }), false);
    assert.equal('details' in logAudit({ ...base, details: 'text' }), false);
    const huge = { blob: 'x'.repeat(70 * 1024) };
    assert.equal('details' in logAudit({ ...base, details: huge }), false);
  });

  it('finds a login by a provider group in the free-text search', async () => {
    logAudit({
      action: 'login',
      resource: 'auth',
      actor: { id: 'user_1', username: 'alice', authenticated: true },
      details: buildLoginGroupDetails({ external: ['3f2a-entra-guid'], manual: [] })
    });
    logAudit({
      action: 'login',
      resource: 'auth',
      actor: { id: 'user_2', username: 'bob', authenticated: true }
    });

    const { entries, total } = await queryAuditLog({ q: '3F2A-ENTRA' });
    assert.equal(total, 1);
    assert.equal(entries[0].actor.id, 'user_1');
    assert.equal(entries[0].details.groups.external[0].name, '3f2a-entra-guid');
  });
});
