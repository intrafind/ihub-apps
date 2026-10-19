#!/usr/bin/env node

/**
 * Migration V170 specs — temperature is no longer an app, agent, workflow or
 * prompt setting.
 *
 * What these pin is restraint as much as reach: only the temperature keys go,
 * every other setting of the same object stays, files that carry none are not
 * rewritten, and an unreadable file never blocks the rest.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, version, description } from '../migrations/V170__remove_temperature_settings.js';

let dir = '';

/** A migration context over a scratch contents directory; counts the writes. */
function makeCtx(base) {
  const logs = [];
  const writes = [];
  return {
    logs,
    writes,
    readJson: async rel => JSON.parse(await fs.readFile(path.join(base, rel), 'utf8')),
    writeJson: async (rel, data) => {
      writes.push(rel);
      await fs.writeFile(path.join(base, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    listFiles: async (subdir, pattern) => {
      const entries = await fs.readdir(path.join(base, subdir)).catch(() => []);
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return entries.filter(e => new RegExp(`^${escaped}$`).test(e));
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function write(rel, data) {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), JSON.stringify(data), 'utf8');
}

async function read(rel) {
  return JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v170-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('V170 metadata', () => {
  it('declares its version and description', () => {
    assert.equal(version, '170');
    assert.equal(description, 'remove_temperature_settings');
  });
});

describe('V170 apps', () => {
  it('removes preferredTemperature and the settings.temperature flag', async () => {
    await write('apps/chat.json', {
      id: 'chat',
      preferredModel: 'gpt-4',
      preferredTemperature: 0.7,
      settings: { temperature: { enabled: false }, outputFormat: { enabled: false } }
    });
    await up(makeCtx(dir));
    assert.deepEqual(await read('apps/chat.json'), {
      id: 'chat',
      preferredModel: 'gpt-4',
      settings: { outputFormat: { enabled: false } }
    });
  });

  it('logs what it dropped, with the value', async () => {
    await write('apps/babelfish.json', { id: 'babelfish', preferredTemperature: 0.2 });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.ok(
      ctx.logs.some(
        ([level, m]) =>
          level === 'info' &&
          m.includes('apps/babelfish.json') &&
          m.includes('preferredTemperature 0.2')
      )
    );
  });

  it('does not rewrite an app without a temperature', async () => {
    await write('apps/plain.json', { id: 'plain', settings: { style: { enabled: true } } });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.deepEqual(ctx.writes, []);
    assert.deepEqual(ctx.logs.at(-1), ['info', 'No temperature settings to remove']);
  });
});

describe('V170 agent profiles', () => {
  it('removes preferredTemperature and the memory composer temperature', async () => {
    await write('agents/profiles/helper.json', {
      id: 'helper',
      preferredTemperature: 1,
      maxIterations: 5,
      memory: { enabled: true, temperature: 0.2, maxBytes: 4096 }
    });
    await up(makeCtx(dir));
    assert.deepEqual(await read('agents/profiles/helper.json'), {
      id: 'helper',
      maxIterations: 5,
      memory: { enabled: true, maxBytes: 4096 }
    });
  });
});

describe('V170 workflows', () => {
  it('removes the temperature of every node that has one', async () => {
    await write('workflows/review.json', {
      id: 'review',
      nodes: [
        { id: 'start', type: 'start' },
        {
          id: 'draft',
          type: 'agent',
          config: { modelId: 'gpt-4', temperature: 0.1, maxTokens: 500 }
        },
        { id: 'check', type: 'agent', config: { temperature: 0.3 } }
      ]
    });
    await up(makeCtx(dir));
    assert.deepEqual((await read('workflows/review.json')).nodes, [
      { id: 'start', type: 'start' },
      { id: 'draft', type: 'agent', config: { modelId: 'gpt-4', maxTokens: 500 } },
      { id: 'check', type: 'agent', config: {} }
    ]);
  });

  it('copes with a workflow without nodes and nodes without a config', async () => {
    await write('workflows/empty.json', { id: 'empty' });
    await write('workflows/odd.json', { id: 'odd', nodes: [null, { id: 'a' }] });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.deepEqual(ctx.writes, []);
  });
});

describe('V170 prompts', () => {
  it('removes a temperature from a prompt', async () => {
    await write('prompts/summarize.json', {
      id: 'summarize',
      prompt: { en: 'Hi' },
      temperature: 0.4
    });
    await up(makeCtx(dir));
    assert.deepEqual(await read('prompts/summarize.json'), {
      id: 'summarize',
      prompt: { en: 'Hi' }
    });
  });
});

describe('V170 robustness', () => {
  it('skips an unreadable file and still migrates the others', async () => {
    await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
    await fs.writeFile(path.join(dir, 'apps', 'broken.json'), '{ not json', 'utf8');
    await write('apps/chat.json', { id: 'chat', preferredTemperature: 0.5 });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('apps/broken.json')));
    assert.equal('preferredTemperature' in (await read('apps/chat.json')), false);
  });

  it('leaves a file that holds a list alone', async () => {
    await write('prompts/all.json', [{ id: 'a', temperature: 0.4 }]);
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.deepEqual(ctx.writes, []);
  });

  it('runs when the directories do not exist', async () => {
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.deepEqual(ctx.logs.at(-1), ['info', 'No temperature settings to remove']);
  });

  it('changes nothing on a second run', async () => {
    await write('apps/chat.json', { id: 'chat', preferredTemperature: 0.5 });
    await write('workflows/w.json', {
      id: 'w',
      nodes: [{ id: 'n', config: { temperature: 0.2 } }]
    });
    await up(makeCtx(dir));
    const app = await read('apps/chat.json');
    const workflow = await read('workflows/w.json');
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.deepEqual(ctx.writes, []);
    assert.deepEqual(await read('apps/chat.json'), app);
    assert.deepEqual(await read('workflows/w.json'), workflow);
  });
});
