#!/usr/bin/env node

/**
 * Migration V160 specs — memory between runs reaches installations that
 * already exist.
 *
 * `copyDefaultConfiguration()` backfills whole files that are missing from
 * `contents/`; it does not merge new fields into a file that is already there.
 * So an install that has `tools/schedule_task.json` keeps the old schema
 * forever unless a migration adds the `memory` parameter and the `changes`
 * notify mode — and the model would never offer a task that remembers.
 *
 * What has to be right: add only what is missing, replace a description only
 * when it is still the text iHub shipped, leave an admin's edits and every
 * other part of the file alone, and do it once.
 */
import fsSync from 'node:fs';
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
} from '../migrations/V160__scheduled_task_memory.js';
import { setDefault } from '../migrations/utils.js';

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
    readJson: async rel =>
      fs
        .readFile(path.join(dir, rel), 'utf8')
        .then(JSON.parse)
        .catch(() => null),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    setDefault,
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

/** A default tool file as it stood at V159 (fixtures: CI checkouts have no git history). */
function shippedBefore(name) {
  return JSON.parse(
    fsSync.readFileSync(
      path.resolve(import.meta.dirname, 'fixtures', 'migration-v160', `${name}.v159.json`),
      'utf8'
    )
  );
}

async function seed(dir, files) {
  for (const [rel, data] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
  }
}

async function scratch(name) {
  return fs.mkdtemp(path.join(baseDir, `${name}-`));
}

const LEGACY_PLATFORM = () => ({
  scheduledTasks: { enabled: true, maxTasksPerUser: 10, maxRunMinutes: 30 }
});

describe('V160 — scheduled task memory', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v160-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares its version and description', () => {
    assert.equal(version, '160');
    assert.equal(description, 'scheduled_task_memory');
  });

  it('skips an install that has neither the platform file nor the tool files', async () => {
    const dir = await scratch('empty');
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('runs when only one of the files exists', async () => {
    const dir = await scratch('one');
    await seed(dir, { 'tools/schedule_task.json': shippedBefore('schedule_task') });
    assert.equal(await precondition(makeCtx(dir)), true);
  });

  describe('platform limits', () => {
    it('adds the three limits and keeps what is there', async () => {
      const dir = await scratch('platform');
      await seed(dir, { 'config/platform.json': LEGACY_PLATFORM() });
      const ctx = makeCtx(dir);
      await up(ctx);

      const platform = await ctx.readJson('config/platform.json');
      assert.deepEqual(platform.scheduledTasks, {
        enabled: true,
        maxTasksPerUser: 10,
        maxRunMinutes: 30,
        memoryEnabled: true,
        memoryMaxChars: 8000,
        maxHistoryReadChars: 8000
      });
    });

    it('never overwrites a limit the admin already set', async () => {
      const dir = await scratch('platform-custom');
      const platform = LEGACY_PLATFORM();
      platform.scheduledTasks.memoryEnabled = false;
      platform.scheduledTasks.memoryMaxChars = 2000;
      await seed(dir, { 'config/platform.json': platform });
      const ctx = makeCtx(dir);
      await up(ctx);

      const after = (await ctx.readJson('config/platform.json')).scheduledTasks;
      assert.equal(after.memoryEnabled, false);
      assert.equal(after.memoryMaxChars, 2000);
      assert.equal(after.maxHistoryReadChars, 8000);
    });

    it('creates the section on a platform file that has none', async () => {
      const dir = await scratch('platform-none');
      await seed(dir, { 'config/platform.json': { auth: { mode: 'local' } } });
      const ctx = makeCtx(dir);
      await up(ctx);

      const platform = await ctx.readJson('config/platform.json');
      assert.equal(platform.scheduledTasks.memoryEnabled, true);
      assert.deepEqual(platform.auth, { mode: 'local' });
    });
  });

  describe('schedule_task tool', () => {
    it('declares memory and the changes mode and refreshes the shipped text', async () => {
      const dir = await scratch('schedule');
      const legacy = shippedBefore('schedule_task');
      await seed(dir, { 'tools/schedule_task.json': legacy });
      const ctx = makeCtx(dir);
      await up(ctx);

      const tool = await ctx.readJson('tools/schedule_task.json');
      const props = tool.parameters.properties;
      assert.equal(props.memory.type, 'boolean');
      assert.match(props.memory.description.en, /Remember between runs/);
      assert.match(props.memory.description.de, /Zwischen Läufen merken/);
      assert.deepEqual(props.notify.enum, ['always', 'failure', 'never', 'changes']);
      assert.match(props.notify.description.en, /changes/);
      assert.match(props.instructions.description.en, /set memory to true/);
      assert.match(props.instructions.description.de, /memory auf true/);

      // Everything else is untouched.
      assert.deepEqual(props.name, legacy.parameters.properties.name);
      assert.deepEqual(props.schedule, legacy.parameters.properties.schedule);
      assert.deepEqual(props.tools, legacy.parameters.properties.tools);
      assert.deepEqual(tool.parameters.required, legacy.parameters.required);
      assert.deepEqual(tool.description, legacy.description);
      assert.equal(tool.script, 'scheduledTaskTools.js');
    });

    it('keeps a description the admin has edited', async () => {
      const dir = await scratch('schedule-custom');
      const custom = shippedBefore('schedule_task');
      custom.parameters.properties.instructions.description.en = 'Our own wording';
      custom.parameters.properties.notify.description = { en: 'Our notify wording' };
      await seed(dir, { 'tools/schedule_task.json': custom });
      const ctx = makeCtx(dir);
      await up(ctx);

      const props = (await ctx.readJson('tools/schedule_task.json')).parameters.properties;
      assert.equal(props.instructions.description.en, 'Our own wording');
      assert.equal(props.notify.description.en, 'Our notify wording');
      // The structural additions still land.
      assert.equal(props.memory.type, 'boolean');
      assert.ok(props.notify.enum.includes('changes'));
    });

    it('keeps a memory parameter the admin already customised', async () => {
      const dir = await scratch('schedule-memory');
      const custom = shippedBefore('schedule_task');
      custom.parameters.properties.memory = { type: 'boolean', description: { en: 'Mine' } };
      await seed(dir, { 'tools/schedule_task.json': custom });
      const ctx = makeCtx(dir);
      await up(ctx);

      const props = (await ctx.readJson('tools/schedule_task.json')).parameters.properties;
      assert.equal(props.memory.description.en, 'Mine');
    });

    it('does not add an enum to a notify parameter that has none', async () => {
      const dir = await scratch('schedule-noenum');
      const custom = shippedBefore('schedule_task');
      delete custom.parameters.properties.notify.enum;
      await seed(dir, { 'tools/schedule_task.json': custom });
      const ctx = makeCtx(dir);
      await up(ctx);

      const notify = (await ctx.readJson('tools/schedule_task.json')).parameters.properties.notify;
      assert.equal(notify.enum, undefined);
    });
  });

  describe('update_scheduled_task tool', () => {
    it('declares memory and the changes mode and refreshes the description', async () => {
      const dir = await scratch('update');
      const legacy = shippedBefore('update_scheduled_task');
      await seed(dir, { 'tools/update_scheduled_task.json': legacy });
      const ctx = makeCtx(dir);
      await up(ctx);

      const tool = await ctx.readJson('tools/update_scheduled_task.json');
      assert.equal(tool.parameters.properties.memory.type, 'boolean');
      assert.deepEqual(tool.parameters.properties.notify.enum, [
        'always',
        'failure',
        'never',
        'changes'
      ]);
      assert.match(tool.description.en, /notifications or memory between runs/);
      assert.match(tool.description.de, /Zwischen|Merken zwischen Läufen/);
      assert.deepEqual(tool.parameters.required, ['taskId']);
      assert.deepEqual(tool.parameters.properties.taskId, legacy.parameters.properties.taskId);
    });

    it('keeps a description the admin has edited', async () => {
      const dir = await scratch('update-custom');
      const custom = shippedBefore('update_scheduled_task');
      custom.description = { en: 'Our own description' };
      await seed(dir, { 'tools/update_scheduled_task.json': custom });
      const ctx = makeCtx(dir);
      await up(ctx);

      const tool = await ctx.readJson('tools/update_scheduled_task.json');
      assert.deepEqual(tool.description, { en: 'Our own description' });
      assert.equal(tool.parameters.properties.memory.type, 'boolean');
    });
  });

  it('skips a tool file without parameters instead of failing', async () => {
    const dir = await scratch('broken');
    await seed(dir, { 'tools/schedule_task.json': { id: 'schedule_task' } });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.ok(
      ctx.logs.some(([level, message]) => level === 'warn' && /no parameters/.test(message))
    );
    assert.deepEqual(await ctx.readJson('tools/schedule_task.json'), { id: 'schedule_task' });
  });

  it('matches what a fresh install gets from the default files', async () => {
    const dir = await scratch('fresh');
    const defaultsDir = path.resolve(import.meta.dirname, '..', 'defaults');
    const shipped = {
      'tools/schedule_task.json': JSON.parse(
        await fs.readFile(path.join(defaultsDir, 'tools/schedule_task.json'), 'utf8')
      ),
      'tools/update_scheduled_task.json': JSON.parse(
        await fs.readFile(path.join(defaultsDir, 'tools/update_scheduled_task.json'), 'utf8')
      ),
      'config/platform.json': JSON.parse(
        await fs.readFile(path.join(defaultsDir, 'config/platform.json'), 'utf8')
      )
    };
    await seed(dir, shipped);
    const ctx = makeCtx(dir);
    await up(ctx);

    // Nothing to add: the defaults already say everything the migration says.
    for (const [rel, data] of Object.entries(shipped)) {
      assert.deepEqual(await ctx.readJson(rel), data, rel);
    }
  });

  it('is idempotent', async () => {
    const dir = await scratch('idempotent');
    await seed(dir, {
      'config/platform.json': LEGACY_PLATFORM(),
      'tools/schedule_task.json': shippedBefore('schedule_task'),
      'tools/update_scheduled_task.json': shippedBefore('update_scheduled_task')
    });
    const ctx = makeCtx(dir);
    await up(ctx);
    const once = {};
    for (const rel of [
      'config/platform.json',
      'tools/schedule_task.json',
      'tools/update_scheduled_task.json'
    ]) {
      once[rel] = await ctx.readJson(rel);
    }
    await up(ctx);
    for (const [rel, data] of Object.entries(once)) {
      assert.deepEqual(await ctx.readJson(rel), data, rel);
    }
  });
});
