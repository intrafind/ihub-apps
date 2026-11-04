// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, precondition, version } from '../migrations/V218__legacy_resource_arrays_to_files.js';

let baseDir;

function makeCtx(dir) {
  const logs = [];
  const abs = rel => path.join(dir, rel);
  return {
    logs,
    fileExists: rel =>
      fs
        .stat(abs(rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(abs(rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
      await fs.writeFile(abs(rel), JSON.stringify(data), 'utf8');
    },
    deleteFile: rel => fs.rm(abs(rel)),
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function seed(files) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v218-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(
      path.join(dir, rel),
      typeof content === 'string' ? content : JSON.stringify(content)
    );
  }
  return dir;
}

describe('migration V218', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v218-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('has version 218', () => assert.equal(version, '218'));

  it('is skipped when no legacy array exists', async () => {
    const dir = await seed({ 'apps/a.json': { id: 'a' } });
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('moves entries to files, keeps existing files, removes the array', async () => {
    const dir = await seed({
      'config/apps.json': [
        { id: 'one', name: 'legacy one' },
        { id: 'two', name: 'legacy two' }
      ],
      'apps/one.json': { id: 'one', name: 'file one' },
      'config/agents.json': [{ id: 'agent-a' }]
    });
    const ctx = makeCtx(dir);
    assert.equal(await precondition(ctx), true);
    await up(ctx);

    const one = JSON.parse(await fs.readFile(path.join(dir, 'apps/one.json'), 'utf8'));
    assert.equal(one.name, 'file one');
    const two = JSON.parse(await fs.readFile(path.join(dir, 'apps/two.json'), 'utf8'));
    assert.equal(two.name, 'legacy two');
    assert.equal(await ctx.fileExists('config/apps.json'), false);
    assert.equal(await ctx.fileExists('agents/profiles/agent-a.json'), true);
    assert.equal(await ctx.fileExists('config/agents.json'), false);
  });

  it('keeps the array and warns when an entry has no usable id', async () => {
    const dir = await seed({
      'config/models.json': [{ id: '../evil' }, { id: 'ok' }, { name: 'no id' }]
    });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.equal(await ctx.fileExists('config/models.json'), true);
    assert.equal(await ctx.fileExists('models/ok.json'), true);
    assert.equal(await ctx.fileExists('models/evil.json'), false);
    assert.ok(ctx.logs.some(([level]) => level === 'warn'));
  });

  it('skips unreadable and non-array files without throwing', async () => {
    const dir = await seed({ 'config/prompts.json': '{ nope', 'config/workflows.json': '{}' });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.equal(await ctx.fileExists('config/prompts.json'), true);
    assert.equal(await ctx.fileExists('config/workflows.json'), true);
  });
});
