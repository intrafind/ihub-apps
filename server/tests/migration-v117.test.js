#!/usr/bin/env node

/**
 * Migration V117 specs — backfilling directory login names.
 *
 * The old create path wrote the email into `username` for every external user
 * who had one, and nothing ever wrote it again. This migration recovers the
 * real login name from the provider block — but only where doing so is
 * unambiguous, because `username` is a login credential for local accounts and
 * a uniqueness key for everyone.
 *
 * So the specs pin both directions: the records it must fix, and the records it
 * must leave exactly as they are.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version,
  description,
  needsLoginNameBackfill,
  recoverLoginName
} from '../migrations/V117__backfill_external_user_login_names.js';

let baseDir;

/** A migration context over a scratch contents directory. */
function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

/** Write a scratch contents dir holding these users, and return its ctx. */
async function seed(users, platform = null) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v117-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config/users.json'),
    JSON.stringify({ users }, null, 2),
    'utf8'
  );
  if (platform) {
    await fs.writeFile(
      path.join(dir, 'config/platform.json'),
      JSON.stringify(platform, null, 2),
      'utf8'
    );
  }
  return { dir, ctx: makeCtx(dir) };
}

/** Read users.json back from a scratch dir. */
async function readUsers(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, 'config/users.json'), 'utf8')).users;
}

/** The record the old create path produced for an AD user with an email. */
function ldapUser(overrides = {}) {
  return {
    id: 'user_1',
    username: 'Andreas.Leipold@bmas.bund.de',
    email: 'Andreas.Leipold@bmas.bund.de',
    name: 'Leipold, Andreas',
    authMethods: ['ldap'],
    ldapData: { subject: 'leipolda', username: 'leipolda', provider: 'corporate-ldap' },
    ...overrides
  };
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v117-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V117 metadata', () => {
  it('matches its filename', () => {
    assert.equal(version, '117');
    assert.equal(typeof description, 'string');
  });

  it('only runs when users.json exists', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'empty-'));
    assert.equal(await precondition(makeCtx(dir)), false);

    const { ctx } = await seed({ user_1: ldapUser() });
    assert.equal(await precondition(ctx), true);
  });
});

describe('V117 recovers the login name', () => {
  it('replaces an email username with the LDAP login name', async () => {
    const { dir, ctx } = await seed({ user_1: ldapUser() });
    await up(ctx);

    const users = await readUsers(dir);
    assert.equal(users.user_1.username, 'leipolda');
    // The email itself is untouched — only the login name was wrong.
    assert.equal(users.user_1.email, 'Andreas.Leipold@bmas.bund.de');
  });

  it('falls back to ldapData.subject when no username was recorded', () => {
    const user = ldapUser({ ldapData: { subject: 'leipolda', provider: 'corporate-ldap' } });
    assert.equal(recoverLoginName(user), 'leipolda');
  });

  it('recovers the Windows account name for NTLM users', async () => {
    const { dir, ctx } = await seed({
      user_1: {
        id: 'user_1',
        username: 'a.leipold@corp.example',
        email: 'a.leipold@corp.example',
        authMethods: ['ntlm'],
        ntlmData: { subject: 'leipolda', domain: 'ROCHUS' }
      }
    });
    await up(ctx);

    assert.equal((await readUsers(dir)).user_1.username, 'leipolda');
  });
});

describe('V117 leaves everything else alone', () => {
  it('skips records whose username is already a login name', async () => {
    const { dir, ctx } = await seed({ user_1: ldapUser({ username: 'leipolda' }) });
    await up(ctx);

    assert.equal((await readUsers(dir)).user_1.username, 'leipolda');
    assert.ok(ctx.logs.some(([, m]) => m.includes('nothing to backfill')));
  });

  it('skips accounts that also authenticate locally', async () => {
    // `username` is a credential the user types there; rewriting it would
    // change how they sign in.
    const { dir, ctx } = await seed({
      user_1: ldapUser({ authMethods: ['ldap', 'local'] })
    });
    await up(ctx);

    assert.equal((await readUsers(dir)).user_1.username, 'Andreas.Leipold@bmas.bund.de');
  });

  it('skips providers that carry no login name', async () => {
    const proxyUser = {
      id: 'user_1',
      username: 'someone@corp.example',
      email: 'someone@corp.example',
      authMethods: ['proxy'],
      proxyData: { subject: 'someone@corp.example', provider: 'proxy' }
    };
    assert.equal(needsLoginNameBackfill(proxyUser), false);

    const { dir, ctx } = await seed({ user_1: proxyUser });
    await up(ctx);
    assert.equal((await readUsers(dir)).user_1.username, 'someone@corp.example');
  });

  it('does not rewrite one user onto a login name another already holds', async () => {
    const { dir, ctx } = await seed({
      user_1: ldapUser(),
      user_2: { id: 'user_2', username: 'leipolda', authMethods: ['local'] }
    });
    await up(ctx);

    const users = await readUsers(dir);
    assert.equal(users.user_1.username, 'Andreas.Leipold@bmas.bund.de');
    assert.equal(users.user_2.username, 'leipolda');
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('duplicate')));
  });

  it('does not treat an email subject as a recovered login name', () => {
    const user = ldapUser({
      ldapData: { subject: 'Andreas.Leipold@bmas.bund.de', provider: 'corporate-ldap' }
    });
    assert.equal(recoverLoginName(user), null);
    assert.equal(needsLoginNameBackfill(user), false);
  });
});

describe('V117 honours a relocated users file', () => {
  it('refuses a path outside the contents directory instead of writing nothing quietly', async () => {
    const { dir, ctx } = await seed(
      { user_1: ldapUser() },
      { localAuth: { usersFile: '/srv/ihub-state/users.json' } }
    );
    await up(ctx);

    assert.equal((await readUsers(dir)).user_1.username, 'Andreas.Leipold@bmas.bund.de');
    assert.ok(
      ctx.logs.some(([level, m]) => level === 'warn' && m.includes('outside the contents'))
    );
  });

  it('strips the contents/ prefix the setting is written with', async () => {
    const { dir, ctx } = await seed(
      { user_1: ldapUser() },
      { localAuth: { usersFile: 'contents/config/users.json' } }
    );
    await up(ctx);

    assert.equal((await readUsers(dir)).user_1.username, 'leipolda');
  });
});
