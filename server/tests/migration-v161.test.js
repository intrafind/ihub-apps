#!/usr/bin/env node

/**
 * Migration V161 specs — more room for the notes of scheduled tasks.
 *
 * The migration raises `scheduledTasks.memoryMaxChars` only where it still
 * carries the shipped 8000, keeps an admin's own value, and adds it where it
 * is missing. The defaults and the runtime fallback agree with it.
 *
 * It touches one file, so the context is in memory: no scratch directory.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
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

/**
 * A migration context over one in-memory platform.json.
 *
 * @param {Object|null} platform - null: the file does not exist.
 */
function memoryCtx(platform) {
  const state = { platform: structuredClone(platform), writes: 0 };
  const noLog = () => undefined; // the runner logs; these specs do not look at it
  return {
    state,
    fileExists: rel => Promise.resolve(rel === 'config/platform.json' && state.platform !== null),
    readJson: () => Promise.resolve(structuredClone(state.platform)),
    writeJson: (rel, data) => {
      state.writes += 1;
      state.platform = data;
      return Promise.resolve();
    },
    setDefault,
    log: noLog,
    warn: noLog
  };
}

describe('V161 larger_scheduled_task_memory', () => {
  it('is version 161', () => {
    assert.equal(version, '161');
    assert.equal(description, 'larger_scheduled_task_memory');
  });

  it('skips an install without a platform config', async () => {
    assert.equal(await precondition(memoryCtx(null)), false);
  });

  it('raises the shipped 8000 and leaves the other settings alone', async () => {
    const ctx = memoryCtx({
      scheduledTasks: { memoryEnabled: true, memoryMaxChars: 8000, maxHistoryReadChars: 8000 }
    });
    await up(ctx);
    assert.deepEqual(ctx.state.platform.scheduledTasks, {
      memoryEnabled: true,
      memoryMaxChars: 16000,
      maxHistoryReadChars: 8000
    });
  });

  it("keeps an admin's own value and does not write", async () => {
    const ctx = memoryCtx({ scheduledTasks: { memoryMaxChars: 12000 } });
    await up(ctx);
    assert.equal(ctx.state.platform.scheduledTasks.memoryMaxChars, 12000);
    assert.equal(ctx.state.writes, 0);
  });

  it('adds the setting where it is missing', async () => {
    const ctx = memoryCtx({ defaultLanguage: 'en' });
    await up(ctx);
    assert.equal(ctx.state.platform.scheduledTasks.memoryMaxChars, MEMORY_MAX_CHARS);
    assert.equal(ctx.state.platform.defaultLanguage, 'en');
  });

  it('agrees with the shipped defaults and with the runtime fallback', async () => {
    const file = path.join(import.meta.dirname, '..', 'defaults', 'config', 'platform.json');
    const defaults = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(defaults.scheduledTasks.memoryMaxChars, MEMORY_MAX_CHARS);
    assert.equal(DEFAULT_SCHEDULED_TASK_SETTINGS.memoryMaxChars, MEMORY_MAX_CHARS);
  });
});
