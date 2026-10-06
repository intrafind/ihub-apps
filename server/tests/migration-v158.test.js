#!/usr/bin/env node

/**
 * Migration V158 specs — the Microsoft 365 Copilot agent settings.
 *
 * The migration adds the missing `copilotAgent` values, off by default, and
 * keeps whatever an admin set. The defaults carry the same section, so fresh
 * installs and upgraded ones agree.
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
  COPILOT_AGENT_DEFAULTS
} from '../migrations/V158__add_copilot_agent_config.js';
import { setDefault } from '../migrations/utils.js';
import { DEFAULT_COPILOT_AGENT_CONFIG } from '../utils/copilotAgentPackage.js';

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
    setDefault,
    log: () => {},
    warn: () => {}
  };
}

async function seed(platform) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v158-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (platform !== null) {
    await fs.writeFile(path.join(dir, 'config/platform.json'), JSON.stringify(platform), 'utf8');
  }
  const ctx = makeCtx(dir);
  return { ctx, read: () => ctx.readJson('config/platform.json') };
}

describe('V158 add_copilot_agent_config', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-v158-'));
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('is version 158', () => {
    assert.equal(version, '158');
    assert.equal(description, 'add_copilot_agent_config');
  });

  it('skips an install without a platform config', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
  });

  it('adds the section, off', async () => {
    const { ctx, read } = await seed({ defaultLanguage: 'en' });
    await up(ctx);
    const platform = await read();
    assert.deepEqual(platform.copilotAgent, COPILOT_AGENT_DEFAULTS);
    assert.equal(platform.copilotAgent.enabled, false);
    assert.equal(platform.defaultLanguage, 'en');
  });

  it("keeps an admin's values and fills in only what is missing", async () => {
    const { ctx, read } = await seed({
      copilotAgent: { enabled: true, name: 'Contoso AI', oauthReferenceId: 'ref-1' }
    });
    await up(ctx);
    const { copilotAgent } = await read();
    assert.equal(copilotAgent.enabled, true);
    assert.equal(copilotAgent.name, 'Contoso AI');
    assert.equal(copilotAgent.oauthReferenceId, 'ref-1');
    assert.deepEqual(copilotAgent.conversationStarters, []);
  });

  it('agrees with the shipped defaults and with the runtime defaults', async () => {
    const defaults = JSON.parse(
      await fs.readFile(path.join(defaultsDir, 'config', 'platform.json'), 'utf8')
    );
    assert.deepEqual(defaults.copilotAgent, COPILOT_AGENT_DEFAULTS);
    assert.deepEqual({ ...DEFAULT_COPILOT_AGENT_CONFIG }, { ...COPILOT_AGENT_DEFAULTS });
  });
});
