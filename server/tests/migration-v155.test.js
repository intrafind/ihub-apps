#!/usr/bin/env node

/**
 * Migration V155 specs — assigning the shipped `skill-builder` skill to the
 * Chat app.
 *
 * The migration adds the skill to `apps/chat.json` when it is missing, keeps
 * every skill the app already has, and leaves an app that lists it alone. The
 * shipped skill itself must be a valid skill folder and Chat must list it in
 * the defaults, so fresh installs and upgraded ones end up the same.
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
  SKILL_NAME
} from '../migrations/V155__add_skill_builder_to_chat_app.js';
import { validateSkillDirectory } from '../services/skillLoader.js';

const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults');

let baseDir;

function makeCtx(dir) {
  return {
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
    log: () => {},
    warn: () => {}
  };
}

async function seed(chatApp) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v155-'));
  await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
  if (chatApp !== null) {
    await fs.writeFile(path.join(dir, 'apps/chat.json'), JSON.stringify(chatApp), 'utf8');
  }
  return makeCtx(dir);
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v155-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V155', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '155');
    assert.equal(description, 'add_skill_builder_to_chat_app');
    assert.equal(SKILL_NAME, 'skill-builder');
  });

  it('only runs when the Chat app exists', async () => {
    assert.equal(await precondition(await seed(null)), false);
    assert.equal(await precondition(await seed({ id: 'chat' })), true);
  });

  it('adds the skill to a Chat app without skills', async () => {
    const ctx = await seed({ id: 'chat', name: { en: 'Chat' }, enabled: true });
    await up(ctx);
    const app = await ctx.readJson('apps/chat.json');
    assert.deepEqual(app.skills, ['skill-builder']);
    assert.deepEqual(app.name, { en: 'Chat' });
    assert.equal(app.enabled, true);
  });

  it('keeps the skills the app already has, in order', async () => {
    const ctx = await seed({ id: 'chat', skills: ['brand-voice', 'pdf'] });
    await up(ctx);
    assert.deepEqual((await ctx.readJson('apps/chat.json')).skills, [
      'brand-voice',
      'pdf',
      'skill-builder'
    ]);
  });

  it('leaves an app that already lists the skill unchanged', async () => {
    const ctx = await seed({ id: 'chat', skills: ['skill-builder', 'pdf'] });
    await up(ctx);
    assert.deepEqual((await ctx.readJson('apps/chat.json')).skills, ['skill-builder', 'pdf']);
  });

  it('matches the shipped defaults: Chat lists the skill, and the skill is valid', async () => {
    const chat = JSON.parse(await fs.readFile(path.join(defaultsDir, 'apps/chat.json'), 'utf8'));
    assert.ok(chat.skills.includes(SKILL_NAME));
    const result = await validateSkillDirectory(path.join(defaultsDir, 'skills', SKILL_NAME));
    assert.equal(result.valid, true, result.errors.join('; '));
    assert.equal(result.metadata.name, SKILL_NAME);
  });
});
