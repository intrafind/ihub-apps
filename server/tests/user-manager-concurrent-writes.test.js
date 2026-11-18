// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `createOrUpdateExternalUser` and `updateUserActivity` change users.json under
 * a lock (#3638), against a real file.
 *
 * They used to read the cached body, change it and rewrite the whole file, so
 * many first logins at once (a rollout, a load test) each started from the same
 * body and only the last one survived.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createOrUpdateExternalUser, updateUserActivity } from '../utils/userManager.js';

let baseDir;

function seed(users = {}) {
  const dir = fs.mkdtempSync(path.join(baseDir, 'users-'));
  const file = path.join(dir, 'users.json');
  fs.writeFileSync(file, JSON.stringify({ users, metadata: { version: '2.0.0' } }), 'utf8');
  return file;
}

const stored = file => JSON.parse(fs.readFileSync(file, 'utf8')).users;

const login = id => ({
  id,
  username: id,
  name: id,
  email: `${id}@corp.example`,
  authMethod: 'ldap',
  provider: 'corporate-ldap',
  ldapData: { subject: id, username: id, provider: 'corporate-ldap' }
});

before(async () => {
  baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ihub-users-concurrent-'));
});

after(async () => {
  await fsp.rm(baseDir, { recursive: true, force: true });
});

describe('concurrent writes to users.json', () => {
  it('keeps every user of N first logins at once', async () => {
    const file = seed();
    const ids = Array.from({ length: 20 }, (_, i) => `person${i}`);

    await Promise.all(ids.map(id => createOrUpdateExternalUser(login(id), file)));

    assert.deepEqual(
      Object.values(stored(file))
        .map(user => user.username)
        .sort(),
      [...ids].sort()
    );
  });

  it('keeps a user that an admin-made record sits next to', async () => {
    const file = seed({
      user_admin: { id: 'user_admin', username: 'root', authMethods: ['local'] }
    });

    await Promise.all(['a', 'b', 'c'].map(id => createOrUpdateExternalUser(login(id), file)));

    assert.equal(Object.keys(stored(file)).length, 4);
    assert.ok(stored(file).user_admin);
  });

  it('does not lose activity updates of different users', async () => {
    const users = Object.fromEntries(
      ['u1', 'u2', 'u3', 'u4'].map(id => [id, { id, username: id, lastActiveDate: '2000-01-01' }])
    );
    const file = seed(users);

    await Promise.all(Object.keys(users).map(id => updateUserActivity(id, file)));

    const today = new Date().toISOString().split('T')[0];
    for (const user of Object.values(stored(file))) assert.equal(user.lastActiveDate, today);
  });
});

describe('external logins that change nothing write nothing', () => {
  // As proxyAuth builds it: it re-authenticates (and lands here) on every request.
  const proxyLogin = (overrides = {}) => ({
    id: 'jane',
    name: 'Jane Doe',
    email: 'jane@corp.example',
    groups: [],
    externalGroups: ['staff'],
    authenticated: true,
    authMethod: 'proxy',
    provider: 'proxy',
    ...overrides
  });
  // A write replaces the file (atomic rename), so its inode or mtime moves.
  const fileVersion = file => {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.mtimeMs}`;
  };

  it('proxy auth: a second request of the same user on the same day writes nothing', async () => {
    const file = seed();
    const first = await createOrUpdateExternalUser(proxyLogin(), file);
    const written = fileVersion(file);
    const record = stored(file)[first.id];

    const second = await createOrUpdateExternalUser(proxyLogin(), file);
    assert.equal(second.id, first.id);
    assert.equal(fileVersion(file), written);
    assert.deepEqual(stored(file)[first.id], record);
  });

  it('changed external groups are not persisted, so they write nothing either', async () => {
    const file = seed();
    await createOrUpdateExternalUser(proxyLogin(), file);
    const written = fileVersion(file);
    await createOrUpdateExternalUser(proxyLogin({ externalGroups: ['staff', 'managers'] }), file);
    assert.equal(fileVersion(file), written);
  });

  it('a changed name writes, and moves updatedAt', async () => {
    const file = seed();
    const first = await createOrUpdateExternalUser(proxyLogin(), file);
    const before = stored(file)[first.id];
    await new Promise(resolve => setTimeout(resolve, 5));

    await createOrUpdateExternalUser(proxyLogin({ name: 'Jane Smith' }), file);
    const after = stored(file)[first.id];
    assert.equal(after.name, 'Jane Smith');
    assert.notEqual(after.updatedAt, before.updatedAt);
  });

  it('the first request of a new day writes lastActiveDate, but not updatedAt', async () => {
    const file = seed({
      user_jane: {
        id: 'user_jane',
        username: 'jane@corp.example',
        email: 'jane@corp.example',
        name: 'Jane Doe',
        internalGroups: [],
        active: true,
        authMethods: ['proxy'],
        proxyData: { subject: 'jane', provider: 'proxy', lastProvider: 'proxy' },
        lastActiveDate: '2000-01-01',
        updatedAt: '2000-01-01T00:00:00.000Z'
      }
    });
    const written = fileVersion(file);

    await createOrUpdateExternalUser(proxyLogin(), file);
    const after = stored(file).user_jane;
    assert.notEqual(fileVersion(file), written);
    assert.equal(after.lastActiveDate, new Date().toISOString().split('T')[0]);
    assert.equal(after.updatedAt, '2000-01-01T00:00:00.000Z');
  });

  it('a record missing internalGroups is healed with one write', async () => {
    const file = seed({
      user_jane: {
        id: 'user_jane',
        username: 'jane@corp.example',
        email: 'jane@corp.example',
        name: 'Jane Doe',
        active: true,
        authMethods: ['proxy'],
        proxyData: { subject: 'jane', provider: 'proxy', lastProvider: 'proxy' },
        lastActiveDate: new Date().toISOString().split('T')[0]
      }
    });
    const written = fileVersion(file);
    await createOrUpdateExternalUser(proxyLogin(), file);
    assert.notEqual(fileVersion(file), written);
    assert.deepEqual(stored(file).user_jane.internalGroups, []);
  });
});
