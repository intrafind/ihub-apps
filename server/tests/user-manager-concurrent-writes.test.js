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
