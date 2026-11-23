// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs';
import { useState } from 'react';
import path from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import HumanForm from '../../../client/src/features/workflows/editor/panels/forms/HumanForm';
import WorkflowEditorPage from '../../../client/src/features/admin/pages/WorkflowEditorPage';
import { apiClient } from '../../../client/src/api/client';
import {
  RUN_INPUT_VARIABLE,
  WORKFLOW_STEP_NODE_TYPE,
  collectUpstreamVariables,
  createNewNode,
  findUnknownReferences,
  flowToWorkflow,
  workflowSaveErrorMessage,
  workflowToFlow
} from '../../../client/src/features/workflows/editor/workflowEditorUtils';
import { groupsGrantingWorkflow } from '../../../client/src/features/admin/utils/workflowVisibility';
import { findUnanswerableHumanSteps } from '../../../server/services/workflow/workflowSaveChecks.js';

/**
 * Contract of the workflow editors (AX-B4, AX-B5, AX-B10, AX-B11, AX-B12,
 * AX-B20): what the canvas loads it saves back unchanged; Ask a Person option
 * labels keep their languages; steps are a node type of their own; `input`
 * is a known name; Publish is gone; the list shows who can run a workflow.
 */

// One stable `t`, like the real hook: the page reloads the workflow when `t` changes.
jest.mock('react-i18next', () => {
  const t = (key, fallback, options) => {
    const text = typeof fallback === 'string' ? fallback : key;
    return Object.entries(options || {}).reduce(
      (out, [name, value]) => out.replaceAll(`{{${name}}}`, String(value)),
      text
    );
  };
  const i18n = { language: 'en' };
  const value = { t, i18n };
  return { useTranslation: () => value };
});

jest.mock('../../../client/src/api/client', () => ({
  apiClient: { get: jest.fn(), put: jest.fn(), post: jest.fn() }
}));

// The canvas itself (React Flow) needs layout APIs jsdom lacks; the page is
// tested for what it hands the canvas.
const mockEditorProps = [];
jest.mock('../../../client/src/features/workflows/editor/WorkflowEditor', () => ({
  WorkflowEditor: props => {
    mockEditorProps.push(props);
    // The page saves through its bar; the stand-in only moves the first step.
    const moved = props.initialNodes.map((node, index) =>
      index === 0 ? { ...node, position: { x: node.position.x + 50, y: node.position.y } } : node
    );
    return (
      <button type="button" onClick={() => props.onFlowChange(moved, props.initialEdges)}>
        Move first step
      </button>
    );
  }
}));

const APPROVAL_WORKFLOW = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), 'server/defaults/workflows/approval-workflow.json'),
    'utf-8'
  )
);

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe('canvas round trip', () => {
  it('saves the shipped approval workflow back unchanged', () => {
    const { nodes, edges } = workflowToFlow(APPROVAL_WORKFLOW);
    expect(flowToWorkflow(nodes, edges, APPROVAL_WORKFLOW)).toEqual(APPROVAL_WORKFLOW);
  });

  it('saves a canvas edit with the payload it loaded, only the moved step changed', async () => {
    apiClient.get.mockResolvedValue({ data: structuredClone(APPROVAL_WORKFLOW) });
    apiClient.put.mockResolvedValue({ data: {} });
    render(
      <MemoryRouter initialEntries={[`/admin/workflows/${APPROVAL_WORKFLOW.id}/edit`]}>
        <Routes>
          <Route path="/admin/workflows/:id/edit" element={<WorkflowEditorPage />} />
        </Routes>
      </MemoryRouter>
    );
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Move first step' }));
    const bar = screen.getByRole('region', { name: 'Save changes' });
    const buttons = within(bar).getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);
    await flush();
    const expected = structuredClone(APPROVAL_WORKFLOW);
    expected.nodes[0].position.x += 50;
    expect(apiClient.put).toHaveBeenCalledWith(`/workflows/${APPROVAL_WORKFLOW.id}`, expected);
  });
});

describe('the canvas page (AX-B11)', () => {
  it('offers no Publish and no draft/published pill', async () => {
    mockEditorProps.length = 0;
    apiClient.get.mockResolvedValue({ data: { ...APPROVAL_WORKFLOW, status: 'draft' } });
    render(
      <MemoryRouter initialEntries={['/admin/workflows/approval-workflow/edit']}>
        <Routes>
          <Route path="/admin/workflows/:id/edit" element={<WorkflowEditorPage />} />
        </Routes>
      </MemoryRouter>
    );
    await flush();
    expect(mockEditorProps.at(-1).onPublish).toBeUndefined();
    expect(screen.queryByText('draft')).not.toBeInTheDocument();
  });
});

describe('step node type (AX-B20)', () => {
  it('is not React Flow\'s styled "default" type', () => {
    expect(WORKFLOW_STEP_NODE_TYPE).not.toBe('default');
    const { nodes } = workflowToFlow(APPROVAL_WORKFLOW);
    expect(new Set(nodes.map(n => n.type))).toEqual(new Set([WORKFLOW_STEP_NODE_TYPE]));
    expect(createNewNode('prompt', { x: 0, y: 0 }).type).toBe(WORKFLOW_STEP_NODE_TYPE);
    expect(createNewNode('loop', { x: 0, y: 0 }).type).toBe('loopContainer');
  });
});

describe('the built-in run input (AX-B12)', () => {
  const workflow = {
    id: 'summarise',
    nodes: [
      { id: 'start', type: 'start', name: { en: 'Start' }, position: { x: 0, y: 0 }, config: {} },
      {
        id: 'sum',
        type: 'prompt',
        name: { en: 'Summarise' },
        position: { x: 1, y: 0 },
        config: { prompt: { en: 'Summarise {{input}} and {{summary}}' } }
      }
    ],
    edges: [{ id: 'e', source: 'start', target: 'sum' }]
  };

  it('is listed for every step after the start', () => {
    const { nodes, edges } = workflowToFlow(workflow);
    expect(collectUpstreamVariables(nodes, edges, 'sum')).toContainEqual({
      value: 'input',
      label: RUN_INPUT_VARIABLE.label
    });
  });

  it('is marked "chat runs only" when the start step declares input variables', () => {
    const withInputs = structuredClone(workflow);
    withInputs.nodes[0].config = { inputVariables: [{ name: 'summary', type: 'string' }] };
    const { nodes, edges } = workflowToFlow(withInputs);
    expect(collectUpstreamVariables(nodes, edges, 'sum')).toContainEqual({
      value: 'input',
      label: RUN_INPUT_VARIABLE.chatOnlyLabel
    });
    expect(RUN_INPUT_VARIABLE.chatOnlyLabel).toMatch(/chat runs only/);
  });

  it('is not reported as unknown; an undefined name still is', () => {
    const { nodes, edges } = workflowToFlow(workflow);
    expect(findUnknownReferences(nodes, edges).map(r => r.name)).toEqual(['summary']);
  });
});

describe('Ask a Person options (AX-B4, AX-B5)', () => {
  const humanConfig = () =>
    structuredClone(APPROVAL_WORKFLOW.nodes.find(n => n.type === 'human').config);

  it('shows a localized label as text and keeps the other language when it is edited', () => {
    const onChange = jest.fn();
    render(<HumanForm config={humanConfig()} onChange={onChange} />);

    expect(screen.queryByDisplayValue('[object Object]')).not.toBeInTheDocument();
    const field = screen.getByDisplayValue('Approve & Summarize');
    fireEvent.change(field, { target: { value: 'Approve' } });

    const updated = onChange.mock.calls.at(-1)[0];
    expect(updated.options[0].label).toEqual({ en: 'Approve', de: 'Genehmigen & Zusammenfassen' });
    expect(updated.options[1]).toEqual(humanConfig().options[1]);
  });

  it('warns when the step has no option left', () => {
    render(<HumanForm config={{ ...humanConfig(), options: [] }} onChange={jest.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Add at least one option');
  });

  it('does not warn when the step has no options list (the run offers "Continue")', () => {
    const { options: _options, ...withoutOptions } = humanConfig();
    render(<HumanForm config={withoutOptions} onChange={jest.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a step from the palette starts with one "Continue" option the save check accepts', () => {
    const node = createNewNode('human', { x: 0, y: 0 });
    expect(node.data.nodeConfig.options).toEqual([
      { value: 'continue', label: { en: 'Continue', de: 'Weiter' }, style: 'primary' }
    ]);
    const workflow = {
      nodes: [{ id: node.id, type: 'human', name: { en: '' }, config: node.data.nodeConfig }]
    };
    expect(findUnanswerableHumanSteps(workflow)).toEqual([]);

    render(<HumanForm config={node.data.nodeConfig} onChange={jest.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names each option field by its position and keeps button labels on one line', () => {
    render(<HumanForm config={humanConfig()} onChange={jest.fn()} />);
    const second = screen.getByRole('textbox', { name: 'Label of option 2' });
    expect(second.tagName).toBe('INPUT');
    expect(screen.getByRole('textbox', { name: 'Label of option 1' })).not.toBe(second);
    expect(screen.getByRole('textbox', { name: 'Value of option 2' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Style of option 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove option 2' })).toBeInTheDocument();
    // The visible label of the message is tied to its field.
    expect(screen.getByLabelText('Message').tagName).toBe('TEXTAREA');
  });

  it('a removed option does not hand its language tab to the next one', () => {
    const config = {
      ...humanConfig(),
      options: [
        { value: 'a', label: { en: 'First', de: 'Erste' } },
        { value: 'b', label: { en: 'Second', de: 'Zweite' } }
      ]
    };
    function Harness() {
      const [current, setCurrent] = useState(config);
      return <HumanForm config={current} onChange={setCurrent} />;
    }
    render(<Harness />);
    // Edit option 1 in German, then remove it.
    const firstLabel = screen.getByRole('textbox', { name: 'Label of option 1' });
    fireEvent.click(within(firstLabel.parentElement).getByRole('button', { name: 'de' }));
    expect(screen.getByRole('textbox', { name: 'Label of option 1' })).toHaveValue('Erste');
    fireEvent.click(screen.getByRole('button', { name: 'Remove option 1' }));

    // The former option 2 opens on its own (first) language.
    expect(screen.getByRole('textbox', { name: 'Label of option 1' })).toHaveValue('Second');
  });

  it("a refused save shows the server's message for the step", () => {
    const err = {
      message: 'Request failed with status code 400',
      response: {
        data: {
          detail: 'Invalid workflow definition',
          errors: [{ pointer: '/nodes/1/config/options', message: 'Step "Approve" needs …' }]
        }
      }
    };
    expect(workflowSaveErrorMessage(err)).toBe('Step "Approve" needs …');
    expect(workflowSaveErrorMessage({ response: { data: { detail: 'Nope' } } })).toBe('Nope');
    expect(workflowSaveErrorMessage(new Error('offline'))).toBe('offline');
  });
});

describe('who can run a workflow (AX-B10)', () => {
  const groups = {
    users: { permissions: { workflows: ['Summarise'] } },
    analysts: { permissions: { workflows: ['*'] } },
    authors: { permissions: { workflows: ['other'] } },
    admins: { adminAccess: true, permissions: {} }
  };

  it('lists the groups whose workflow grants name it or grant all', () => {
    expect(groupsGrantingWorkflow('summarise', groups)).toEqual(['analysts', 'users']);
  });

  it('is empty when no group grants it (admins only)', () => {
    expect(groupsGrantingWorkflow('summarise', { authors: groups.authors })).toEqual([]);
    expect(groupsGrantingWorkflow('summarise', null)).toEqual([]);
  });
});
