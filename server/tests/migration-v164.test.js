#!/usr/bin/env node

/**
 * Migration V164 specs — the local model is granted to the anonymous group.
 *
 * Existing installations get `local-vllm` added to the anonymous group's
 * models list, once. A `*` grant, an existing entry, or a missing group or
 * list is left alone.
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
  description
} from '../migrations/V164__anonymous_local_model.js';

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

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v164-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V164 anonymous local model', () => {
  it('exports its version and description', () => {
    assert.equal(version, '164');
    assert.equal(description, 'anonymous_local_model');
  });

  it('runs only when groups.json exists', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'empty-'));
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('adds local-vllm to the anonymous models list', async () => {
    const dir = await freshDir({
      anonymous: { id: 'anonymous', permissions: { models: ['gemini-flash-latest'] } }
    });
    const ctx = makeCtx(dir);
    await up(ctx);
    const groups = await readGroups(dir);
    assert.deepEqual(groups.anonymous.permissions.models, ['gemini-flash-latest', 'local-vllm']);
    assert.ok(ctx.logs.some(([level]) => level === 'info'));
  });

  it('is idempotent once the grant is listed', async () => {
    const dir = await freshDir({
      anonymous: { id: 'anonymous', permissions: { models: ['gemini-flash-latest', 'local-vllm'] } }
    });
    await up(makeCtx(dir));
    const groups = await readGroups(dir);
    assert.deepEqual(groups.anonymous.permissions.models, ['gemini-flash-latest', 'local-vllm']);
  });

  it('leaves a wildcard models grant alone', async () => {
    const dir = await freshDir({
      anonymous: { id: 'anonymous', permissions: { models: ['*'] } }
    });
    await up(makeCtx(dir));
    const groups = await readGroups(dir);
    assert.deepEqual(groups.anonymous.permissions.models, ['*']);
  });

  it('does not touch other groups', async () => {
    const dir = await freshDir({
      anonymous: { id: 'anonymous', permissions: { models: [] } },
      users: { id: 'users', permissions: { models: ['*'] } }
    });
    await up(makeCtx(dir));
    const groups = await readGroups(dir);
    assert.deepEqual(groups.users.permissions.models, ['*']);
  });

  it('warns and changes nothing when there is no anonymous group', async () => {
    const dir = await freshDir({ users: { id: 'users', permissions: { models: ['*'] } } });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.ok(ctx.logs.some(([level]) => level === 'warn'));
    const groups = await readGroups(dir);
    assert.deepEqual(Object.keys(groups), ['users']);
  });

  it('warns and changes nothing when the anonymous group has no models list', async () => {
    const dir = await freshDir({ anonymous: { id: 'anonymous', permissions: {} } });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.ok(ctx.logs.some(([level]) => level === 'warn'));
    const groups = await readGroups(dir);
    assert.ok(!('models' in groups.anonymous.permissions));
  });
});
