import { describe, it, expect } from '@jest/globals';
import {
  appsUsingWorkflow,
  automaticChatOutputFor,
  chatIntegrationWarnings,
  primaryOutputOptions,
  withCleanToolDescription
} from '../../../client/src/features/workflows/utils/chatIntegration.js';
import { createStarterWorkflow } from '../../../client/src/features/workflows/editor/workflowEditorUtils.js';
import {
  CHAT_OUTPUT_FALLBACK_FIELDS,
  chatAnswerOf,
  fallbackChatOutputField
} from '../../../shared/workflowChatOutput.js';
import { workflowResultOf } from '../../../shared/run/runActivity.js';
import { workflowConfigSchema } from '../../../server/validators/workflowConfigSchema.js';

const node = (id, type, config = {}) => ({
  id,
  type,
  name: { en: id },
  position: { x: 0, y: 0 },
  config
});

/** start(text) → check(outputVariable: report) → fix(outputVariable: corrected_text) → end */
function ruleCheckWorkflow({ endConfig = {}, chatIntegration } = {}) {
  return {
    id: 'rule-check',
    name: { en: 'Rule check' },
    description: { en: 'Checks a text' },
    version: '1.0.0',
    config: {},
    ...(chatIntegration ? { chatIntegration } : {}),
    nodes: [
      node('start', 'start', { inputVariables: [{ name: 'text', type: 'textarea' }] }),
      node('check', 'prompt', { prompt: { en: '{{text}}' }, outputVariable: 'bericht' }),
      node('fix', 'prompt', { prompt: { en: '{{bericht}}' }, outputVariable: 'corrected_text' }),
      node('end', 'end', endConfig)
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'check' },
      { id: 'e2', source: 'check', target: 'fix' },
      { id: 'e3', source: 'fix', target: 'end' }
    ]
  };
}

const values = options => options.map(option => option.value).sort();

describe('primaryOutputOptions', () => {
  it('offers every variable that reaches an unrestricted end step', () => {
    expect(values(primaryOutputOptions(ruleCheckWorkflow()))).toEqual(
      ['bericht', 'corrected_text', 'text'].sort()
    );
  });

  it('offers only the listed outputVariables', () => {
    const wf = ruleCheckWorkflow({ endConfig: { outputVariables: ['bericht'] } });
    expect(values(primaryOutputOptions(wf))).toEqual(['bericht']);
  });

  it('offers the outputMapping keys, which take precedence over outputVariables', () => {
    const wf = ruleCheckWorkflow({
      endConfig: {
        outputMapping: { answer: '$.data.corrected_text' },
        outputVariables: ['bericht']
      }
    });
    expect(values(primaryOutputOptions(wf))).toEqual(['answer']);
  });

  it('leaves out excluded fields', () => {
    const wf = ruleCheckWorkflow({ endConfig: { excludeFields: ['text'] } });
    expect(values(primaryOutputOptions(wf))).toEqual(['bericht', 'corrected_text']);
  });

  it('combines the outputs of several end steps', () => {
    const wf = ruleCheckWorkflow({ endConfig: { outputVariables: ['corrected_text'] } });
    wf.nodes.push(node('early-end', 'end', { outputVariables: ['bericht'] }));
    wf.edges.push({ id: 'e4', source: 'check', target: 'early-end' });
    expect(values(primaryOutputOptions(wf))).toEqual(['bericht', 'corrected_text']);
  });

  it('labels a variable with the step that writes it', () => {
    const option = primaryOutputOptions(ruleCheckWorkflow()).find(o => o.value === 'bericht');
    expect(option.label).toContain('check');
  });
});

describe('chatIntegrationWarnings', () => {
  it('warns when apps list the workflow but it is not available in chat', () => {
    const warnings = chatIntegrationWarnings(ruleCheckWorkflow(), {
      assignedApps: [{ id: 'strafsuche' }]
    });
    expect(warnings).toEqual([{ code: 'assignedButDisabled', params: { apps: 'strafsuche' } }]);
  });

  it('stays quiet for a workflow that is neither in chat nor assigned', () => {
    expect(chatIntegrationWarnings(ruleCheckWorkflow())).toEqual([]);
  });

  it('warns when the selected result is not passed on by the end step', () => {
    const wf = ruleCheckWorkflow({
      endConfig: { outputVariables: ['bericht'] },
      chatIntegration: { enabled: true, primaryOutput: 'corrected_text' }
    });
    expect(chatIntegrationWarnings(wf).map(w => w.code)).toEqual(['primaryOutputUnknown']);
  });

  it('accepts a dotted path into an output', () => {
    const wf = ruleCheckWorkflow({
      chatIntegration: { enabled: true, primaryOutput: 'bericht.markdown' }
    });
    expect(chatIntegrationWarnings(wf)).toEqual([]);
  });

  it('warns that the chat shows JSON when nothing selects or names the answer', () => {
    const wf = ruleCheckWorkflow({
      endConfig: { outputVariables: ['bericht', 'corrected_text'] },
      chatIntegration: { enabled: true }
    });
    expect(chatIntegrationWarnings(wf)).toEqual([{ code: 'jsonFallback' }]);
  });

  it('stays quiet when Automatic finds a conventionally named output', () => {
    const wf = ruleCheckWorkflow({
      endConfig: { outputMapping: { report: '$.data.corrected_text' } },
      chatIntegration: { enabled: true }
    });
    expect(chatIntegrationWarnings(wf)).toEqual([]);
  });

  it('warns when Automatic would answer with the workflow input', () => {
    // `text` is a conventional answer name and the input here; an end step
    // that passes everything on would answer with the user's own text.
    const wf = ruleCheckWorkflow({ chatIntegration: { enabled: true } });
    expect(chatIntegrationWarnings(wf)).toEqual([
      { code: 'automaticShowsInput', params: { name: 'text' } }
    ]);
  });

  it('warns about JSON when the end step passes nothing on', () => {
    const wf = ruleCheckWorkflow({
      endConfig: { outputVariables: [] },
      chatIntegration: { enabled: true }
    });
    expect(chatIntegrationWarnings(wf)).toEqual([{ code: 'jsonFallback' }]);
  });

  it('warns when an end step flattens its output so the selection is ignored', () => {
    const wf = ruleCheckWorkflow({
      endConfig: { outputFormat: 'text' },
      chatIntegration: { enabled: true, primaryOutput: 'corrected_text' }
    });
    expect(chatIntegrationWarnings(wf)).toEqual([
      { code: 'endNodeFormatsOutput', params: { node: 'end', format: 'text' } }
    ]);
  });
});

describe('automaticChatOutputFor', () => {
  it('shows a conventionally named output on its own', () => {
    const wf = ruleCheckWorkflow({ endConfig: { outputMapping: { report: '$.data.bericht' } } });
    expect(automaticChatOutputFor(wf)).toEqual({ mode: 'field', field: 'report' });
  });

  it('shows JSON when no output has such a name, listing what the end step passes on', () => {
    const wf = ruleCheckWorkflow({ endConfig: { outputVariables: ['corrected_text', 'bericht'] } });
    expect(automaticChatOutputFor(wf)).toEqual({
      mode: 'json',
      keys: ['corrected_text', 'bericht']
    });
  });

  it('reports an end step that passes nothing on', () => {
    const wf = ruleCheckWorkflow({ endConfig: { outputVariables: [] } });
    expect(automaticChatOutputFor(wf)).toEqual({ mode: 'none' });
  });
});

describe('withCleanToolDescription', () => {
  const withDescription = toolDescription => ({
    id: 'x',
    chatIntegration: { enabled: true, toolDescription }
  });

  it('drops a language that was added but left empty', () => {
    const cleaned = withCleanToolDescription(withDescription({ en: 'Checks texts', de: '  ' }));
    expect(cleaned.chatIntegration.toolDescription).toEqual({ en: 'Checks texts' });
  });

  it('removes the description when no text is left, keeping the other settings', () => {
    const cleaned = withCleanToolDescription(withDescription({ de: '' }));
    expect(cleaned.chatIntegration).toEqual({ enabled: true });
  });

  it('removes an empty object, which would hide the workflow description', () => {
    expect(withCleanToolDescription(withDescription({})).chatIntegration).toEqual({
      enabled: true
    });
  });

  it('returns the same workflow when there is nothing to clean up', () => {
    const wf = withDescription({ en: 'Checks texts' });
    expect(withCleanToolDescription(wf)).toBe(wf);
    const without = { id: 'y', chatIntegration: { enabled: false } };
    expect(withCleanToolDescription(without)).toBe(without);
  });

  it('leaves the stored workflow untouched', () => {
    const wf = withDescription({ de: '' });
    withCleanToolDescription(wf);
    expect(wf.chatIntegration.toolDescription).toEqual({ de: '' });
  });

  it('lets a cleaned description pass the schema', () => {
    const wf = createStarterWorkflow({
      id: 'clean-me',
      chatIntegration: { enabled: true, toolDescription: { en: 'Checks texts', de: '' } }
    });
    expect(workflowConfigSchema.safeParse(wf).success).toBe(false);
    expect(workflowConfigSchema.safeParse(withCleanToolDescription(wf)).success).toBe(true);
  });
});

describe('appsUsingWorkflow', () => {
  it('finds apps listing the workflow, ignoring case', () => {
    const apps = [
      { id: 'a', workflows: ['Rule-Check'] },
      { id: 'b', workflows: ['other'] },
      { id: 'c' }
    ];
    expect(appsUsingWorkflow(apps, 'rule-check').map(app => app.id)).toEqual(['a']);
  });

  it('returns nothing without an id or app list', () => {
    expect(appsUsingWorkflow(null, 'x')).toEqual([]);
    expect(appsUsingWorkflow([{ id: 'a', workflows: ['x'] }], '')).toEqual([]);
  });
});

describe('fallbackChatOutputField', () => {
  it('picks the first field in the runner order', () => {
    expect(fallbackChatOutputField(['summary', 'report'])).toBe('report');
  });

  it('returns null when no key is on the list', () => {
    expect(fallbackChatOutputField(['bericht', 'corrected_text'])).toBeNull();
  });

  it('keeps the order the runner has always used', () => {
    expect(CHAT_OUTPUT_FALLBACK_FIELDS).toEqual([
      'finalReport',
      'report',
      'content',
      'output',
      'result',
      'summary',
      'text',
      'message'
    ]);
  });
});

describe('createStarterWorkflow chat integration', () => {
  it('spells out that a new workflow is not in chat, and the schema accepts it', () => {
    const wf = createStarterWorkflow({ id: 'new-one' });
    expect(wf.chatIntegration).toEqual({ enabled: false });
    expect(workflowConfigSchema.safeParse(wf).success).toBe(true);
  });
});

describe('end steps that flatten their output', () => {
  it('text: Automatic shows the formatted value and raises no Automatic warnings', () => {
    const wf = ruleCheckWorkflow({
      endConfig: { outputFormat: 'text', outputVariables: ['bericht', 'corrected_text'] },
      chatIntegration: { enabled: true }
    });
    expect(automaticChatOutputFor(wf)).toEqual({ mode: 'flattened', node: 'end', format: 'text' });
    expect(chatIntegrationWarnings(wf)).toEqual([]);
  });

  it('raw with a single output: the selection is ignored', () => {
    const wf = ruleCheckWorkflow({
      endConfig: { outputFormat: 'raw', outputVariables: ['corrected_text'] },
      chatIntegration: { enabled: true, primaryOutput: 'corrected_text' }
    });
    expect(chatIntegrationWarnings(wf)).toEqual([
      { code: 'endNodeFormatsOutput', params: { node: 'end', format: 'raw' } }
    ]);
  });

  it('raw with several outputs returns them unchanged, so the selection works', () => {
    const wf = ruleCheckWorkflow({
      endConfig: { outputFormat: 'raw', outputVariables: ['bericht', 'corrected_text'] },
      chatIntegration: { enabled: true, primaryOutput: 'corrected_text' }
    });
    expect(chatIntegrationWarnings(wf)).toEqual([]);
    expect(automaticChatOutputFor(wf).mode).toBe('json');
  });

  it('raw counts the metadata the end step adds', () => {
    const wf = ruleCheckWorkflow({
      endConfig: {
        outputFormat: 'raw',
        outputVariables: ['corrected_text'],
        includeMetadata: true
      },
      chatIntegration: { enabled: true, primaryOutput: 'corrected_text' }
    });
    expect(chatIntegrationWarnings(wf)).toEqual([]);
  });

  it('raw on an end step that passes every variable on does not flatten', () => {
    const wf = ruleCheckWorkflow({
      endConfig: { outputFormat: 'raw' },
      chatIntegration: { enabled: true, primaryOutput: 'corrected_text' }
    });
    expect(chatIntegrationWarnings(wf)).toEqual([]);
  });
});

describe('chatAnswerOf', () => {
  it('returns the selected output, also from a dotted path', () => {
    expect(chatAnswerOf({ a: 'x', corrected_text: 'Fixed.' }, 'corrected_text')).toEqual({
      text: 'Fixed.',
      wholeOutput: false
    });
    expect(chatAnswerOf({ _report: { markdown: '# R' } }, '_report.markdown').text).toBe('# R');
  });

  it('serializes a selected object, which is not the whole-output fallback', () => {
    expect(chatAnswerOf({ data: { a: 1 }, b: 'y' }, 'data')).toEqual({
      text: JSON.stringify({ a: 1 }, null, 2),
      wholeOutput: false
    });
  });

  it('falls back to a conventionally named output when the selection is empty or missing', () => {
    expect(chatAnswerOf({ report: 'The report', corrected_text: '' }, 'corrected_text')).toEqual({
      text: 'The report',
      wholeOutput: false
    });
    expect(chatAnswerOf({ summary: 's', report: 'r' })).toEqual({ text: 'r', wholeOutput: false });
  });

  it('answers with the whole output as JSON otherwise, and says so', () => {
    const output = { bericht: 'b', corrected_text: 'c' };
    expect(chatAnswerOf(output)).toEqual({
      text: JSON.stringify(output, null, 2),
      wholeOutput: true
    });
  });

  it('passes non-object outputs through, and has nothing for an empty one', () => {
    expect(chatAnswerOf('done')).toEqual({ text: 'done', wholeOutput: false });
    expect(chatAnswerOf(42)).toEqual({ text: '42', wholeOutput: false });
    expect(chatAnswerOf(undefined)).toEqual({ text: null, wholeOutput: false });
  });
});

describe('the whole-output flag on a workflow result', () => {
  const run = workflow => ({ meta: { executionId: 'wf-1', extra: { workflow } } });

  it('is carried from the run metadata into the message result', () => {
    expect(workflowResultOf(run({ status: 'completed', wholeOutput: true }))).toEqual({
      status: 'completed',
      executionId: 'wf-1',
      workflowName: undefined,
      wholeOutput: true
    });
  });

  it('is absent for an answer the workflow chose', () => {
    expect(workflowResultOf(run({ status: 'completed' }))).not.toHaveProperty('wholeOutput');
  });
});
