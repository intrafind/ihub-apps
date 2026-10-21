#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V173 specs — adding `tools/knowledge.json` to an upgraded
 * installation, and leaving one an admin already has alone.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, precondition, version, description } from '../migrations/V173__add_knowledge_tool.js';

let baseDir;
const DEFAULTS = path.resolve('server/defaults');

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
    readDefaultJson: async rel => JSON.parse(await fs.readFile(path.join(DEFAULTS, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v173-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V173', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '173');
    assert.equal(description, 'add_knowledge_tool');
  });

  it('adds the shipped tool when it is missing', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'fresh-'));
    const ctx = makeCtx(dir);
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    const tool = JSON.parse(await fs.readFile(path.join(dir, 'tools/knowledge.json'), 'utf8'));
    assert.equal(tool.id, 'knowledge');
    assert.deepEqual(Object.keys(tool.functions).sort(), ['list', 'read', 'search']);
    assert.equal(tool.script, 'knowledge.js');
  });

  it('leaves an existing tool file alone', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'kept-'));
    const ctx = makeCtx(dir);
    await ctx.writeJson('tools/knowledge.json', { id: 'knowledge', name: 'Mine', enabled: false });
    assert.equal(await precondition(ctx), false);
  });
});
