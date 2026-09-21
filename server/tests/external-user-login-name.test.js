#!/usr/bin/env node

/**
 * Specs for the login name `createOrUpdateExternalUser` persists.
 *
 * The bug these pin: the create path wrote `externalUser.email ||
 * externalUser.id` and never read `externalUser.username`, so every LDAP and
 * NTLM user with an email in the directory was stored under that email instead
 * of their `sAMAccountName`. The update path refreshed only `name` and `email`,
 * so nothing ever corrected it.
 *
 * It stayed hidden because `validateAndPersistExternalUser` returns
 * `{ ...externalUser }` and takes only `id` from the stored record — the live
 * user and the JWT minted from it were right while `users.json` was wrong. It
 * surfaced wherever the stored record is read: Admin > Users shows the email as
 * the account name, and the admin user editor rejects it, since `@` fails its
 * username validation.
 *
 * Email is deliberately still in the chain. Proxy, Teams and most OIDC
 * providers supply no login name at all, and for them the email remains the
 * best identifier available — dropping it would have renamed those users onto
 * an opaque subject id.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createOrUpdateExternalUser } from '../utils/userManager.js';

let baseDir;

/** Write a scratch users.json holding these records and return its path. */
function seed(users = {}) {
  const dir = fs.mkdtempSync(path.join(baseDir, 'users-'));
  const file = path.join(dir, 'users.json');
  fs.writeFileSync(file, JSON.stringify({ users, metadata: { version: '2.0.0' } }), 'utf8');
  return file;
}

/** The single record in a scratch users.json. */
function onlyRecord(file) {
  return Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).users)[0];
}

/** An LDAP login as `loginLdapUser` assembles it. */
function ldapLogin(overrides = {}) {
  return {
    id: 'leipolda',
    username: 'leipolda',
    name: 'Leipold, Andreas',
    email: 'Andreas.Leipold@bmas.bund.de',
    authMethod: 'ldap',
    provider: 'corporate-ldap',
    groups: ['authenticated'],
    ldapData: { subject: 'leipolda', username: 'leipolda', provider: 'corporate-ldap' },
    ...overrides
  };
}

before(async () => {
  baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ihub-login-name-'));
});

after(async () => {
  await fsp.rm(baseDir, { recursive: true, force: true });
});

describe('creating an external user', () => {
  it('stores the directory login name, not the email', async () => {
    const file = seed();
    await createOrUpdateExternalUser(ldapLogin(), file);

    const record = onlyRecord(file);
    assert.equal(record.username, 'leipolda');
    assert.equal(record.email, 'Andreas.Leipold@bmas.bund.de');
  });

  it('keeps the login name out of the email field and vice versa', async () => {
    const file = seed();
    await createOrUpdateExternalUser(ldapLogin(), file);

    const record = onlyRecord(file);
    assert.notEqual(record.username, record.email);
  });

  it('stores a login name that the admin user editor accepts', async () => {
    // UserFormEditor validates against this exact pattern, and `@` fails it —
    // an email in `username` made the record uneditable in the admin UI.
    const file = seed();
    await createOrUpdateExternalUser(ldapLogin(), file);

    assert.match(onlyRecord(file).username, /^[a-zA-Z0-9_.-]+$/);
  });

  it('still falls back to the email for providers that supply no login name', async () => {
    const file = seed();
    await createOrUpdateExternalUser(
      {
        id: 'proxy-subject-123',
        name: 'Proxy User',
        email: 'someone@corp.example',
        authMethod: 'proxy',
        provider: 'proxy',
        groups: []
      },
      file
    );

    assert.equal(onlyRecord(file).username, 'someone@corp.example');
  });

  it('falls back to the external id when there is neither', async () => {
    const file = seed();
    await createOrUpdateExternalUser(
      { id: 'teams-guid-42', name: 'Teams User', provider: 'teams', groups: [] },
      file
    );

    assert.equal(onlyRecord(file).username, 'teams-guid-42');
  });
});

describe('updating an existing external user', () => {
  it('heals a record that still carries the email as its login name', async () => {
    const file = seed({
      user_existing: {
        id: 'user_existing',
        username: 'Andreas.Leipold@bmas.bund.de',
        email: 'Andreas.Leipold@bmas.bund.de',
        name: 'Leipold, Andreas',
        internalGroups: [],
        active: true,
        authMethods: ['ldap'],
        ldapData: { subject: 'leipolda', username: 'leipolda', provider: 'corporate-ldap' }
      }
    });

    await createOrUpdateExternalUser(ldapLogin(), file);

    const record = onlyRecord(file);
    assert.equal(record.username, 'leipolda');
    // Still the same record, not a second one.
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).users).length, 1);
  });

  it('leaves the stored login name alone when the provider supplies none', async () => {
    const file = seed({
      user_existing: {
        id: 'user_existing',
        username: 'someone@corp.example',
        email: 'someone@corp.example',
        name: 'Proxy User',
        internalGroups: [],
        active: true,
        authMethods: ['proxy'],
        proxyData: { subject: 'proxy-subject-123', provider: 'proxy' }
      }
    });

    await createOrUpdateExternalUser(
      {
        id: 'proxy-subject-123',
        name: 'Proxy User Renamed',
        email: 'someone@corp.example',
        authMethod: 'proxy',
        provider: 'proxy',
        groups: []
      },
      file
    );

    const record = onlyRecord(file);
    assert.equal(record.username, 'someone@corp.example');
    assert.equal(record.name, 'Proxy User Renamed');
  });
});
