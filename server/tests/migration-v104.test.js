#!/usr/bin/env node

/**
 * Migration V104 specs — Gemini configs move onto `thinking.level`.
 *
 * The invariants that matter: the conversion is scoped to Google (Anthropic
 * and OpenAI Responses still read `thinking.budget`, so touching theirs would
 * silently change their reasoning), it never overrides a level an operator
 * already chose, and it leaves no `budget` behind on a Google model — the
 * model schema now rejects that key, so a leftover would fail validation on
 * the next admin save.
 *
 * The budget → level mapping is asserted against `BaseAdapter`'s own, which is
 * what every provider that still reads a budget applies.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, version, description } from '../migrations/V104__gemini_thinking_level_only.js';
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
    assert.equal(description, 'gemini_thinking_level_only');
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

describe('V104 — Gemini 2.x models', () => {
  it('converts them but warns that their thinking will not work', async () => {
    await writeModel(
      'old',
      googleModel({ enabled: true, budget: -1 }, { id: 'old', modelId: 'gemini-2.5-pro' })
    );

    const ctx = makeCtx(dir);
    await up(ctx);

    assert.equal((await readModel('old')).thinking.level, 'medium');
    assert.ok(
      ctx.logs.some(([level, m]) => level === 'warn' && m.includes('gemini-2.5-pro')),
      'the operator is told which models are stranded'
    );
  });

  it('does not delete or disable them', async () => {
    await writeModel(
      'old',
      googleModel(
        { enabled: true, budget: -1 },
        { id: 'old', modelId: 'gemini-2.5-flash', enabled: true }
      )
    );

    await up(makeCtx(dir));

    const model = await readModel('old');
    assert.equal(model.enabled, true, 'a model file may be an operator endpoint, not ours to drop');
  });

  it('does not mistake gemini-3.x for a legacy generation', async () => {
    await writeModel(
      'gem',
      googleModel({ enabled: true, budget: -1 }, { modelId: 'gemini-3.1-pro' })
    );

    const ctx = makeCtx(dir);
    await up(ctx);

    assert.ok(!ctx.logs.some(([level]) => level === 'warn'), 'no stranded-model warning');
  });
});
