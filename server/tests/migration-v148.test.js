#!/usr/bin/env node

/**
 * Migration V148 specs — the code node in the shipped corpus-analysis
 * workflows becomes a transform with an `append` operation, and the step that
 * unpacked its result is removed. Workflows with other code nodes are left as
 * they are and reported.
 */
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
} from '../migrations/V148__replace_workflow_code_accumulator.js';

let baseDir;

function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    listFiles: async (directory, pattern) => {
      const suffix = pattern.replace('*', '');
      try {
        return (await fs.readdir(path.join(dir, directory))).filter(f => f.endsWith(suffix));
      } catch {
        return [];
      }
    },
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function freshDir(workflows) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  await fs.mkdir(path.join(dir, 'workflows'), { recursive: true });
  for (const [file, data] of Object.entries(workflows)) {
    await fs.writeFile(path.join(dir, 'workflows', file), JSON.stringify(data), 'utf8');
  }
  return dir;
}

const readWorkflow = async (dir, file) =>
  JSON.parse(await fs.readFile(path.join(dir, 'workflows', file), 'utf8'));

/** The shape the shipped workflows had before this release. */
function shippedBefore() {
  return {
    id: 'corpus-analysis-decomposed',
    nodes: [
      { id: 'search-subquestion', type: 'corpus-search', config: {} },
      {
        id: 'accumulate-corpus',
        type: 'code',
        position: { x: 100, y: 940 },
        config: {
          chatVisible: false,
          code: 'previous.concat(next)',
          outputVariable: '_corpusAllRaw',
          timeout: 5000
        }
      },
      {
        id: 'unwrap-corpus-accumulator',
        type: 'transform',
        config: {
          chatVisible: false,
          operations: [{ copy: '_corpusAllRaw.result', to: '_corpusAll' }]
        }
      },
      { id: 'init-doc-cursor', type: 'transform', config: { operations: [] } }
    ],
    edges: [
      { id: 'e7', source: 'search-subquestion', target: 'accumulate-corpus' },
      { id: 'e8', source: 'accumulate-corpus', target: 'unwrap-corpus-accumulator' },
      { id: 'e9', source: 'unwrap-corpus-accumulator', target: 'init-doc-cursor' }
    ]
  };
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v148-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V148 replace_workflow_code_accumulator', () => {
  it('declares its version and description', () => {
    assert.equal(version, '148');
    assert.equal(description, 'replace_workflow_code_accumulator');
  });

  it('runs only when there are workflows', async () => {
    assert.equal(await precondition(makeCtx(await freshDir({}))), false);
    const dir = await freshDir({ 'a.json': shippedBefore() });
    assert.equal(await precondition(makeCtx(dir)), true);
  });

  it('turns the shipped accumulator into an append and removes the unwrap step', async () => {
    const dir = await freshDir({ 'corpus-analysis-decomposed.json': shippedBefore() });
    await up(makeCtx(dir));
    const workflow = await readWorkflow(dir, 'corpus-analysis-decomposed.json');

    assert.deepEqual(
      workflow.nodes.map(node => node.id),
      ['search-subquestion', 'accumulate-corpus', 'init-doc-cursor']
    );
    assert.deepEqual(workflow.nodes[1], {
      id: 'accumulate-corpus',
      type: 'transform',
      position: { x: 100, y: 940 },
      config: { chatVisible: false, operations: [{ append: '_corpus', to: '_corpusAll' }] }
    });
    assert.deepEqual(workflow.edges, [
      { id: 'e7', source: 'search-subquestion', target: 'accumulate-corpus' },
      { id: 'e9', source: 'accumulate-corpus', target: 'init-doc-cursor' }
    ]);
  });

  it('handles the accumulator inside an inline loop body', async () => {
    const before = shippedBefore();
    const loop = { id: 'per-subquestion', type: 'loop', config: { body: before.nodes } };
    const dir = await freshDir({ 'v2.json': { ...before, nodes: [loop] } });
    await up(makeCtx(dir));
    const body = (await readWorkflow(dir, 'v2.json')).nodes[0].config.body;
    assert.deepEqual(
      body.map(node => [node.id, node.type]),
      [
        ['search-subquestion', 'corpus-search'],
        ['accumulate-corpus', 'transform'],
        ['init-doc-cursor', 'transform']
      ]
    );
  });

  it('keeps an unwrap step an admin changed, and feeds it the value it reads', async () => {
    const before = shippedBefore();
    before.nodes[2].config.operations.push({ set: '_seen', value: true });
    const dir = await freshDir({ 'custom.json': before });
    await up(makeCtx(dir));
    const workflow = await readWorkflow(dir, 'custom.json');

    assert.ok(workflow.nodes.some(node => node.id === 'unwrap-corpus-accumulator'));
    assert.deepEqual(workflow.nodes[1].config.operations, [
      { append: '_corpus', to: '_corpusAll' },
      { copy: '_corpusAll', to: '_corpusAllRaw.result' }
    ]);
    assert.deepEqual(workflow.edges, before.edges);
  });

  it('leaves other code nodes alone and lists their workflows', async () => {
    const other = {
      id: 'mine',
      nodes: [{ id: 'calc', type: 'code', config: { code: '1 + 1' } }],
      edges: []
    };
    const dir = await freshDir({ 'mine.json': other });
    const ctx = makeCtx(dir);
    await up(ctx);

    assert.deepEqual(await readWorkflow(dir, 'mine.json'), other);
    assert.ok(
      ctx.logs.some(([level, message]) => level === 'warn' && message.includes('mine.json'))
    );
  });
});
