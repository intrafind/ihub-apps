#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V262 specs — the anonymous group uses only the default model.
 *
 * A shipped models list (in any order) becomes `["@default"]`; any list an
 * admin changed, a wildcard, or a missing group or list is left alone.
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
  isShippedAnonymousModelList,
  DEFAULT_MODEL_TOKEN
} from '../migrations/V262__anonymous_default_model_only.js';
import { up as upV164 } from '../migrations/V164__anonymous_local_model.js';
import { DEFAULT_MODEL_TOKEN as SHARED_TOKEN } from '../../shared/modelPermissions.js';

let baseDir = null;

function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    fileExists: rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function freshDir(groups) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(path.join(dir, 'config/groups.json'), JSON.stringify({ groups }), 'utf8');
  return dir;
}

async function readGroups(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, 'config/groups.json'), 'utf8')).groups;
}

const anonymousWith = models => ({
  anonymous: { id: 'anonymous', permissions: { apps: ['chat'], models } },
  users: { id: 'users', permissions: { models: ['*'] } }
});

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v262-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V262 anonymous default model only', () => {
  it('exports its version and description', () => {
    assert.equal(version, '262');
    assert.equal(description, 'anonymous_default_model_only');
  });

  it('writes the same token the server reads', () => {
    assert.equal(DEFAULT_MODEL_TOKEN, SHARED_TOKEN);
  });

  it('runs only when groups.json exists', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'empty-'));
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  for (const shipped of [
    ['gemini-flash-latest', 'local-vllm'],
    ['local-vllm', 'gemini-flash-latest'],
    ['gemini-flash-latest'],
    ['@default', 'local-vllm']
  ]) {
    it(`replaces the shipped list ${JSON.stringify(shipped)} with the default model`, async () => {
      const dir = await freshDir(anonymousWith(shipped));
      const ctx = makeCtx(dir);
      await up(ctx);
      const groups = await readGroups(dir);
      assert.deepEqual(groups.anonymous.permissions.models, ['@default']);
      assert.deepEqual(groups.anonymous.permissions.apps, ['chat']);
      assert.deepEqual(groups.users.permissions.models, ['*']);
      assert.ok(ctx.logs.some(([level]) => level === 'info'));
    });
  }

  it('ends with only the default model on a fresh install, after V164 ran on the new defaults', async () => {
    const dir = await freshDir(anonymousWith(['@default']));
    await upV164(makeCtx(dir));
    assert.deepEqual((await readGroups(dir)).anonymous.permissions.models, [
      '@default',
      'local-vllm'
    ]);
    await up(makeCtx(dir));
    assert.deepEqual((await readGroups(dir)).anonymous.permissions.models, ['@default']);
  });

  it('is idempotent', async () => {
    const dir = await freshDir(anonymousWith(['gemini-flash-latest', 'local-vllm']));
    await up(makeCtx(dir));
    const firstWrite = await fs.readFile(path.join(dir, 'config/groups.json'), 'utf8');
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.equal(await fs.readFile(path.join(dir, 'config/groups.json'), 'utf8'), firstWrite);
    assert.deepEqual(ctx.logs, []);
  });

  for (const changed of [
    ['gemini-flash-latest', 'local-vllm', 'voxtral-mini-realtime'],
    ['gpt-4o'],
    ['local-vllm'],
    ['*'],
    [],
    ['@default', 'gpt-4o']
  ]) {
    it(`leaves an admin's list ${JSON.stringify(changed)} alone and says why`, async () => {
      const dir = await freshDir(anonymousWith(changed));
      const ctx = makeCtx(dir);
      await up(ctx);
      const groups = await readGroups(dir);
      assert.deepEqual(groups.anonymous.permissions.models, changed);
      assert.ok(ctx.logs.some(([level, message]) => level === 'info' && /alone/.test(message)));
    });
  }

  it('warns and changes nothing when there is no anonymous group', async () => {
    const dir = await freshDir({ users: { id: 'users', permissions: { models: ['*'] } } });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.ok(ctx.logs.some(([level]) => level === 'warn'));
    assert.deepEqual(Object.keys(await readGroups(dir)), ['users']);
  });

  it('warns and changes nothing when the anonymous group has no models list', async () => {
    const dir = await freshDir({ anonymous: { id: 'anonymous', permissions: {} } });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.ok(ctx.logs.some(([level]) => level === 'warn'));
    assert.ok(!('models' in (await readGroups(dir)).anonymous.permissions));
  });

  it('recognises the shipped lists in any order, and nothing else', () => {
    assert.equal(isShippedAnonymousModelList(['local-vllm', 'gemini-flash-latest']), true);
    assert.equal(
      isShippedAnonymousModelList(['gemini-flash-latest', 'gemini-flash-latest']),
      false
    );
    assert.equal(isShippedAnonymousModelList(null), false);
  });
});
