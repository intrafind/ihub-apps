#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every workflow ends with an output.
 *
 * Every end step has an `output`: the answer a chat shows as it is, and what an
 * API, MCP or A2A caller receives. It may pass on additional information next to
 * it, but there is nothing to select and nothing to guess. These tests pin the
 * pieces: how an end step resolves its output, what a finished workflow hands
 * back, how an answer is read from it, that a workflow without an output is
 * refused on save, and the whole thing through a real run of the engine.
 *
 * Run: node --test server/tests/workflow-end-output.test.js
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EndNodeExecutor } from '../services/workflow/executors/EndNodeExecutor.js';
import { finalOutputOf } from '../services/workflow/finalOutput.js';
import { endOutputLabel, hasEndOutput } from '../../shared/workflowEndOutput.js';
import {
  WorkflowEngine,
  getWorkflowEngine,
  resetWorkflowEngine
} from '../services/workflow/WorkflowEngine.js';
import { StateManager } from '../services/workflow/StateManager.js';
import { actionTracker } from '../actionTracker.js';
import { workflowConfigSchema } from '../validators/workflowConfigSchema.js';
import {
  answerOf,
  chatAnswerFormat,
  chatAnswerOf,
  executionAnswerOf,
  executionOutputOf,
  isJsonAnswer
} from '../../shared/workflowChatOutput.js';
import configCache from '../configCache.js';
import { observeEmittedEnvelopes } from '../services/loop/RunStream.js';
import workflowRunner, { chatTextVariable } from '../tools/workflowRunner.js';
import { buildDefaultWorkflowForProfile } from '../agents/profile/profileWorkflowSerializer.js';
import { SubWorkflowMaterializer } from '../services/workflow/SubWorkflowMaterializer.js';

const executor = new EndNodeExecutor();

/** The result of an end step with `config` over workflow `data`. */
const endResult = (config, data = {}, extraState = {}) =>
  executor.execute(
    { id: 'end', type: 'end', config },
    { data, nodeOutputs: {}, ...extraState },
    {}
  );

describe('an end step resolves its output', () => {
  it('from a variable', async () => {
    const { output } = await endResult({ output: 'finalReport' }, { finalReport: '# Report' });
    assert.equal(output.output, '# Report');
  });

  it('from a path into a variable', async () => {
    const { output } = await endResult(
      { output: 'report.markdown' },
      { report: { markdown: '# Nested', bytes: 9 } }
    );
    assert.equal(output.output, '# Nested');
  });

  it('from a state path', async () => {
    const { output } = await endResult({ output: '$.data.answer' }, { answer: 'From a path' });
    assert.equal(output.output, 'From a path');
  });

  it('from a text with variables', async () => {
    const { output } = await endResult(
      { output: 'Reviewed {{count}} statements: {{verdict}}' },
      { count: 3, verdict: 'ok' }
    );
    assert.equal(output.output, 'Reviewed 3 statements: ok');
  });

  it('keeping a value that is not text as it is', async () => {
    const { output } = await endResult({ output: 'findings' }, { findings: { total: 2 } });
    assert.deepEqual(output.output, { total: 2 });
  });

  it('keeping JSON as JSON, not a string, for a variable, a path and a lone {{variable}}', async () => {
    const data = { findings: { total: 2, items: [1, 2] }, list: ['a', 'b'] };
    for (const spec of ['findings', '$.data.findings', '{{findings}}', '{{ findings }}']) {
      const { output } = await endResult({ output: spec }, data);
      assert.deepEqual(output.output, data.findings, spec);
      assert.equal(typeof output.output, 'object', spec);
    }
    assert.deepEqual(
      (await endResult({ output: '{{findings.items}}' }, data)).output.output,
      [1, 2]
    );
    assert.deepEqual((await endResult({ output: '{{list}}' }, data)).output.output, ['a', 'b']);
  });

  it('keeps other types of a lone {{variable}} as they are, and a missing one empty', async () => {
    const data = { count: 3, ok: false };
    assert.equal((await endResult({ output: '{{count}}' }, data)).output.output, 3);
    assert.equal((await endResult({ output: '{{ok}}' }, data)).output.output, false);
    assert.equal((await endResult({ output: '{{missing}}' }, data)).output.output, '');
  });

  it('builds text, as text, only when there is more than a single {{variable}}', async () => {
    const { output } = await endResult(
      { output: 'Total: {{findings.total}}' },
      { findings: { total: 2 } }
    );
    assert.equal(output.output, 'Total: 2');
  });

  it('as an empty output, not an error, when the variable was never set', async () => {
    const { output, status } = await endResult({ output: 'finalReport' }, { other: 'x' });
    assert.equal(status, 'completed');
    assert.equal(output.output, '');
  });

  it('ignoring spaces around the setting', async () => {
    const { output } = await endResult({ output: '  finalReport  ' }, { finalReport: 'x' });
    assert.equal(output.output, 'x');
  });
});

describe('an end step with an object as its output', () => {
  it('gives an object with a field for each entry, each resolved like a text output', async () => {
    const { output } = await endResult(
      {
        output: {
          topic: 'topic',
          summary: '{{summary}}',
          verdict: 'review.verdict',
          sources: '$.data.review.sources',
          line: 'Done: {{count}} items'
        }
      },
      {
        topic: 'wind',
        summary: 'All good',
        count: 3,
        review: { verdict: 'ok', sources: ['a', 'b'] }
      }
    );
    assert.deepEqual(output.output, {
      topic: 'wind',
      summary: 'All good',
      verdict: 'ok',
      sources: ['a', 'b'],
      line: 'Done: 3 items'
    });
  });

  it('keeps the type of a field: an object stays an object, a list a list', async () => {
    const { output } = await endResult(
      { output: { items: 'items', record: '{{record}}' } },
      { items: [1, 2], record: { a: 1 } }
    );
    assert.deepEqual(output.output, { items: [1, 2], record: { a: 1 } });
  });

  it('leaves out a field whose variable was never set, as listed variables always were', async () => {
    const { output } = await endResult(
      { output: { present: 'present', absent: 'absent', gone: '{{gone}}' } },
      { present: 'here' }
    );
    assert.deepEqual(output.output, { present: 'here' });
  });

  it('is an empty object when none of the fields is there: the run still ends', async () => {
    const { output } = await endResult({ output: { absent: 'absent' } }, {});
    assert.deepEqual(output.output, {});
  });

  it('may nest an object in a field', async () => {
    const { output } = await endResult(
      { output: { report: 'report', meta: { topic: 'topic', missing: 'missing' } } },
      { report: 'R', topic: 'wind' }
    );
    assert.deepEqual(output.output, { report: 'R', meta: { topic: 'wind' } });
  });

  it('is the answer next to the additional information, and wins over a variable named output', async () => {
    const { output } = await endResult(
      { output: { topic: 'topic' }, outputVariables: ['topic', 'output'] },
      { topic: 'wind', output: 'not this' }
    );
    assert.deepEqual(output, { topic: 'wind', output: { topic: 'wind' } });
  });

  it('is JSON to everything that reads the answer', async () => {
    const { output } = await endResult({ output: { topic: 'topic' } }, { topic: 'wind' });
    assert.deepEqual(answerOf(output), { topic: 'wind' });
    assert.equal(isJsonAnswer(output), true);
    assert.deepEqual(JSON.parse(chatAnswerOf(output)), { topic: 'wind' });
    assert.equal(chatAnswerFormat(output, 'markdown'), 'json');
  });

  it('does not take a field name that would reach into the prototype', async () => {
    const spec = JSON.parse('{"__proto__": "topic", "constructor": "topic", "ok": "topic"}');
    // The name is refused when saving; a run that reaches it anyway leaves it out
    assert.equal(hasEndOutput(spec), false);
    const executor = new EndNodeExecutor();
    assert.deepEqual(executor.resolveOutputSpec(spec, { data: { topic: 'wind' } }), { ok: 'wind' });
    assert.equal({}.wind, undefined, 'and nothing else was touched');
  });

  it('does not read a member of the prototype through a path', async () => {
    const { output } = await endResult(
      { output: { name: 'topic.constructor.name', length: 'topic.length' } },
      { topic: 'wind' }
    );
    assert.deepEqual(output.output, { length: 4 });
  });
});

describe('what counts as an output', () => {
  it('is a text that is not blank, or an object whose fields all are', () => {
    for (const spec of ['report', ' report ', '{{x}}', { a: 'a' }, { a: { b: 'b' } }]) {
      assert.equal(hasEndOutput(spec), true, JSON.stringify(spec));
    }
  });

  it('is not nothing, a blank text, an empty object, a blank field or a list', () => {
    for (const spec of [
      undefined,
      null,
      42,
      '',
      '   ',
      {},
      { a: '' },
      { a: '  ' },
      { '': 'a' },
      { a: {} },
      { a: ['x'] },
      ['x']
    ]) {
      assert.equal(hasEndOutput(spec), false, JSON.stringify(spec));
    }
  });

  it('is not an object nested deeper than anyone writes one', () => {
    let spec = 'x';
    for (let depth = 0; depth < 12; depth += 1) spec = { a: spec };
    assert.equal(hasEndOutput(spec), false);
  });

  it('is labeled with its text, or with the names of its fields', () => {
    assert.equal(endOutputLabel(' report '), 'report');
    assert.equal(endOutputLabel({ topic: 't', report: 'r' }), '{ topic, report }');
    assert.equal(endOutputLabel({ a: 'a', b: 'b', c: 'c', d: 'd' }), '{ a, b, c, … }');
    assert.equal(endOutputLabel({}), '');
    assert.equal(endOutputLabel(undefined), '');
  });
});

describe('an end step without an output', () => {
  it('fails, and says which step and what to do', async () => {
    for (const config of [{}, { output: '' }, { output: '   ' }, { output: 42 }, { output: {} }]) {
      await assert.rejects(endResult(config, { finalReport: 'x' }), error => {
        assert.equal(error.code, 'END_OUTPUT_MISSING');
        assert.match(error.message, /end step 'end' has no output/);
        assert.match(error.message, /or to an object of fields/);
        return true;
      });
    }
  });

  it('is not rescued by a variable that happens to have a conventional name', async () => {
    await assert.rejects(
      endResult({ outputVariables: ['finalReport'] }, { finalReport: 'looks like an answer' }),
      /has no output/
    );
  });
});

describe('what else an end step passes on', () => {
  it('stays additional information next to the output', async () => {
    const { output } = await endResult(
      { output: 'finalReport', outputVariables: ['topic', 'finalReport'] },
      { finalReport: '# Report', topic: 'wind', ignored: 'x' }
    );
    assert.deepEqual(output, { topic: 'wind', finalReport: '# Report', output: '# Report' });
  });

  it('works with a mapping, and the output setting wins over a mapped `output`', async () => {
    const { output } = await endResult(
      { output: '$.data.report', outputMapping: { output: '$.data.other', extra: '$.data.extra' } },
      { report: 'the answer', other: 'not this', extra: 'e' }
    );
    assert.deepEqual(output, { output: 'the answer', extra: 'e' });
  });

  it('works with included and excluded fields and metadata', async () => {
    const included = await endResult(
      { output: 'a', includeFields: ['b'] },
      { a: 'A', b: 'B', c: 'C' }
    );
    assert.deepEqual(included.output, { b: 'B', output: 'A' });
    const excluded = await endResult(
      { output: 'a', excludeFields: ['c'], includeMetadata: true },
      { a: 'A', b: 'B', c: 'C' },
      { metadata: { workflowId: 'wf' }, executedNodes: ['start'] }
    );
    assert.equal(excluded.output.output, 'A');
    assert.equal(excluded.output.b, 'B');
    assert.equal('c' in excluded.output, false);
    assert.equal(excluded.output._metadata.exitNode, 'end');
  });

  it('keeps the answer in `output` whatever its own format: raw gives the answer alone', async () => {
    const { output } = await endResult(
      { output: 'finalReport', outputFormat: 'raw' },
      { finalReport: '# Only this', topic: 'wind' }
    );
    assert.deepEqual(output, { output: '# Only this' });
    assert.equal(chatAnswerOf(output), '# Only this');
  });

  it('does not lose a JSON answer to its format, nor mistake one with an `output` field of its own', async () => {
    for (const outputFormat of ['raw', 'json']) {
      const verdict = await endResult(
        { output: 'report', outputVariables: [], outputFormat },
        { report: { verdict: 'ok' } }
      );
      assert.deepEqual(answerOf(verdict.output), { verdict: 'ok' }, outputFormat);
      const nested = await endResult(
        { output: 'report', outputVariables: [], outputFormat },
        { report: { output: 'its own field', verdict: 'ok' } }
      );
      assert.deepEqual(
        answerOf(nested.output),
        { output: 'its own field', verdict: 'ok' },
        outputFormat
      );
    }
  });

  it('gives the answer alone as text for the text format, a JSON answer written out', async () => {
    const text = await endResult(
      { output: 'summary', outputFormat: 'text' },
      { summary: 'All good', content: 'not this', topic: 'wind' }
    );
    assert.deepEqual(text.output, { output: 'All good' });
    const json = await endResult(
      { output: 'report', outputFormat: 'text' },
      { report: { verdict: 'ok' } }
    );
    assert.deepEqual(json.output, { output: JSON.stringify({ verdict: 'ok' }, null, 2) });
    assert.equal(chatAnswerOf(json.output), JSON.stringify({ verdict: 'ok' }, null, 2));
  });
});

describe('what a finished workflow hands back', () => {
  const workflow = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'end', type: 'end', config: { output: 'report' } }
    ]
  };

  it("is the output of the end step it finished at, `output` and all, without the step's bookkeeping", () => {
    const state = {
      completedNodes: ['start', 'end'],
      data: {
        nodeResults: {
          end: {
            status: 'completed',
            isTerminal: true,
            metrics: { duration: 1 },
            output: { output: '# Report', topic: 'wind' }
          }
        }
      }
    };
    assert.deepEqual(finalOutputOf(state, workflow), { output: '# Report', topic: 'wind' });
  });

  it('is found through the definition in the state when the caller does not hand it over', () => {
    const state = {
      completedNodes: ['end'],
      data: {
        _workflowDefinition: workflow,
        nodeResults: { end: { status: 'completed', output: { output: 'x' } } }
      }
    };
    assert.deepEqual(finalOutputOf(state), { output: 'x' });
  });

  it('is what the last step produced when the run finished at a step that is not an end step', () => {
    const shortCircuit = {
      nodes: [{ id: 'inbox', type: 'inbox-load', config: { outputVariables: ['count'] } }]
    };
    const state = {
      completedNodes: ['inbox'],
      data: { count: 0, noise: 'x', nodeResults: { inbox: { status: 'completed', output: null } } }
    };
    assert.deepEqual(finalOutputOf(state, shortCircuit), { count: 0 });
    const plain = { nodes: [{ id: 'inbox', type: 'inbox-load' }] };
    assert.deepEqual(finalOutputOf(state, plain), state.data.nodeResults.inbox);
  });

  it('is nothing for a run that completed nothing', () => {
    assert.equal(finalOutputOf({ completedNodes: [], data: {} }, workflow), undefined);
    assert.equal(finalOutputOf(undefined), undefined);
  });
});

describe('the answer keeps its type', () => {
  it('is the value the output is: text, JSON, a number or a boolean', () => {
    assert.equal(answerOf({ output: 'text', more: 1 }), 'text');
    assert.deepEqual(answerOf({ output: { verdict: 'ok' } }), { verdict: 'ok' });
    assert.deepEqual(answerOf({ output: ['a'] }), ['a']);
    assert.equal(answerOf({ output: 0 }), 0);
    assert.equal(answerOf({ output: false }), false);
  });

  it('is nothing for an empty output', () => {
    for (const value of [undefined, null, '', {}, { output: '' }, { output: null }]) {
      assert.equal(answerOf(value), null, JSON.stringify(value));
    }
  });

  it('is a value an end step reduced its output to, a list included', () => {
    assert.equal(answerOf('reduced'), 'reduced');
    assert.deepEqual(answerOf(['a', 'b']), ['a', 'b']);
  });

  it('knows JSON from text and scalars', () => {
    assert.equal(isJsonAnswer({ a: 1 }), true);
    assert.equal(isJsonAnswer([1]), true);
    for (const value of ['text', 3, false, null, undefined]) {
      assert.equal(isJsonAnswer(value), false, String(value));
    }
  });

  it('is shown in a chat as a JSON block, whatever format the workflow asks for', () => {
    const json = { output: { verdict: 'ok' } };
    for (const format of ['markdown', 'text', 'json', undefined]) {
      assert.equal(chatAnswerFormat(json, format), 'json', String(format));
    }
    assert.equal(chatAnswerFormat({ output: 'text' }, 'text'), 'text');
    assert.equal(chatAnswerFormat({ output: 'text' }), 'markdown');
    assert.equal(chatAnswerFormat({ output: 3 }, 'markdown'), 'markdown');
  });

  it('is read from the end step an execution finished at, as the output and as text', () => {
    const state = {
      completedNodes: ['start', 'end'],
      data: { nodeResults: { end: { status: 'completed', output: { output: { a: 1 } } } } }
    };
    assert.deepEqual(executionOutputOf(state), { output: { a: 1 } });
    assert.equal(executionAnswerOf(state), '{\n  "a": 1\n}');
  });
});

describe('the answer a chat shows', () => {
  it('is the output of the workflow, as it is', () => {
    assert.equal(chatAnswerOf({ output: '# Report', topic: 'wind' }), '# Report');
  });

  it('is never guessed from other variables, whatever they are called', () => {
    assert.equal(chatAnswerOf({ finalReport: '# Report', result: 'r', text: 't' }), null);
  });

  it('shows an output that is not text as JSON', () => {
    assert.equal(chatAnswerOf({ output: { verdict: 'ok' } }), '{\n  "verdict": "ok"\n}');
    assert.equal(chatAnswerOf({ output: 3 }), '3');
    assert.equal(chatAnswerOf({ output: false }), 'false');
    assert.equal(chatAnswerOf({ output: ['a'] }), '[\n  "a"\n]');
  });

  it('is none for an empty output', () => {
    for (const value of [undefined, null, '', { output: '' }, { output: null }, {}]) {
      assert.equal(chatAnswerOf(value), null, JSON.stringify(value));
    }
  });

  it('is a value an end step reduced its output to', () => {
    assert.equal(chatAnswerOf('reduced to text'), 'reduced to text');
    assert.equal(chatAnswerOf(7), '7');
  });

  it('is read from the end step an execution finished at', () => {
    const state = {
      completedNodes: ['start', 'end'],
      data: {
        nodeResults: {
          start: { status: 'completed', output: { output: 'not this' } },
          end: { status: 'completed', output: { output: 'the answer' } }
        }
      }
    };
    assert.equal(executionAnswerOf(state), 'the answer');
    assert.equal(executionAnswerOf({ completedNodes: [], data: {} }), null);
    assert.equal(executionAnswerOf(undefined), null);
  });
});

describe('saving a workflow', () => {
  const node = (id, type, config = {}) => ({
    id,
    type,
    name: { en: id },
    position: { x: 0, y: 0 },
    config
  });
  const workflow = endConfig => ({
    id: 'wf',
    name: { en: 'Workflow' },
    description: { en: 'A workflow.' },
    version: '1.0.0',
    nodes: [node('start', 'start'), node('end', 'end', endConfig)],
    edges: [{ id: 'e1', source: 'start', target: 'end' }]
  });

  it('needs an output on every end node', () => {
    assert.equal(workflowConfigSchema.safeParse(workflow({ output: 'report' })).success, true);
    for (const config of [{}, { output: '' }, { output: '  ' }, { outputVariables: ['report'] }]) {
      const result = workflowConfigSchema.safeParse(workflow(config));
      assert.equal(result.success, false, JSON.stringify(config));
      assert.match(result.error.issues[0].message, /Every end node needs an output/);
    }
  });

  it('takes an object as the output, and refuses one that is empty or has a blank field', () => {
    assert.equal(
      workflowConfigSchema.safeParse(
        workflow({ output: { topic: 'topic', report: 'finalReport' } })
      ).success,
      true
    );
    for (const output of [{}, { topic: '' }, { '': 'topic' }, { topic: ['x'] }, ['topic']]) {
      const result = workflowConfigSchema.safeParse(workflow({ output }));
      assert.equal(result.success, false, JSON.stringify(output));
      assert.match(result.error.issues[0].message, /or to an object of fields/);
    }
  });

  it('refuses a workflow in which only one of two end nodes has an output', () => {
    const wf = workflow({ output: 'report' });
    wf.nodes.push(node('end-b', 'end', {}));
    wf.edges.push({ id: 'e2', source: 'start', target: 'end-b' });
    assert.equal(workflowConfigSchema.safeParse(wf).success, false);
    wf.nodes[2].config = { output: 'other' };
    assert.equal(workflowConfigSchema.safeParse(wf).success, true);
  });

  it('no longer takes a primary output of the chat integration', () => {
    const result = workflowConfigSchema.safeParse({
      ...workflow({ output: 'report' }),
      chatIntegration: { enabled: true, primaryOutput: 'report', outputFormat: 'markdown' }
    });
    assert.equal(result.success, true);
    assert.equal('primaryOutput' in result.data.chatIntegration, false);
  });

  it('no longer takes a passthrough result: the answer is always shown as it is', () => {
    const result = workflowConfigSchema.safeParse({
      ...workflow({ output: 'report' }),
      chatIntegration: { enabled: true, passthroughResult: true }
    });
    assert.equal(result.success, true);
    assert.equal('passthroughResult' in result.data.chatIntegration, false);
  });
});

describe('a real run of the engine', () => {
  let engine;
  before(() => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-end-output-'));
    engine = new WorkflowEngine({ stateManager: new StateManager({ stateDir }) });
  });

  /** Run a start → end workflow to its end and resolve with the event that ended it. */
  async function run(endConfig, data) {
    const definition = {
      id: 'wf-end-output',
      name: { en: 'End output' },
      version: '1.0.0',
      config: { maxExecutionTime: 60000 },
      nodes: [
        {
          id: 'start',
          type: 'start',
          name: { en: 'Start' },
          position: { x: 0, y: 0 },
          config: { inputVariables: [{ name: 'topic', type: 'string' }] }
        },
        {
          id: 'end',
          type: 'end',
          name: { en: 'End' },
          position: { x: 200, y: 0 },
          config: endConfig
        }
      ],
      edges: [{ id: 'e1', source: 'start', target: 'end' }]
    };
    let executionId = null;
    const ended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the run did not end')), 15000);
      const listener = event => {
        const mine = executionId === null || event.executionId === executionId;
        if (mine && ['workflow.complete', 'workflow.failed'].includes(event.event)) {
          clearTimeout(timer);
          actionTracker.off('fire-sse', listener);
          resolve(event);
        }
      };
      actionTracker.on('fire-sse', listener);
    });
    const started = await engine.start(definition, data);
    executionId = started?.executionId ?? started;
    return ended;
  }

  it('completes with the end step output: the answer and the additional information', async () => {
    const event = await run(
      { output: 'summary', outputVariables: ['topic'] },
      { topic: 'wind', summary: 'All good' }
    );
    assert.equal(event.event, 'workflow.complete');
    assert.deepEqual(event.output, { topic: 'wind', output: 'All good' });
    assert.equal(chatAnswerOf(event.output), 'All good');
  });

  it('completes with just the answer for an end step that passes nothing else on', async () => {
    const event = await run({ output: 'summary', outputMapping: {} }, { summary: 'Only this' });
    assert.equal(event.event, 'workflow.complete');
    assert.deepEqual(event.output, { output: 'Only this' });
  });

  it('completes with an object as the answer when the output is an object', async () => {
    const event = await run(
      { output: { topic: 'topic', summary: 'summary' } },
      { topic: 'wind', summary: 'All good' }
    );
    assert.equal(event.event, 'workflow.complete');
    assert.deepEqual(event.output.output, { topic: 'wind', summary: 'All good' });
    assert.equal(isJsonAnswer(event.output), true);
  });

  it('fails, saying what is missing, when the end step has no output', async () => {
    const event = await run({ outputVariables: ['summary'] }, { summary: 'An answer in disguise' });
    assert.equal(event.event, 'workflow.failed');
    assert.match(JSON.stringify(event.error), /end step 'end' has no output/);
  });
});

describe('a run through the chat runner', () => {
  const USER = { id: 'u1', permissions: { workflows: new Set(['*']) } };
  const APP = { id: 'chat', workflows: ['answers'] };
  const envelopes = [];
  let stopObserving;
  let chatSeq = 0;

  before(() => {
    // The runner takes the shared engine; give it one that keeps its state in a temp directory.
    resetWorkflowEngine();
    getWorkflowEngine({
      stateManager: new StateManager({
        stateDir: mkdtempSync(path.join(os.tmpdir(), 'ihub-runner-'))
      })
    });
    stopObserving = observeEmittedEnvelopes(envelope => envelopes.push(envelope));
  });
  after(() => {
    stopObserving();
    configCache.setCacheEntry('config/workflows.json', []);
    resetWorkflowEngine();
  });

  const node = (id, type, config = {}) => ({
    id,
    type,
    name: { en: id },
    position: { x: 0, y: 0 },
    config
  });
  const workflow = (output, outputFormat) => ({
    id: 'answers',
    name: { en: 'Answers' },
    enabled: true,
    chatIntegration: { enabled: true, ...(outputFormat ? { outputFormat } : {}) },
    nodes: [
      node('start', 'start', { inputVariables: [{ name: 'input', type: 'string' }] }),
      node('end', 'end', { output, outputVariables: ['topic'] })
    ],
    edges: [{ id: 'e1', source: 'start', target: 'end' }]
  });

  /** Run the workflow for a chat; resolve with what the runner returned and what the chat was told. */
  async function run(definition, variables) {
    envelopes.length = 0;
    configCache.setCacheEntry('config/workflows.json', [definition]);
    const result = await workflowRunner({
      workflowId: 'answers',
      chatId: `answers-chat-${(chatSeq += 1)}`,
      user: USER,
      appConfig: APP,
      passthrough: false,
      input: 'x',
      ...variables
    });
    const meta = envelopes.find(e => e.type === 'meta' && e.data?.extra?.workflow);
    const streamed = envelopes.filter(e => e.type === 'step/delta').map(e => e.data.content);
    return { result, told: meta?.data.extra.workflow, streamed: streamed.join('') };
  }

  it('returns an object output as JSON with the fields of the end step, shown as JSON', async () => {
    const { result, told, streamed } = await run(
      workflow({ topic: 'topic', verdict: 'verdict' }, 'markdown'),
      { topic: 'wind', verdict: 'ok' }
    );
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output.output, { topic: 'wind', verdict: 'ok' });
    assert.deepEqual(JSON.parse(result.outputText), { topic: 'wind', verdict: 'ok' });
    assert.deepEqual(JSON.parse(streamed), { topic: 'wind', verdict: 'ok' });
    assert.equal(told.outputFormat, 'json');
  });

  it('returns a JSON answer as JSON, and tells the chat to show it as JSON', async () => {
    const answer = { verdict: 'ok', items: [1, 2] };
    const { result, told, streamed } = await run(workflow('verdict', 'markdown'), {
      topic: 'wind',
      verdict: answer
    });
    assert.equal(result.status, 'completed');
    // The value, not a string
    assert.deepEqual(result.output.output, answer);
    assert.equal(result.output.topic, 'wind');
    // The bubble holds text: the JSON written out, shown as a JSON block
    assert.deepEqual(JSON.parse(result.outputText), answer);
    assert.deepEqual(JSON.parse(streamed), answer);
    assert.equal(told.outputFormat, 'json');
  });

  it('keeps the format the workflow asks for when the answer is text', async () => {
    for (const format of ['markdown', 'text']) {
      const { result, told, streamed } = await run(workflow('report', format), {
        report: '# The report'
      });
      assert.equal(result.output.output, '# The report');
      assert.equal(streamed, '# The report');
      assert.equal(told.outputFormat, format);
    }
  });

  it('says so, and streams nothing, when the end step gave no answer', async () => {
    const { result, streamed } = await run(workflow('missing'), {});
    assert.equal(result.status, 'completed');
    assert.equal(result.output.output, '');
    assert.equal(result.outputText, '');
    assert.equal(streamed, '');
  });

  /** A workflow whose project input comes before its text input; it hands both back. */
  const projectFirst = () => ({
    ...workflow('topic'),
    nodes: [
      node('start', 'start', {
        inputVariables: [
          { name: 'case', type: 'project' },
          { name: 'topic', type: 'string' }
        ]
      }),
      node('end', 'end', { output: 'topic', outputVariables: ['case'] })
    ]
  });

  it('puts the chat message in the text input, never in a project input before it', async () => {
    assert.equal(chatTextVariable(projectFirst().nodes[0].config.inputVariables).name, 'topic');
    configCache.setCacheEntry('config/workflows.json', [projectFirst()]);
    const result = await workflowRunner({
      workflowId: 'answers',
      chatId: `answers-chat-${(chatSeq += 1)}`,
      user: USER,
      appConfig: APP,
      passthrough: false,
      input: 'Summarize the lease'
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.output.output, 'Summarize the lease');
    assert.equal(result.output.case, undefined, 'the sentence is not taken for a project id');
  });

  it('keeps a project id given beside the chat message, and still fills the text input', async () => {
    configCache.setCacheEntry('config/workflows.json', [projectFirst()]);
    const result = await workflowRunner({
      workflowId: 'answers',
      chatId: `answers-chat-${(chatSeq += 1)}`,
      user: USER,
      appConfig: APP,
      passthrough: false,
      input: 'Summarize the lease',
      case: 'prj_case'
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.output.case, 'prj_case');
    assert.equal(result.output.output, 'Summarize the lease');
  });

  it('never hands the chat message to a project input named input', async () => {
    // The schema refuses this name; a workflow loaded anyway (the loader
    // only warns) must still not take the sentence for a project id.
    const definition = projectFirst();
    definition.nodes[0].config.inputVariables[0].name = 'input';
    definition.nodes[1].config.outputVariables = ['input'];
    configCache.setCacheEntry('config/workflows.json', [definition]);
    const result = await workflowRunner({
      workflowId: 'answers',
      chatId: `answers-chat-${(chatSeq += 1)}`,
      user: USER,
      appConfig: APP,
      passthrough: false,
      input: 'Summarize the lease'
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.output.output, 'Summarize the lease', 'the text input has the message');
    assert.equal(result.output.input, undefined, 'the project input is not the sentence');
  });
});

describe('workflows that are built by code end with an output as well', () => {
  const PROFILES = {
    simple: { id: 'p-simple' },
    'drain only': { id: 'p-drain', dynamicTasks: { enabled: true } },
    planner: { id: 'p-planner', planner: { enabled: true } },
    'planner without synthesizer': {
      id: 'p-planner-plain',
      planner: { enabled: true },
      synthesizer: { enabled: false }
    },
    'inbox worker': { id: 'p-inbox', inboxId: 'inbox-1' },
    'inbox worker without synthesizer': {
      id: 'p-inbox-plain',
      inboxId: 'inbox-1',
      synthesizer: { enabled: false }
    }
  };

  for (const [shape, profile] of Object.entries(PROFILES)) {
    it(`an agent profile (${shape}) has an end step with an output`, () => {
      const { nodes } = buildDefaultWorkflowForProfile(profile);
      const ends = nodes.filter(node => node.type === 'end');
      assert.equal(ends.length, 1);
      assert.equal(typeof ends[0].config?.output, 'string');
      assert.notEqual(ends[0].config.output.trim(), '');
    });
  }

  it('an agent profile ends with what its last step produced', () => {
    const output = profile =>
      buildDefaultWorkflowForProfile(profile).nodes.find(node => node.type === 'end').config.output;
    assert.equal(output(PROFILES.simple), '$.data.nodeResults.agent.content');
    assert.equal(output(PROFILES.planner), '_synthesizerOutput');
    assert.equal(output(PROFILES['planner without synthesizer']), '_taskResults');
    assert.equal(output(PROFILES['inbox worker']), '_synthesizerOutput');
  });

  it('a simple agent run answers with the output of its one node', async () => {
    const { nodes } = buildDefaultWorkflowForProfile(PROFILES.simple);
    const end = nodes.find(node => node.type === 'end');
    const { output } = await endResult(
      end.config,
      {},
      {
        data: {
          nodeResults: {
            agent: { output: { content: 'The agent answer' }, content: 'The agent answer' }
          }
        }
      }
    );
    assert.equal(output.output, 'The agent answer');
  });

  it('a plan that is carried out as a sub-workflow ends with an output', () => {
    const plan = {
      tasks: [{ id: 't1', title: 'Find it', description: 'Look it up' }]
    };
    const taskTemplate = { system: { en: 'You are an agent.' } };
    const outputOf = parentConfig =>
      SubWorkflowMaterializer.materialize(plan, { taskTemplate, ...parentConfig }, 0).nodes.find(
        node => node.type === 'end'
      ).config.output;
    assert.equal(outputOf({ synthesize: true }), 'synthesized_result');
    assert.equal(outputOf({ synthesize: false }), '_taskResults');
  });
});
