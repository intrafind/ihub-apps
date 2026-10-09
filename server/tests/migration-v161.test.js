#!/usr/bin/env node

/**
 * Migration V161 specs — more room for the notes of scheduled tasks.
 *
 * The migration raises `scheduledTasks.memoryMaxChars` only where it still
 * carries the shipped 8000, keeps an admin's own value, and adds it where it
 * is missing. The defaults and the runtime fallback agree with it.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version,
  description,
  MEMORY_MAX_CHARS
} from '../migrations/V161__larger_scheduled_task_memory.js';
import { setDefault } from '../migrations/utils.js';
import { DEFAULT_SCHEDULED_TASK_SETTINGS } from '../services/scheduler/tasks/taskPolicy.js';

const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults');

let baseDir;

async function seed(platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v161-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (platform !== null) {
    await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  }
  let writes = 0;
  const ctx = {
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      writes += 1;
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    setDefault,
    log: () => {},
    warn: () => {}
  };
  return { ctx, read: () => ctx.readJson('config/platform.json'), writes: () => writes };
}

describe('V161 larger_scheduled_task_memory', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-v161-'));
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('is version 161', () => {
    assert.equal(version, '161');
    assert.equal(description, 'larger_scheduled_task_memory');
  });

  it('skips an install without a platform config', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
  });

  it('raises the shipped 8000 and leaves the other settings alone', async () => {
    const { ctx, read } = await seed({
      scheduledTasks: { memoryEnabled: true, memoryMaxChars: 8000, maxHistoryReadChars: 8000 }
    });
    await up(ctx);
    assert.deepEqual((await read()).scheduledTasks, {
      memoryEnabled: true,
      memoryMaxChars: 16000,
      maxHistoryReadChars: 8000
    });
  });

  it("keeps an admin's own value and does not write", async () => {
    const { ctx, read, writes } = await seed({ scheduledTasks: { memoryMaxChars: 12000 } });
    await up(ctx);
    assert.equal((await read()).scheduledTasks.memoryMaxChars, 12000);
    assert.equal(writes(), 0);
  });

  it('adds the setting where it is missing', async () => {
    const { ctx, read } = await seed({ defaultLanguage: 'en' });
    await up(ctx);
    const platform = await read();
    assert.equal(platform.scheduledTasks.memoryMaxChars, MEMORY_MAX_CHARS);
    assert.equal(platform.defaultLanguage, 'en');
  });

  it('agrees with the shipped defaults and with the runtime fallback', async () => {
    const defaults = JSON.parse(
      await fs.readFile(path.join(defaultsDir, 'config', 'platform.json'), 'utf8')
    );
    assert.equal(defaults.scheduledTasks.memoryMaxChars, MEMORY_MAX_CHARS);
    assert.equal(DEFAULT_SCHEDULED_TASK_SETTINGS.memoryMaxChars, MEMORY_MAX_CHARS);
  });
});
