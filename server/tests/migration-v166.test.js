#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V166 specs — every workflow end step gets an `output`.
 *
 * The output is the answer a chat shows. Before, the answer was picked from the
 * whole result: the `chatIntegration.primaryOutput` a workflow named, else the
 * first conventional name (`finalReport`, `report`, …), else everything as
 * JSON. The migration gives each end step the output that rule would have
 * picked (for the last, an object of what the end step passes on), and drops
 * `primaryOutput` and `passthroughResult`.
 *
 * Run: node --test server/tests/migration-v166.test.js
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
  description
} from '../migrations/V166__workflow_end_step_output.js';
import { workflowConfigSchema } from '../validators/workflowConfigSchema.js';

const DEFAULT_WORKFLOWS_DIR = fileURLToPath(new URL('../defaults/workflows', import.meta.url));

let baseDir = null;

/** A migration context over a real `contents/` directory, like the runner's. */
function makeCtx(dir) {
  const logs = [];
  const writes = [];
  return {
    logs,
    writes,
    listFiles: async (directory, pattern) => {
      let entries;
      try {
        entries = await fs.readdir(path.join(dir, directory));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      return pattern === '*.json' ? entries.filter(name => name.endsWith('.json')) : entries;
    },
    fileExists: async rel => {
      try {
        await fs.access(path.join(dir, rel));
        return true;
      } catch {
        return false;
      }
    },
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      writes.push(rel);
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

/** A `contents/` directory holding the given workflow files (name -> JSON value or raw text). */
async function freshDir(workflows = {}, legacy = null) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  await fs.mkdir(path.join(dir, 'workflows'), { recursive: true });
  for (const [name, workflow] of Object.entries(workflows)) {
    const text = typeof workflow === 'string' ? workflow : JSON.stringify(workflow, null, 2);
    await fs.writeFile(path.join(dir, 'workflows', name), text, 'utf8');
  }
  if (legacy) {
    await fs.mkdir(path.join(dir, 'config'), { recursive: true });
    await fs.writeFile(path.join(dir, 'config', 'workflows.json'), JSON.stringify(legacy), 'utf8');
  }
  return dir;
}

const readWorkflow = async (dir, name) =>
  JSON.parse(await fs.readFile(path.join(dir, 'workflows', name), 'utf8'));

const node = (id, type, config = {}) => ({
  id,
  type,
  name: { en: id },
  position: { x: 0, y: 0 },
  config
});

/** A workflow with a start step, the given steps, and one end step. */
const workflow = ({ id = 'wf', end = {}, chatIntegration, steps = [] }) => ({
  id,
  name: { en: id },
  description: { en: id },
  version: '1.0.0',
  ...(chatIntegration ? { chatIntegration } : {}),
  nodes: [node('start', 'start'), ...steps, node('end', 'end', end)],
  edges: [{ id: 'e1', source: 'start', target: 'end' }]
});

const outputOf = (wf, endId = 'end') => wf.nodes.find(n => n.id === endId).config.output;

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v166-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V166 every workflow end step gets an output', () => {
  it('exports its version and description, matching the file name', () => {
    assert.equal(version, '166');
    assert.equal(description, 'workflow_end_step_output');
  });

  it('runs only when there are workflow files', async () => {
    assert.equal(await precondition(makeCtx(await fs.mkdtemp(path.join(baseDir, 'none-')))), false);
    assert.equal(await precondition(makeCtx(await freshDir())), false);
    assert.equal(await precondition(makeCtx(await freshDir({ 'a.json': workflow({}) }))), true);
    assert.equal(await precondition(makeCtx(await freshDir({}, []))), true);
  });

  describe('the output', () => {
    it('is the primary output the workflow named, which is dropped', async () => {
      const dir = await freshDir({
        'a.json': workflow({
          end: { outputVariables: ['topic', 'analysis', 'summary'] },
          chatIntegration: { enabled: true, primaryOutput: 'analysis', outputFormat: 'markdown' }
        })
      });
      await up(makeCtx(dir));
      const wf = await readWorkflow(dir, 'a.json');
      assert.equal(outputOf(wf), 'analysis');
      // Everything else stays: the variables the end step passes on, and the rest of the block
      assert.deepEqual(wf.nodes.find(n => n.id === 'end').config.outputVariables, [
        'topic',
        'analysis',
        'summary'
      ]);
      assert.deepEqual(wf.chatIntegration, { enabled: true, outputFormat: 'markdown' });
    });

    it('keeps a path into a variable as it is', async () => {
      const dir = await freshDir({
        'a.json': workflow({
          end: { outputVariables: ['report'] },
          chatIntegration: { primaryOutput: '_report.markdown' }
        })
      });
      await up(makeCtx(dir));
      assert.equal(outputOf(await readWorkflow(dir, 'a.json')), '_report.markdown');
    });

    it('is the first conventional answer name the end step passes on, in the order the chat looked', async () => {
      const dir = await freshDir({
        // `summary` comes before `text`, whatever the order of the list
        'a.json': workflow({ end: { outputVariables: ['text', 'summary', 'topic'] } }),
        'b.json': workflow({ end: { outputVariables: ['summary', 'report', 'x'] } }),
        'c.json': workflow({ end: { includeFields: ['message', 'finalReport'] } })
      });
      await up(makeCtx(dir));
      assert.equal(outputOf(await readWorkflow(dir, 'a.json')), 'summary');
      assert.equal(outputOf(await readWorkflow(dir, 'b.json')), 'report');
      assert.equal(outputOf(await readWorkflow(dir, 'c.json')), 'finalReport');
    });

    it('is looked for among every variable the steps write, for an end step that passes on all of them', async () => {
      const dir = await freshDir({
        'a.json': workflow({
          end: {},
          steps: [node('write', 'prompt', { outputVariable: 'content' })]
        }),
        'b.json': workflow({
          end: { excludeFields: ['content'] },
          steps: [
            node('w1', 'prompt', { outputVariable: 'content' }),
            node('w2', 'prompt', { outputVariable: 'result' })
          ]
        })
      });
      await up(makeCtx(dir));
      assert.equal(outputOf(await readWorkflow(dir, 'a.json')), 'content');
      // `content` is not passed on, so the next one is
      assert.equal(outputOf(await readWorkflow(dir, 'b.json')), 'result');
    });

    it('is what a mapped key maps to, for an end step with a mapping', async () => {
      const dir = await freshDir({
        'named.json': workflow({
          end: { outputMapping: { shown: '$.data.finalReport', other: '$.data.x' } },
          chatIntegration: { primaryOutput: 'shown' }
        }),
        'nested.json': workflow({
          end: { outputMapping: { shown: '$.data.report' } },
          chatIntegration: { primaryOutput: 'shown.markdown' }
        }),
        'conventional.json': workflow({
          end: { outputMapping: { report: '$.data.draft', plan: '$.data.p' } }
        }),
        // A source that never found anything at the state root is the variable it meant
        'rootless.json': workflow({
          end: { outputMapping: { report: '$.finalReport', plan: '$.researchPlan' } }
        })
      });
      await up(makeCtx(dir));
      assert.equal(outputOf(await readWorkflow(dir, 'named.json')), '$.data.finalReport');
      assert.equal(outputOf(await readWorkflow(dir, 'nested.json')), '$.data.report.markdown');
      assert.equal(outputOf(await readWorkflow(dir, 'conventional.json')), '$.data.draft');
      assert.equal(outputOf(await readWorkflow(dir, 'rootless.json')), 'finalReport');
    });

    it('is the answer of a shipped workflow whose answer has no conventional name', async () => {
      const dir = await freshDir({
        'qa.json': workflow({
          id: 'knowledge-qa',
          end: { outputVariables: ['question', 'classification', 'answer'] }
        }),
        'agent.json': workflow({
          id: 'claude-style-agent',
          end: { outputVariables: ['draft', 'currentInboxItem'] }
        })
      });
      await up(makeCtx(dir));
      assert.equal(outputOf(await readWorkflow(dir, 'qa.json')), 'answer');
      assert.equal(outputOf(await readWorkflow(dir, 'agent.json')), 'draft');
    });

    it('is set for every end step of a workflow with several', async () => {
      const wf = workflow({ id: 'approval-workflow', end: {} });
      wf.nodes = [
        node('start', 'start'),
        node('end-approved', 'end', { outputVariables: ['topic', 'summary'] }),
        node('end-rejected', 'end', { outputVariables: ['topic'], status: 'rejected' })
      ];
      wf.edges = [
        { id: 'e1', source: 'start', target: 'end-approved' },
        { id: 'e2', source: 'start', target: 'end-rejected' }
      ];
      const dir = await freshDir({ 'a.json': wf });
      await up(makeCtx(dir));
      const migrated = await readWorkflow(dir, 'a.json');
      assert.equal(outputOf(migrated, 'end-approved'), 'summary');
      assert.equal(outputOf(migrated, 'end-rejected'), 'Rejected: {{topic}}');
    });
  });

  describe('what is left alone', () => {
    it('an end step that already has an output, and its workflow file', async () => {
      const dir = await freshDir({
        'a.json': workflow({
          end: { output: 'mine', outputVariables: ['finalReport', 'mine'] }
        })
      });
      const ctx = makeCtx(dir);
      await up(ctx);
      assert.equal(outputOf(await readWorkflow(dir, 'a.json')), 'mine');
      assert.deepEqual(ctx.writes, [], 'nothing to write');
    });

    it('a workflow with no end step, and files that cannot be read', async () => {
      const dir = await freshDir({
        'no-end.json': { id: 'x', nodes: [node('start', 'start')], edges: [] },
        'broken.json': '{ not json',
        'list.json': '[]'
      });
      const ctx = makeCtx(dir);
      await up(ctx);
      assert.deepEqual(ctx.writes, []);
      assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && /broken\.json/.test(m)));
    });

    it('the primary output of a workflow that never had end steps to give it to is still dropped', async () => {
      const dir = await freshDir({
        'a.json': { id: 'x', nodes: [], edges: [], chatIntegration: { primaryOutput: 'r' } }
      });
      await up(makeCtx(dir));
      assert.equal('primaryOutput' in (await readWorkflow(dir, 'a.json')).chatIntegration, false);
    });
  });

  describe('an end step with no single answer', () => {
    it('gets an object of what it passes on: the result it gave before, still JSON', async () => {
      const dir = await freshDir({
        'custom.json': workflow({
          id: 'custom',
          end: { outputVariables: ['alpha', 'beta'] }
        })
      });
      const ctx = makeCtx(dir);
      await up(ctx);
      const wf = await readWorkflow(dir, 'custom.json');
      assert.deepEqual(outputOf(wf), { alpha: 'alpha', beta: 'beta' });
      assert.equal(workflowConfigSchema.safeParse(wf).success, true);
      // It says so, so an admin can name the one that is the answer
      const note = ctx.logs.find(
        ([level, text]) => level === 'info' && /No single answer/.test(text)
      );
      assert.match(note[1], /custom \(end\)/);
      assert.equal(
        ctx.logs.some(([level]) => level === 'warn'),
        false
      );
    });

    it('does not guess from a variable that merely sits in the list', async () => {
      const dir = await freshDir({
        'a.json': workflow({ id: 'a', end: { outputVariables: ['answer', 'classification'] } })
      });
      await up(makeCtx(dir));
      assert.deepEqual(outputOf(await readWorkflow(dir, 'a.json')), {
        answer: 'answer',
        classification: 'classification'
      });
    });

    it('takes the variables the steps write for an end step that passes on all of them', async () => {
      const dir = await freshDir({
        'all.json': workflow({
          id: 'all',
          steps: [node('p', 'prompt', { outputVariable: 'notes' })],
          end: {}
        })
      });
      await up(makeCtx(dir));
      assert.deepEqual(outputOf(await readWorkflow(dir, 'all.json')), { notes: 'notes' });
    });

    it('takes the mapped keys of an end step with an output mapping, as the paths they map to', async () => {
      const dir = await freshDir({
        'mapped.json': workflow({
          id: 'mapped',
          end: {
            outputMapping: { verdict: '$.data.check', sources: '$.nodeOutputs.search.results' }
          }
        })
      });
      await up(makeCtx(dir));
      assert.deepEqual(outputOf(await readWorkflow(dir, 'mapped.json')), {
        verdict: '$.data.check',
        sources: '$.nodeOutputs.search.results'
      });
    });

    it('is still decided by a conventional name before it is an object', async () => {
      const dir = await freshDir({
        'a.json': workflow({ id: 'a', end: { outputVariables: ['alpha', 'report'] } })
      });
      await up(makeCtx(dir));
      assert.equal(outputOf(await readWorkflow(dir, 'a.json')), 'report');
    });
  });

  describe('the variables the steps write', () => {
    it('include what a transform sets, so the answer it computes is found', async () => {
      const dir = await freshDir({
        'computed.json': workflow({
          id: 'computed',
          steps: [node('t', 'transform', { operations: [{ set: 'finalReport', value: 'x' }] })],
          end: {}
        })
      });
      await up(makeCtx(dir));
      assert.equal(outputOf(await readWorkflow(dir, 'computed.json')), 'finalReport');
    });

    it('follow the editor: transform destinations, loop counters, start defaults, fixed names', async () => {
      const dir = await freshDir({
        'many.json': workflow({
          id: 'many',
          steps: [
            node('start2', 'start', { defaults: { greeting: 'hi' }, inputMapping: { who: 'x' } }),
            node('t', 'transform', {
              operations: [
                { to: 'alpha', from: 'b' },
                { into: 'merged.deep' },
                { increment: 'counter' },
                'not an operation'
              ]
            }),
            node('loop', 'loop', {
              countInto: 'rounds',
              body: [node('inner', 'prompt', { outputVariable: 'inside' })]
            }),
            node('c', 'corpus-search', {}),
            node('h', 'human', {}),
            node('v', 'verifier', {})
          ],
          end: {}
        })
      });
      await up(makeCtx(dir));
      const fields = Object.keys(outputOf(await readWorkflow(dir, 'many.json')));
      assert.deepEqual(
        fields.sort(),
        [
          '_corpus',
          '_coverage',
          'alpha',
          'counter',
          'greeting',
          'humanResponse_h',
          'inside',
          'merged',
          'rounds',
          'verificationResult',
          'who'
        ].sort()
      );
    });

    it('cannot be listed for a workflow with a planner: an end step that passes on all is left to an admin', async () => {
      const dir = await freshDir({
        'planned.json': workflow({
          id: 'planned',
          steps: [
            node('p', 'planner', {}),
            node('t', 'transform', { operations: [{ set: 'summary' }] })
          ],
          end: {}
        })
      });
      const ctx = makeCtx(dir);
      await up(ctx);
      // Not even the `summary` it can see: the planner may write a name that comes before it
      assert.equal(outputOf(await readWorkflow(dir, 'planned.json')), undefined);
      assert.match(ctx.logs.find(([level]) => level === 'warn')[1], /planned \(end\)/);
    });

    it('do not matter to an end step that names what it passes on', async () => {
      const dir = await freshDir({
        'named.json': workflow({
          id: 'named',
          steps: [node('p', 'planner', {})],
          end: { outputVariables: ['alpha', 'beta'] }
        })
      });
      await up(makeCtx(dir));
      assert.deepEqual(outputOf(await readWorkflow(dir, 'named.json')), {
        alpha: 'alpha',
        beta: 'beta'
      });
    });
  });

  describe('a mapping to the run state', () => {
    it('keeps a path that starts at a part of the state, `$.executionId` among them', async () => {
      const dir = await freshDir({
        'ids.json': workflow({
          id: 'ids',
          end: { outputMapping: { runId: '$.executionId', done: '$.completedNodes' } }
        }),
        'picked.json': workflow({
          id: 'picked',
          end: { outputMapping: { runId: '$.executionId' } },
          chatIntegration: { primaryOutput: 'runId' }
        }),
        'old.json': workflow({
          id: 'old',
          end: { outputMapping: { a: '$.finalReport', b: '$.data.kept' } }
        })
      });
      await up(makeCtx(dir));
      assert.deepEqual(outputOf(await readWorkflow(dir, 'ids.json')), {
        runId: '$.executionId',
        done: '$.completedNodes'
      });
      assert.equal(outputOf(await readWorkflow(dir, 'picked.json')), '$.executionId');
      // A path that starts at no part of the state never found anything: it names the variable
      assert.deepEqual(outputOf(await readWorkflow(dir, 'old.json')), {
        a: 'finalReport',
        b: '$.data.kept'
      });
    });
  });

  describe('a primary output that is a mapped literal', () => {
    it('is left to an admin, not turned into a variable that is never set', async () => {
      const dir = await freshDir({
        'literal.json': workflow({
          id: 'literal',
          end: { outputMapping: { shown: 'Fixed text', other: '$.data.x' } },
          chatIntegration: { primaryOutput: 'shown' }
        })
      });
      const ctx = makeCtx(dir);
      await up(ctx);
      const wf = await readWorkflow(dir, 'literal.json');
      assert.equal(outputOf(wf), undefined);
      assert.match(ctx.logs.find(([level]) => level === 'warn')[1], /literal \(end\)/);
      // The selection is gone all the same: it no longer exists
      assert.equal('primaryOutput' in (wf.chatIntegration || {}), false);
    });
  });

  describe('what needs an admin', () => {
    it('is an end step that passes on nothing that can be named: listed, left without an output', async () => {
      const dir = await freshDir({
        'empty.json': workflow({ id: 'empty', end: { outputVariables: [] } })
      });
      const ctx = makeCtx(dir);
      await up(ctx);
      const wf = await readWorkflow(dir, 'empty.json');
      assert.equal(outputOf(wf), undefined);
      const warning = ctx.logs.find(([level]) => level === 'warn');
      assert.match(warning[1], /empty \(end\)/);
      assert.match(warning[1], /Set the Output/);
      // It is refused on save until an admin sets one
      assert.equal(workflowConfigSchema.safeParse(wf).success, false);
    });

    it('is an end step that maps a key to a literal, which an output cannot say', async () => {
      const dir = await freshDir({
        'literal.json': workflow({
          id: 'literal',
          end: { outputMapping: { verdict: '$.data.check', label: 'fixed text' } }
        })
      });
      const ctx = makeCtx(dir);
      await up(ctx);
      assert.equal(outputOf(await readWorkflow(dir, 'literal.json')), undefined);
      assert.match(ctx.logs.find(([level]) => level === 'warn')[1], /literal \(end\)/);
    });
  });

  describe('chatIntegration.passthroughResult', () => {
    it('is removed: no code ever read it', async () => {
      const dir = await freshDir({
        'a.json': workflow({
          id: 'a',
          end: { output: 'report' },
          chatIntegration: { enabled: true, passthroughResult: false, outputFormat: 'text' }
        })
      });
      const ctx = makeCtx(dir);
      await up(ctx);
      assert.deepEqual((await readWorkflow(dir, 'a.json')).chatIntegration, {
        enabled: true,
        outputFormat: 'text'
      });
      assert.deepEqual(ctx.writes, ['workflows/a.json']);
    });
  });

  describe('the legacy workflows file', () => {
    it('is migrated like the files, and written back as the list it is', async () => {
      const dir = await freshDir({}, [
        workflow({
          id: 'legacy',
          end: { outputVariables: ['finalReport'] },
          chatIntegration: { primaryOutput: 'finalReport', enabled: true }
        }),
        workflow({ id: 'other', end: { outputVariables: ['report'] } })
      ]);
      const ctx = makeCtx(dir);
      await up(ctx);
      const legacy = JSON.parse(await fs.readFile(path.join(dir, 'config/workflows.json'), 'utf8'));
      assert.ok(Array.isArray(legacy));
      assert.equal(outputOf(legacy[0]), 'finalReport');
      assert.equal(outputOf(legacy[1]), 'report');
      assert.deepEqual(legacy[0].chatIntegration, { enabled: true });
      assert.deepEqual(ctx.writes, ['config/workflows.json']);
    });
  });

  it('running it again changes nothing', async () => {
    const dir = await freshDir({
      'a.json': workflow({
        end: { outputVariables: ['finalReport'] },
        chatIntegration: { primaryOutput: 'finalReport' }
      }),
      'custom.json': workflow({ id: 'custom', end: { outputVariables: ['alpha', 'beta'] } }),
      'empty.json': workflow({ id: 'empty', end: { outputVariables: [] } })
    });
    await up(makeCtx(dir));
    const before = {
      a: await readWorkflow(dir, 'a.json'),
      custom: await readWorkflow(dir, 'custom.json'),
      empty: await readWorkflow(dir, 'empty.json')
    };
    const again = makeCtx(dir);
    await up(again);
    assert.deepEqual(again.writes, []);
    assert.deepEqual(await readWorkflow(dir, 'a.json'), before.a);
    assert.deepEqual(await readWorkflow(dir, 'custom.json'), before.custom);
    assert.deepEqual(await readWorkflow(dir, 'empty.json'), before.empty);
  });
});

describe('the workflows that ship with iHub', () => {
  /** The shipped workflows, by file name. */
  async function shipped() {
    const files = (await fs.readdir(DEFAULT_WORKFLOWS_DIR)).filter(name => name.endsWith('.json'));
    const all = {};
    for (const name of files) {
      all[name] = JSON.parse(await fs.readFile(path.join(DEFAULT_WORKFLOWS_DIR, name), 'utf8'));
    }
    return all;
  }

  it('give every end step an output, which the schema accepts', async () => {
    const all = await shipped();
    assert.ok(Object.keys(all).length >= 17);
    for (const [name, wf] of Object.entries(all)) {
      for (const end of wf.nodes.filter(n => n.type === 'end')) {
        assert.ok(
          typeof end.config?.output === 'string' && end.config.output.trim() !== '',
          `${name}: end step '${end.id}' has no output`
        );
      }
      const result = workflowConfigSchema.safeParse(wf);
      assert.equal(
        result.success,
        true,
        `${name}: ${result.error?.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`
      );
      assert.equal('primaryOutput' in (wf.chatIntegration || {}), false, name);
      assert.equal('passthroughResult' in (wf.chatIntegration || {}), false, name);
    }
  });

  it('are what the migration makes of them: it has nothing left to do', async () => {
    const all = await shipped();
    const dir = await freshDir(all);
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.deepEqual(ctx.writes, [], 'the shipped workflows already have what V166 gives');
    assert.ok(!ctx.logs.some(([level]) => level === 'warn'), 'and none needs an admin');
  });

  it('answer with the variable their chat answered with before', async () => {
    const all = await shipped();
    const chatEnabled = Object.entries(all).filter(([, wf]) => wf.chatIntegration?.enabled);
    assert.ok(chatEnabled.length >= 10);
    for (const [name, wf] of chatEnabled) {
      assert.equal(outputOf(wf), 'finalReport', name);
    }
  });
});
