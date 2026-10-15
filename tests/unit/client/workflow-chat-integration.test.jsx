import { describe, it, expect } from '@jest/globals';
import {
  appsUsingWorkflow,
  chatIntegrationWarnings,
  endStepsWithoutOutput,
  withCleanToolDescription
} from '../../../client/src/features/workflows/utils/chatIntegration.js';
import { createStarterWorkflow } from '../../../client/src/features/workflows/editor/workflowEditorUtils.js';
import { workflowConfigSchema } from '../../../server/validators/workflowConfigSchema.js';

const node = (id, type, config = {}) => ({
  id,
  type,
  name: { en: id },
  position: { x: 0, y: 0 },
  config
});

/** start(text) → check → fix → end, whose end step has the given config. */
function ruleCheckWorkflow({ endConfig = { output: 'corrected_text' }, chatIntegration } = {}) {
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

describe('endStepsWithoutOutput', () => {
  it('is empty when every end step has an output', () => {
    expect(endStepsWithoutOutput(ruleCheckWorkflow())).toEqual([]);
  });

  it('names the end steps without one: none set, empty, blank or not text', () => {
    for (const endConfig of [{}, { output: '' }, { output: '   ' }, { output: 3 }]) {
      expect(endStepsWithoutOutput(ruleCheckWorkflow({ endConfig }))).toEqual(['end']);
    }
  });

  it('does not take a variable that happens to be named like an answer for an output', () => {
    expect(
      endStepsWithoutOutput(ruleCheckWorkflow({ endConfig: { outputVariables: ['finalReport'] } }))
    ).toEqual(['end']);
  });

  it('checks every end step of a workflow with several', () => {
    const wf = ruleCheckWorkflow();
    wf.nodes.push(node('end-b', 'end', {}), node('end-c', 'end', { output: 'x' }));
    expect(endStepsWithoutOutput(wf)).toEqual(['end-b']);
  });

  it('copes with a workflow that has no nodes yet', () => {
    expect(endStepsWithoutOutput(undefined)).toEqual([]);
    expect(endStepsWithoutOutput({})).toEqual([]);
  });
});

describe('chatIntegrationWarnings', () => {
  it('warns when apps list the workflow but it is not available in chat', () => {
    expect(
      chatIntegrationWarnings(ruleCheckWorkflow(), { assignedApps: [{ id: 'chat' }, { id: 'hr' }] })
    ).toEqual([{ code: 'assignedButDisabled', params: { apps: 'chat, hr' } }]);
  });

  it('stays quiet for a workflow that is neither in chat nor assigned', () => {
    expect(chatIntegrationWarnings(ruleCheckWorkflow())).toEqual([]);
  });

  it('stays quiet for a workflow that is available in chat', () => {
    expect(
      chatIntegrationWarnings(ruleCheckWorkflow({ chatIntegration: { enabled: true } }), {
        assignedApps: [{ id: 'chat' }]
      })
    ).toEqual([]);
  });

  it('warns about an end step without an output, in chat or not', () => {
    for (const chatIntegration of [undefined, { enabled: true }]) {
      expect(
        chatIntegrationWarnings(ruleCheckWorkflow({ endConfig: {}, chatIntegration }))
      ).toEqual([{ code: 'endWithoutOutput', params: { nodes: 'end' } }]);
    }
  });

  it('lists every end step that has none', () => {
    const wf = ruleCheckWorkflow({ endConfig: {} });
    wf.nodes.push(node('end-b', 'end', {}));
    expect(chatIntegrationWarnings(wf)).toEqual([
      { code: 'endWithoutOutput', params: { nodes: 'end, end-b' } }
    ]);
  });

  it('raises both warnings together', () => {
    const codes = chatIntegrationWarnings(ruleCheckWorkflow({ endConfig: {} }), {
      assignedApps: [{ id: 'chat' }]
    }).map(warning => warning.code);
    expect(codes).toEqual(['assignedButDisabled', 'endWithoutOutput']);
  });

  it('never warns about which output the chat shows: it is always the end step output', () => {
    // These warned before ("shows JSON", "result not passed on", "shows the input").
    const wf = ruleCheckWorkflow({
      endConfig: { output: 'bericht', outputVariables: ['text'], outputFormat: 'text' },
      chatIntegration: { enabled: true }
    });
    expect(chatIntegrationWarnings(wf)).toEqual([]);
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

describe('createStarterWorkflow', () => {
  it('spells out that a new workflow is not in chat, and the schema accepts it', () => {
    const wf = createStarterWorkflow({ id: 'new-one' });
    expect(wf.chatIntegration).toEqual({ enabled: false });
    expect(workflowConfigSchema.safeParse(wf).success).toBe(true);
  });

  it('ends with an output, so it can be saved the moment it is created', () => {
    const wf = createStarterWorkflow({ id: 'new-one' });
    const end = wf.nodes.find(n => n.type === 'end');
    expect(end.config.output).toBe('input');
    expect(endStepsWithoutOutput(wf)).toEqual([]);
  });
});
