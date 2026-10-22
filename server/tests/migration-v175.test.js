// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V175 — the support bot prompt names the knowledge tools.
 * The shipped prompt is replaced; a customised one is left alone.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PREVIOUS_SYSTEM,
  SYSTEM,
  description,
  precondition,
  up,
  version
} from '../migrations/V175__support_bot_knowledge_prompt.js';

let baseDir;

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

async function seed(system) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v175-'));
  await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'apps/ihub-support-bot.json'),
    JSON.stringify({ id: 'ihub-support-bot', system, projects: ['faq'] }),
    'utf8'
  );
  return { dir, ctx: makeCtx(dir) };
}

const read = async dir =>
  JSON.parse(await fs.readFile(path.join(dir, 'apps/ihub-support-bot.json'), 'utf8'));

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v175-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V175 support_bot_knowledge_prompt', () => {
  it('declares its version and ships the new prompt in the defaults', async () => {
    assert.equal(version, '175');
    assert.equal(description, 'support_bot_knowledge_prompt');
    const shipped = JSON.parse(
      await fs.readFile(new URL('../defaults/apps/ihub-support-bot.json', import.meta.url), 'utf8')
    );
    assert.deepEqual(shipped.system, SYSTEM);
    assert.match(SYSTEM.en, /knowledge_search/);
    assert.match(SYSTEM.en, /knowledge_read/);
    assert.match(SYSTEM.de, /\{\{projects\}\}/);
  });

  it('replaces the shipped prompt after V174 renamed its placeholder', async () => {
    const { dir, ctx } = await seed({ ...PREVIOUS_SYSTEM });
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    assert.deepEqual((await read(dir)).system, SYSTEM);
  });

  it('replaces only the languages still equal to the shipped text', async () => {
    const { dir, ctx } = await seed({ en: PREVIOUS_SYSTEM.en, de: 'Eigener Prompt' });
    await up(ctx);
    const { system } = await read(dir);
    assert.equal(system.en, SYSTEM.en);
    assert.equal(system.de, 'Eigener Prompt');
  });

  it('leaves a customised prompt alone and skips a missing app', async () => {
    const { dir, ctx } = await seed({ en: 'Mine' });
    await up(ctx);
    assert.equal((await read(dir)).system.en, 'Mine');
    const empty = await fs.mkdtemp(path.join(baseDir, 'none-'));
    assert.equal(await precondition(makeCtx(empty)), false);
  });
});
