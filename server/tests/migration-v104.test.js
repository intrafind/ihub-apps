#!/usr/bin/env node

/**
 * Migration V104 specs — Gemini 3 forward, on one thinking shape.
 *
 * Three groups of invariants.
 *
 * The **conversion** is scoped to Google (Anthropic and OpenAI Responses still
 * read `thinking.budget`, so touching theirs would silently change their
 * reasoning), never overrides a level an operator already chose, and leaves no
 * `budget` behind on a Google model — the schema now rejects that key, so a
 * leftover would fail validation on the next admin save. The budget → level
 * mapping is asserted against `BaseAdapter`'s own, which is what every provider
 * that still reads a budget applies.
 *
 * The **retirement** of Gemini 2.x follows V089's semantics: delete a file that
 * is still the example we shipped, disable one the admin has edited. The
 * distinction is the whole point — a customized file may be an operator's own
 * Vertex or proxy endpoint, and its url, headers and per-model key exist
 * nowhere else.
 *
 * The **repointing** keeps apps working: an app whose `preferredModel` was just
 * deleted *or* disabled has no model at all, so both cases move it on.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, version, description } from '../migrations/V104__gemini_3_only.js';
import { BaseAdapter } from '../adapters/BaseAdapter.js';
import { modelConfigSchema } from '../validators/modelConfigSchema.js';

let dir;

/** A migration context over a scratch contents directory. */
function makeCtx(base) {
  const logs = [];
  return {
    logs,
    readJson: async rel => JSON.parse(await fs.readFile(path.join(base, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
      await fs.writeFile(path.join(base, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    deleteFile: async rel => fs.unlink(path.join(base, rel)),
    listFiles: async (subdir, pattern) => {
      const entries = await fs.readdir(path.join(base, subdir)).catch(() => []);
      if (!pattern) return entries;
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return entries.filter(e => new RegExp(`^${escaped}$`).test(e));
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function writeModel(id, model) {
  await fs.mkdir(path.join(dir, 'models'), { recursive: true });
  await fs.writeFile(path.join(dir, `models/${id}.json`), JSON.stringify(model, null, 2), 'utf8');
}

async function readModel(id) {
  return JSON.parse(await fs.readFile(path.join(dir, `models/${id}.json`), 'utf8'));
}

/** A minimally valid Google model config. */
function googleModel(thinking, overrides = {}) {
  return {
    id: 'gem',
    modelId: 'gemini-3.1-pro',
    name: { en: 'Gem' },
    description: { en: 'Gem' },
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:streamGenerateContent',
    provider: 'google',
    thinking,
    ...overrides
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v104-'));
  await fs.mkdir(path.join(dir, 'models'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('V104 metadata', () => {
  it('declares its version and description', () => {
    assert.equal(version, '104');
    assert.equal(description, 'gemini_3_only');
  });
});

describe('V104 — budget becomes level', () => {
  const cases = [
    [0, 'minimal'],
    [-1, 'medium'],
    [1, 'low'],
    [100, 'low'],
    [101, 'medium'],
    [500, 'medium'],
    [501, 'high'],
    [8000, 'high']
  ];

  for (const [budget, level] of cases) {
    it(`converts budget ${budget} to level "${level}"`, async () => {
      await writeModel('gem', googleModel({ enabled: true, budget }));

      await up(makeCtx(dir));

      const { thinking } = await readModel('gem');
      assert.equal(thinking.level, level);
      assert.ok(!('budget' in thinking), 'the schema rejects a leftover budget');
      assert.equal(thinking.enabled, true, 'the rest of the block is preserved');
    });
  }

  it('maps every budget exactly as BaseAdapter does', async () => {
    const base = new BaseAdapter();
    for (const [budget, level] of cases) {
      assert.equal(
        base.resolveReasoningEffort({ thinkingBudget: budget }, {}),
        level,
        `BaseAdapter disagrees about budget ${budget}`
      );
    }
  });

  it('keeps thoughts alongside the new level', async () => {
    await writeModel('gem', googleModel({ enabled: true, budget: -1, thoughts: false }));

    await up(makeCtx(dir));

    const { thinking } = await readModel('gem');
    assert.equal(thinking.level, 'medium');
    assert.equal(thinking.thoughts, false, 'includeThoughts is still a Gemini 3 field');
  });

  it('produces a config the model schema accepts', async () => {
    await writeModel('gem', googleModel({ enabled: true, budget: 8000 }));

    await up(makeCtx(dir));

    const result = modelConfigSchema.safeParse(await readModel('gem'));
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it('rejects the pre-migration shape, which is the point', () => {
    const result = modelConfigSchema.safeParse(googleModel({ enabled: true, budget: 8000 }));

    assert.equal(result.success, false);
    assert.ok(result.error.issues.some(i => i.path.join('.') === 'thinking.budget'));
  });
});

describe('V104 — what it must not touch', () => {
  it('leaves a level the operator already chose', async () => {
    await writeModel('gem', googleModel({ enabled: true, level: 'minimal', budget: 8000 }));

    const ctx = makeCtx(dir);
    await up(ctx);

    const { thinking } = await readModel('gem');
    assert.equal(thinking.level, 'minimal', 'a stale budget does not get to override a choice');
    assert.ok(!('budget' in thinking));
  });

  it('leaves non-Google providers alone', async () => {
    const anthropic = {
      id: 'claude',
      modelId: 'claude-opus-5',
      name: { en: 'C' },
      description: { en: 'C' },
      url: 'https://api.anthropic.com/v1/messages',
      provider: 'anthropic',
      thinking: { enabled: true, budget: 8000, thoughts: true }
    };
    await writeModel('claude', anthropic);

    await up(makeCtx(dir));

    assert.deepEqual(
      (await readModel('claude')).thinking,
      { enabled: true, budget: 8000, thoughts: true },
      'Anthropic reads budget as budget_tokens'
    );
  });

  it('leaves a Google model that never had a budget alone', async () => {
    const before = googleModel({ enabled: true, level: 'high' });
    await writeModel('gem', before);

    await up(makeCtx(dir));

    assert.deepEqual(await readModel('gem'), before);
  });

  it('leaves a Google model with no thinking block alone', async () => {
    const before = googleModel(undefined);
    delete before.thinking;
    await writeModel('gem', before);

    await up(makeCtx(dir));

    assert.deepEqual(await readModel('gem'), before);
  });

  it('skips an unparseable model file instead of aborting the run', async () => {
    await fs.writeFile(path.join(dir, 'models/broken.json'), '{ not json', 'utf8');
    await writeModel('gem', googleModel({ enabled: true, budget: -1 }));

    const ctx = makeCtx(dir);
    await up(ctx);

    assert.equal((await readModel('gem')).thinking.level, 'medium');
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('broken.json')));
  });

  it('is idempotent', async () => {
    await writeModel('gem', googleModel({ enabled: true, budget: 101 }));

    await up(makeCtx(dir));
    const first = await readModel('gem');
    await up(makeCtx(dir));

    assert.deepEqual(await readModel('gem'), first);
  });
});

describe('V104 — retiring Gemini 2.x', () => {
  /** The gemini-2.5-pro example exactly as iHub shipped it. */
  function shippedExample(overrides = {}) {
    return googleModel(
      { enabled: true, budget: -1 },
      {
        id: 'gemini-2.5-pro',
        modelId: 'gemini-2.5-pro',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent',
        enabled: true,
        ...overrides
      }
    );
  }

  it('deletes a file still matching the shipped example', async () => {
    await writeModel('gemini-2.5-pro', shippedExample());

    const ctx = makeCtx(dir);
    await up(ctx);

    await assert.rejects(() => readModel('gemini-2.5-pro'), "ours to remove, not the admin's");
    assert.ok(ctx.logs.some(([, m]) => m.includes('Removed Gemini 2.x model gemini-2.5-pro')));
  });

  it('disables rather than deletes a customized file', async () => {
    await writeModel(
      'gemini-2.5-pro',
      shippedExample({
        url: 'https://vertex.internal.example/v1/gemini-2.5-pro:streamGenerateContent'
      })
    );

    const ctx = makeCtx(dir);
    await up(ctx);

    const model = await readModel('gemini-2.5-pro');
    assert.equal(model.enabled, false, 'out of every selector, same as deletion');
    assert.equal(
      model.url,
      'https://vertex.internal.example/v1/gemini-2.5-pro:streamGenerateContent',
      'an operator endpoint is not reconstructible from anywhere else'
    );
    assert.ok(ctx.logs.some(([, m]) => m.includes('disabled it instead of deleting')));
  });

  it('treats a model id it has never shipped as customized', async () => {
    await writeModel(
      'house-gemini',
      googleModel(
        { enabled: true, budget: -1 },
        {
          id: 'house-gemini',
          modelId: 'gemini-2.5-flash-8b',
          url: 'https://proxy.internal/v1',
          enabled: true
        }
      )
    );

    await up(makeCtx(dir));

    assert.equal((await readModel('house-gemini')).enabled, false);
  });

  it('leaves an already-disabled legacy model disabled', async () => {
    await writeModel('gemini-2.5-pro', shippedExample({ url: 'https://custom/x', enabled: false }));

    await up(makeCtx(dir));

    const model = await readModel('gemini-2.5-pro');
    assert.equal(model.enabled, false);
    assert.equal(model.url, 'https://custom/x', 'still not ours to rewrite');
  });

  it('does not touch Gemini 3.x', async () => {
    await writeModel(
      'gem',
      googleModel({ enabled: true, budget: -1 }, { modelId: 'gemini-3.1-pro' })
    );

    await up(makeCtx(dir));

    const model = await readModel('gem');
    assert.equal(model.enabled, undefined, 'not disabled');
    assert.equal(model.thinking.level, 'medium', 'converted, not retired');
  });

  it('leaves a disabled model the schema still accepts', async () => {
    // A disabled file stays on disk and is re-validated on every startup, so a
    // leftover thinking.budget would warn forever — the schema now rejects it.
    await writeModel(
      'gemini-2.5-pro',
      shippedExample({ url: 'https://vertex.internal.example/v1', enabled: true })
    );

    await up(makeCtx(dir));

    const model = await readModel('gemini-2.5-pro');
    assert.equal(model.enabled, false);
    assert.ok(!('budget' in model.thinking), 'would warn on every boot');
    assert.equal(model.thinking.level, 'medium');

    const result = modelConfigSchema.safeParse(model);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it('warns when a retired model was the system-wide default', async () => {
    await writeModel('gemini-2.5-pro', shippedExample({ default: true }));

    const ctx = makeCtx(dir);
    await up(ctx);

    assert.ok(
      ctx.logs.some(([level, m]) => level === 'warn' && m.includes('system-wide')),
      'silently losing the default would strand every app without a preferredModel'
    );
  });
});

describe('V104 — repointing apps', () => {
  async function writeApp(id, app) {
    await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
    await fs.writeFile(path.join(dir, `apps/${id}.json`), JSON.stringify(app, null, 2), 'utf8');
  }
  async function readApp(id) {
    return JSON.parse(await fs.readFile(path.join(dir, `apps/${id}.json`), 'utf8'));
  }

  beforeEach(async () => {
    await writeModel(
      'gemini-2.5-pro',
      googleModel(
        { enabled: true, budget: -1 },
        {
          id: 'gemini-2.5-pro',
          modelId: 'gemini-2.5-pro',
          url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent'
        }
      )
    );
  });

  it('moves preferredModel to the replacement', async () => {
    await writeApp('chat', { id: 'chat', preferredModel: 'gemini-2.5-pro' });

    await up(makeCtx(dir));

    assert.equal((await readApp('chat')).preferredModel, 'gemini-3.1-pro');
  });

  it('rewrites allowedModels without duplicating an existing entry', async () => {
    await writeApp('chat', {
      id: 'chat',
      allowedModels: ['gemini-2.5-pro', 'gemini-3.1-pro', 'gpt-5']
    });

    await up(makeCtx(dir));

    assert.deepEqual((await readApp('chat')).allowedModels, ['gemini-3.1-pro', 'gpt-5']);
  });

  it('repoints away from a disabled model too, not just a deleted one', async () => {
    await writeModel(
      'gemini-2.5-pro',
      googleModel(
        { enabled: true, budget: -1 },
        {
          id: 'gemini-2.5-pro',
          modelId: 'gemini-2.5-pro',
          url: 'https://custom/endpoint',
          enabled: true
        }
      )
    );
    await writeApp('chat', { id: 'chat', preferredModel: 'gemini-2.5-pro' });

    await up(makeCtx(dir));

    assert.equal((await readModel('gemini-2.5-pro')).enabled, false);
    assert.equal(
      (await readApp('chat')).preferredModel,
      'gemini-3.1-pro',
      'an app pointed at a disabled model has no model at all'
    );
  });

  it('leaves apps that referenced nothing retired alone', async () => {
    const before = { id: 'chat', preferredModel: 'gpt-5', allowedModels: ['gpt-5'] };
    await writeApp('chat', before);

    await up(makeCtx(dir));

    assert.deepEqual(await readApp('chat'), before);
  });

  it('survives an apps directory that does not exist', async () => {
    await up(makeCtx(dir));

    assert.rejects(() => readModel('gemini-2.5-pro'));
  });
});
