#!/usr/bin/env node

/**
 * Migration V156 specs — the token budget for the skills list.
 *
 * The migration adds `skills.maxCatalogTokens` where it is missing, creates
 * the `skills` section when there is none, and keeps an admin's value. The
 * defaults carry the same value, so fresh installs and upgraded ones agree.
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
  DEFAULT_MAX_CATALOG_TOKENS
} from '../migrations/V156__add_skills_catalog_token_budget.js';
import { setDefault } from '../migrations/utils.js';

const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults');

let baseDir;

/** A migration context over a scratch contents directory. */
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
    setDefault,
    log: () => {},
    warn: () => {}
  };
}

/**
 * A scratch contents directory holding `config/platform.json` (none for `null`).
 *
 * @param {Object|null} platform - The platform config to write.
 * @returns {Promise<{ctx: Object, read: () => Promise<Object>}>}
 */
async function seed(platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v156-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (platform !== null) {
    await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  }
  const ctx = makeCtx(dir);
  return { ctx, read: () => ctx.readJson('config/platform.json') };
}

describe('V156 add_skills_catalog_token_budget', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-v156-'));
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('is version 156', () => {
    assert.equal(version, '156');
    assert.equal(description, 'add_skills_catalog_token_budget');
  });

  it('runs only where a platform config exists', async () => {
    assert.equal(await precondition((await seed(null)).ctx), false);
    assert.equal(await precondition((await seed({})).ctx), true);
  });

  it('adds the budget next to the existing skills settings', async () => {
    const { ctx, read } = await seed({ skills: { maxSkillBodyTokens: 4000 } });
    await up(ctx);
    assert.deepEqual((await read()).skills, {
      maxSkillBodyTokens: 4000,
      maxCatalogTokens: DEFAULT_MAX_CATALOG_TOKENS
    });
  });

  it('creates the skills section when there is none', async () => {
    const { ctx, read } = await seed({ defaultLanguage: 'de' });
    await up(ctx);
    const platform = await read();
    assert.equal(platform.defaultLanguage, 'de');
    assert.deepEqual(platform.skills, { maxCatalogTokens: DEFAULT_MAX_CATALOG_TOKENS });
  });

  it("keeps an admin's value", async () => {
    const { ctx, read } = await seed({ skills: { maxCatalogTokens: 800 } });
    await up(ctx);
    assert.equal((await read()).skills.maxCatalogTokens, 800);
  });

  it('matches the shipped default', async () => {
    const defaults = JSON.parse(
      await fs.readFile(path.join(defaultsDir, 'config/platform.json'), 'utf8')
    );
    assert.equal(defaults.skills.maxCatalogTokens, DEFAULT_MAX_CATALOG_TOKENS);
  });
});
