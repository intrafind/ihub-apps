#!/usr/bin/env node

/**
 * Migration V121 specs — dropping the shipped `localAuth.usersFile`,
 * `oauth.clientsFile` and `skills.skillsDirectory` values from platform.json, so the server's
 * CONTENTS_DIR-aware default applies, while keeping any path an admin chose.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V121__contents_dir_aware_config_paths.js';

function fakeCtx(files) {
  const logs = [];
  let writes = 0;
  return {
    files,
    logs,
    get writes() {
      return writes;
    },
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      writes++;
      files[p] = d;
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '121');
});

test('precondition is false when platform.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('the shipped paths are removed and the rest of each section is kept', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      localAuth: { enabled: true, usersFile: 'contents/config/users.json' },
      oauth: { enabled: { authz: true }, clientsFile: 'contents/config/oauth-clients.json' },
      skills: { skillsDirectory: 'contents/skills', maxSkillBodyTokens: 5000 }
    }
  });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'], {
    localAuth: { enabled: true },
    oauth: { enabled: { authz: true } },
    skills: { maxSkillBodyTokens: 5000 }
  });
});

test('a path an admin chose is left alone', async () => {
  const platform = {
    localAuth: { usersFile: '/run/secrets/users.json' },
    oauth: { clientsFile: 'custom/config/oauth-clients.json' },
    skills: { skillsDirectory: 'shared/skills' }
  };
  const ctx = fakeCtx({ 'config/platform.json': platform });
  await up(ctx);
  assert.equal(ctx.writes, 0);
  assert.deepEqual(ctx.files['config/platform.json'], platform);
});

test('only the settings still holding the shipped value are removed', async () => {
  const ctx = fakeCtx({
    'config/platform.json': {
      localAuth: { usersFile: 'contents/config/users.json' },
      oauth: { clientsFile: 'secrets/oauth-clients.json' }
    }
  });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'], {
    localAuth: {},
    oauth: { clientsFile: 'secrets/oauth-clients.json' }
  });
});

test('missing sections are tolerated without a write', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { features: {} } });
  await up(ctx);
  assert.equal(ctx.writes, 0);
});
