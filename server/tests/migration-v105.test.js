#!/usr/bin/env node

/**
 * Migration V105 specs — reasoning effort is a level everywhere.
 *
 * The conversion itself is the easy half; what these pin is *reach*. The
 * budget lived in three config surfaces — models, apps and workflow nodes —
 * and the schemas now reject it in all three, so anything this migration walks
 * past becomes a validation warning on every startup. Apps and workflow nodes
 * are the ones V104 never looked at.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, version, description } from '../migrations/V105__thinking_level_not_budget.js';
import { BaseAdapter } from '../adapters/BaseAdapter.js';

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

async function write(rel, data) {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
}

async function read(rel) {
  return JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v105-'));
  for (const d of ['models', 'apps', 'workflows']) {
    await fs.mkdir(path.join(dir, d), { recursive: true });
  }
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('V105 metadata', () => {
  it('declares its version and description', () => {
    assert.equal(version, '105');
    assert.equal(description, 'thinking_level_not_budget');
  });
});

describe('V105 — the mapping', () => {
  const cases = [
    [0, 'minimal'],
    [-1, 'medium'],
    [1, 'low'],
    [100, 'low'],
    [101, 'medium'],
    [500, 'medium'],
    [501, 'high'],
    [8000, 'high'],
    [32768, 'high']
  ];

  for (const [budget, level] of cases) {
    it(`converts budget ${budget} to "${level}"`, async () => {
      await write('models/m.json', { id: 'm', thinking: { enabled: true, budget } });

      await up(makeCtx(dir));

      const { thinking } = await read('models/m.json');
      assert.equal(thinking.level, level);
      assert.ok(!('budget' in thinking));
    });
  }

  it('collapses 1024 and 32768 to the same level, which was the confusion', async () => {
    await write('models/a.json', { id: 'a', thinking: { enabled: true, budget: 1024 } });
    await write('models/b.json', { id: 'b', thinking: { enabled: true, budget: 32768 } });

    await up(makeCtx(dir));

    assert.equal((await read('models/a.json')).thinking.level, 'high');
    assert.equal((await read('models/b.json')).thinking.level, 'high');
  });

  it('matches what the adapters resolved a level to, minus the retired half', () => {
    // BaseAdapter no longer takes a budget at all; a level passes through, and
    // nothing resolves to anything but one of the four.
    const base = new BaseAdapter();
    for (const [, level] of cases) {
      assert.equal(base.resolveReasoningEffort({ thinkingLevel: level }, {}), level);
    }
    assert.equal(base.resolveReasoningEffort({}, {}), 'medium', 'unset means medium');
    assert.equal(
      base.resolveReasoningEffort({ thinkingBudget: 8000 }, {}),
      'medium',
      'a budget is no longer an input at all'
    );
  });
});

describe('V105 — every config surface', () => {
  it('converts a model', async () => {
    await write('models/m.json', { id: 'm', provider: 'anthropic', thinking: { budget: 8000 } });

    await up(makeCtx(dir));

    assert.equal((await read('models/m.json')).thinking.level, 'high');
  });

  it('converts an app — which could never express a level before', async () => {
    await write('apps/chat.json', { id: 'chat', thinking: { enabled: true, budget: 50 } });

    await up(makeCtx(dir));

    const { thinking } = await read('apps/chat.json');
    assert.equal(thinking.level, 'low');
    assert.ok(!('budget' in thinking));
    assert.equal(thinking.enabled, true);
  });

  it('converts a workflow node override', async () => {
    await write('workflows/w.json', {
      id: 'w',
      nodes: [
        { id: 'plan', config: { thinking: { enabled: true, budget: 8000 } } },
        { id: 'verdict', config: { thinking: { enabled: true, budget: 0 } } }
      ]
    });

    await up(makeCtx(dir));

    const { nodes } = await read('workflows/w.json');
    assert.equal(nodes[0].config.thinking.level, 'high');
    assert.equal(nodes[1].config.thinking.level, 'minimal');
    assert.ok(nodes.every(n => !('budget' in n.config.thinking)));
  });

  it('converts a node whose thinking sits directly on the node', async () => {
    await write('workflows/w.json', {
      id: 'w',
      nodes: [{ id: 'plan', thinking: { enabled: true, budget: 200 } }]
    });

    await up(makeCtx(dir));

    assert.equal((await read('workflows/w.json')).nodes[0].thinking.level, 'medium');
  });

  it('converts a workflow-level thinking block', async () => {
    await write('workflows/w.json', { id: 'w', thinking: { budget: -1 }, nodes: [] });

    await up(makeCtx(dir));

    assert.equal((await read('workflows/w.json')).thinking.level, 'medium');
  });

  it('reports what it touched across all three', async () => {
    await write('models/m.json', { id: 'm', thinking: { budget: 8000 } });
    await write('apps/a.json', { id: 'a', thinking: { budget: 8000 } });
    await write('workflows/w.json', {
      id: 'w',
      nodes: [{ id: 'n', config: { thinking: { budget: 8000 } } }]
    });

    const ctx = makeCtx(dir);
    await up(ctx);

    assert.ok(ctx.logs.some(([, m]) => m.includes('1 model(s), 1 app(s) and 1 workflow(s)')));
  });
});

describe('V105 — what it must not touch', () => {
  it('keeps a level that is already set', async () => {
    await write('models/m.json', { id: 'm', thinking: { level: 'minimal', budget: 32768 } });

    await up(makeCtx(dir));

    const { thinking } = await read('models/m.json');
    assert.equal(thinking.level, 'minimal', 'an explicit choice outranks a stale number');
    assert.ok(!('budget' in thinking));
  });

  it('leaves a config with no budget byte-identical', async () => {
    const before = { id: 'm', thinking: { enabled: true, level: 'high', thoughts: false } };
    await write('models/m.json', before);

    await up(makeCtx(dir));

    assert.deepEqual(await read('models/m.json'), before);
  });

  it('leaves a config with no thinking block alone', async () => {
    const before = { id: 'm', provider: 'openai' };
    await write('models/m.json', before);

    await up(makeCtx(dir));

    assert.deepEqual(await read('models/m.json'), before);
  });

  it('warns rather than inventing a level for a non-numeric budget', async () => {
    await write('models/m.json', { id: 'm', thinking: { budget: 'lots' } });

    const ctx = makeCtx(dir);
    await up(ctx);

    const { thinking } = await read('models/m.json');
    assert.ok(!('budget' in thinking));
    assert.equal(thinking.level, undefined);
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('not a number')));
  });

  it('skips an unparseable file instead of aborting the run', async () => {
    await fs.writeFile(path.join(dir, 'apps/broken.json'), '{ not json', 'utf8');
    await write('apps/ok.json', { id: 'ok', thinking: { budget: 8000 } });

    const ctx = makeCtx(dir);
    await up(ctx);

    assert.equal((await read('apps/ok.json')).thinking.level, 'high');
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('broken.json')));
  });

  it('survives directories that do not exist', async () => {
    await fs.rm(path.join(dir, 'workflows'), { recursive: true, force: true });
    await fs.rm(path.join(dir, 'apps'), { recursive: true, force: true });
    await write('models/m.json', { id: 'm', thinking: { budget: 8000 } });

    await up(makeCtx(dir));

    assert.equal((await read('models/m.json')).thinking.level, 'high');
  });

  it('is idempotent', async () => {
    await write('models/m.json', { id: 'm', thinking: { budget: 101 } });

    await up(makeCtx(dir));
    const first = await read('models/m.json');
    await up(makeCtx(dir));

    assert.deepEqual(await read('models/m.json'), first);
  });
});
