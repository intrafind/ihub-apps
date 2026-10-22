// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Workflow project steps in the visual editor (#1036, slice 6): the three
 * step types are registered (palette group, colour, icon, form, default
 * config, the variable each writes), their forms edit the config keys the
 * executors read, the project field picks an admin project or takes a
 * `$.data` reference, and the start step offers an input of type `project`.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockFetchAdminProjects = jest.fn();
const mockFetchAdminProjectKinds = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminProjects: (...args) => mockFetchAdminProjects(...args),
  fetchAdminProjectKinds: (...args) => mockFetchAdminProjectKinds(...args),
  fetchAdminProjectTokens: jest.fn().mockResolvedValue({ projects: {} })
}));
// The form registry loads every form; these back the other forms' pickers.
jest.mock('../../../client/src/api/client', () => ({ apiClient: { get: jest.fn() } }));
jest.mock('../../../client/src/api/endpoints/models', () => ({
  fetchModels: jest.fn().mockResolvedValue([])
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/api/endpoints/admin', () => ({
  fetchTools: jest.fn().mockResolvedValue([])
}));

jest.mock('react-i18next', () => {
  const en = require('../../../shared/i18n/en.json');
  const lookup = key => key.split('.').reduce((node, part) => node?.[part], en);
  const interpolate = (text, options = {}) =>
    Object.entries(options).reduce(
      (out, [name, value]) => out.replaceAll(`{{${name}}}`, String(value)),
      text
    );
  const translate = (key, fallbackOrOptions, maybeOptions) => {
    const options = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions;
    const fallback = typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key;
    const text = typeof lookup(key) === 'string' ? lookup(key) : fallback;
    return interpolate(text, options);
  };
  const translation = { t: translate, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

import {
  NODE_TYPES_LIST,
  NODE_TYPE_COLORS,
  defaultConfigForType,
  nodeTypeLabel,
  variablesProducedBy
} from '../../../client/src/features/workflows/editor/workflowEditorUtils';
import { nodeFormRegistry } from '../../../client/src/features/workflows/editor/panels/forms';
import * as config from '../../../client/src/features/workflows/utils/projectNodeConfig';
import ProjectItemsForm from '../../../client/src/features/workflows/editor/panels/forms/ProjectItemsForm';
import ProjectReadForm from '../../../client/src/features/workflows/editor/panels/forms/ProjectReadForm';
import ProjectWriteForm from '../../../client/src/features/workflows/editor/panels/forms/ProjectWriteForm';
import StartForm from '../../../client/src/features/workflows/editor/panels/forms/StartForm';

const ADMIN_PROJECTS = [
  { id: 'handbook', name: { en: 'Employee handbook' }, enabled: true },
  { id: 'archive', name: { en: 'Old archive' }, enabled: false }
];
const KINDS = [
  { id: 'upload', name: { en: 'Upload' }, enabled: true },
  { id: 'url', name: { en: 'Web page' }, enabled: true },
  { id: 'nextcloud', name: { en: 'Nextcloud' }, enabled: false }
];
const VARIABLES = [{ value: 'project', label: 'workflow input' }];

beforeEach(() => {
  mockFetchAdminProjects.mockReset().mockResolvedValue(ADMIN_PROJECTS);
  mockFetchAdminProjectKinds.mockReset().mockResolvedValue(KINDS);
});

describe('registration of the project steps', () => {
  const TYPES = ['project-items', 'project-read', 'project-write'];

  it('puts the three types in a Projects group of the palette with a colour and a form', () => {
    const group = NODE_TYPES_LIST.find(entry => entry.group === 'projects');
    expect(group.types).toEqual(TYPES);
    TYPES.forEach(type => {
      expect(NODE_TYPE_COLORS[type]).toMatch(/^#/);
      expect(nodeFormRegistry[type]).toBeDefined();
    });
  });

  it('translates the step labels', () => {
    const t = (key, fallback) => (key.endsWith('project-write.label') ? 'Im Projekt' : fallback);
    expect(nodeTypeLabel('project-write', t)).toBe('Im Projekt');
    expect(nodeTypeLabel('project-items')).toBe('Project Documents');
    // Types without a translation keep their English label.
    expect(nodeTypeLabel('prompt', (key, fallback) => fallback)).toBe('AI Step');
  });

  it('starts a dropped step with the default output variable of its executor', () => {
    expect(defaultConfigForType('project-items')).toEqual({
      project: '',
      outputVariable: '_projectItems'
    });
    expect(defaultConfigForType('project-read')).toMatchObject({
      document: '$.data._loopItem.id',
      outputVariable: '_projectDocument'
    });
    expect(defaultConfigForType('project-write')).toMatchObject({
      outputVariable: '_writtenDocument'
    });
  });

  it('knows the variable each step writes, named or by default', () => {
    const names = (type, nodeConfig) =>
      variablesProducedBy({ id: type, data: { nodeType: type, nodeConfig } }).map(v => v.name);
    expect(names('project-items', {})).toContain('_projectItems');
    expect(names('project-read', {})).toContain('_projectDocument');
    expect(names('project-write', {})).toContain('_writtenDocument');
    expect(names('project-items', { outputVariable: 'docs' })).toContain('docs');
    expect(names('project-items', { outputVariable: 'docs' })).not.toContain('_projectItems');
  });
});

describe('project step config rules', () => {
  it('tells a reference from a literal project id', () => {
    expect(config.isProjectReference('$.data.project')).toBe(true);
    expect(config.isProjectReference('handbook')).toBe(false);
    expect(config.isProjectReference(undefined)).toBe(false);
  });

  it('removes an empty kind list and the empty filter, since [] would match nothing', () => {
    const withKind = config.withListFilter({ project: 'p' }, 'kinds', ['upload']);
    expect(withKind).toEqual({ project: 'p', filter: { kinds: ['upload'] } });
    expect(config.withListFilter(withKind, 'kinds', [])).toEqual({ project: 'p' });
  });

  it('stores the default statuses as no key and keeps an empty list (every status)', () => {
    expect(config.effectiveStatuses(undefined)).toEqual(['ready', 'stale']);
    expect(config.withStatuses({}, ['stale', 'ready'])).toEqual({});
    expect(config.withStatuses({}, [])).toEqual({ filter: { status: [] } });
    expect(config.withStatuses({}, ['ready'])).toEqual({ filter: { status: ['ready'] } });
  });

  it('maps the pinned filter to a tri-state choice and back', () => {
    expect(config.pinnedChoice({})).toBe('any');
    expect(config.pinnedChoice({ pinned: false })).toBe('unpinned');
    expect(config.withPinnedChoice({}, 'pinned')).toEqual({ filter: { pinned: true } });
    expect(config.withPinnedChoice({ filter: { pinned: true } }, 'any')).toEqual({});
  });

  it('keeps toggled values in option order', () => {
    expect(config.toggleListValue(['failed'], 'ready', ['ready', 'stale', 'failed'])).toEqual([
      'ready',
      'failed'
    ]);
    expect(config.toggleListValue(['ready', 'failed'], 'ready')).toEqual(['failed']);
  });

  it('summarizes a step for its canvas card', () => {
    expect(config.projectNodeSummary('project-items', { project: '$.data.project' })).toBe(
      '$.data.project → _projectItems'
    );
    expect(config.projectNodeSummary('project-write', { project: 'p', name: 'Report' })).toBe(
      'Report → p'
    );
    expect(config.projectNodeSummary('project-read', {})).toBe('');
  });

  it('saves a read-only link for a chosen project and drops it with the choice', () => {
    const link = id => ({ id, mode: 'auto', write: false });
    const chosen = config.withProjectValue({}, 'handbook', { picked: true });
    expect(chosen).toEqual({ project: 'handbook', projects: [link('handbook')] });
    // Another choice replaces the link added for the previous one…
    expect(config.withProjectValue(chosen, 'faq', { picked: true })).toEqual({
      project: 'faq',
      projects: [link('faq')]
    });
    // …clearing the choice or typing another id removes it…
    expect(config.withProjectValue(chosen, '', { picked: true })).toEqual({ project: '' });
    expect(config.withProjectValue(chosen, '$.data.case')).toEqual({ project: '$.data.case' });
    // …but a link the author changed since, or wrote, stays.
    const edited = { project: 'handbook', projects: [{ ...link('handbook'), write: true }, 'faq'] };
    expect(config.withProjectValue(edited, 'faq', { picked: true })).toEqual({
      project: 'faq',
      projects: edited.projects
    });
    // A reference or a typed id never gets one.
    expect(config.withProjectValue({}, '$.data.case', { picked: true })).toEqual({
      project: '$.data.case'
    });
    expect(config.withProjectValue({}, 'prj_abc')).toEqual({ project: 'prj_abc' });
  });

  it('groups the projects of the run dialog like the project list', () => {
    const groups = config.groupProjectOptions([
      { id: 'a', name: { en: 'Zeta' }, ownership: 'admin' },
      { id: 'prj_2', name: 'Beta', ownership: 'user', permissions: { isOwner: true } },
      { id: 'prj_1', name: 'Alpha', ownership: 'user', permissions: { isOwner: true } },
      { id: 'prj_3', name: 'Shared', ownership: 'user', permissions: { isOwner: false } }
    ]);
    expect(groups.map(group => group.group)).toEqual(['mine', 'shared', 'apps']);
    expect(groups[0].options.map(option => option.name)).toEqual(['Alpha', 'Beta']);
    expect(config.projectNameFor('a', [{ id: 'a', name: { en: 'Zeta' } }])).toBe('Zeta');
    expect(config.projectNameFor('gone', [])).toBe('gone');
  });
});

describe('the project field', () => {
  it('offers the enabled admin projects and writes the picked id', async () => {
    const onChange = jest.fn();
    render(<ProjectReadForm config={{}} onChange={onChange} variables={VARIABLES} />);
    const select = await screen.findByLabelText('Project');
    await waitFor(() => expect(within(select).getByText('Employee handbook')).toBeInTheDocument());
    expect(within(select).queryByText(/Old archive/)).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'handbook' } });
    // A chosen admin project brings the read-only step link the server
    // reaches it through (and lists as a dependency).
    expect(onChange).toHaveBeenCalledWith({
      project: 'handbook',
      projects: [{ id: 'handbook', mode: 'auto', write: false }]
    });
  });

  it('keeps an existing link to the chosen project as it is, in every project step', async () => {
    const granted = { id: 'handbook', mode: 'tools', write: true };
    for (const Form of [ProjectItemsForm, ProjectReadForm, ProjectWriteForm]) {
      const onChange = jest.fn();
      const { unmount } = render(
        <Form config={{ projects: ['faq', granted] }} onChange={onChange} variables={VARIABLES} />
      );
      const select = await screen.findByLabelText('Project');
      await waitFor(() =>
        expect(within(select).getByText('Employee handbook')).toBeInTheDocument()
      );
      fireEvent.change(select, { target: { value: 'handbook' } });
      expect(onChange).toHaveBeenLastCalledWith({
        project: 'handbook',
        projects: ['faq', granted]
      });
      unmount();
    }
  });

  it('adds no link for a typed id or a reference', async () => {
    const onChange = jest.fn();
    render(<ProjectWriteForm config={{ project: '$.data.project' }} onChange={onChange} />);
    const input = await screen.findByLabelText('Project');
    fireEvent.change(input, { target: { value: 'handbook' } });
    expect(onChange).toHaveBeenLastCalledWith({ project: 'handbook' });
    fireEvent.change(input, { target: { value: '$.data.case' } });
    expect(onChange).toHaveBeenLastCalledWith({ project: '$.data.case' });
  });

  it('opens on the text input for a reference and suggests variables as $.data references', async () => {
    const onChange = jest.fn();
    const { container } = render(
      <ProjectReadForm
        config={{ project: '$.data.project' }}
        onChange={onChange}
        variables={VARIABLES}
      />
    );
    const input = await screen.findByLabelText('Project');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveValue('$.data.project');
    const options = [...container.querySelectorAll('datalist option')].map(o => o.value);
    expect(options).toContain('$.data.project');
    fireEvent.change(input, { target: { value: '$.data.other' } });
    expect(onChange).toHaveBeenCalledWith({ project: '$.data.other' });
  });

  it('switches between choosing and typing', async () => {
    render(<ProjectReadForm config={{}} onChange={() => {}} variables={VARIABLES} />);
    expect((await screen.findByLabelText('Project')).tagName).toBe('SELECT');
    fireEvent.click(screen.getByRole('button', { name: 'ID or variable' }));
    expect(screen.getByLabelText('Project').tagName).toBe('INPUT');
  });

  it('falls back to the text input when the projects cannot be loaded', async () => {
    mockFetchAdminProjects.mockRejectedValue(new Error('boom'));
    render(<ProjectReadForm config={{}} onChange={() => {}} variables={VARIABLES} />);
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.getByLabelText('Project').tagName).toBe('INPUT');
  });

  it('keeps a set id that is not an admin project visible', async () => {
    render(<ProjectReadForm config={{ project: 'prj_abc' }} onChange={() => {}} />);
    const select = await screen.findByLabelText('Project');
    await waitFor(() => expect(select).toHaveValue('prj_abc'));
    expect(within(select).getByText('prj_abc (not in the list)')).toBeInTheDocument();
  });
});

describe('the project documents form', () => {
  it('offers the enabled kinds, the statuses (ready and outdated by default) and the pinned choice', async () => {
    render(<ProjectItemsForm config={{ project: 'handbook' }} onChange={() => {}} />);
    const kinds = await screen.findByRole('group', { name: 'Item kinds' });
    await waitFor(() => expect(within(kinds).getByLabelText('Web page')).toBeInTheDocument());
    expect(within(kinds).queryByLabelText('Nextcloud')).not.toBeInTheDocument();

    const status = screen.getByRole('group', { name: 'Status' });
    expect(within(status).getByLabelText('Ready')).toBeChecked();
    expect(within(status).getByLabelText('Outdated')).toBeChecked();
    expect(within(status).getByLabelText('Failed')).not.toBeChecked();
    expect(screen.getByLabelText('Pinned')).toHaveValue('any');
  });

  it('writes the filter keys the executor reads', async () => {
    const onChange = jest.fn();
    render(<ProjectItemsForm config={{ project: 'handbook' }} onChange={onChange} />);
    const kinds = await screen.findByRole('group', { name: 'Item kinds' });
    await waitFor(() => expect(within(kinds).getByLabelText('Upload')).toBeInTheDocument());

    fireEvent.click(within(kinds).getByLabelText('Upload'));
    expect(onChange).toHaveBeenLastCalledWith({
      project: 'handbook',
      filter: { kinds: ['upload'] }
    });

    fireEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByLabelText('Failed'));
    expect(onChange).toHaveBeenLastCalledWith({
      project: 'handbook',
      filter: { status: ['ready', 'stale', 'failed'] }
    });

    fireEvent.change(screen.getByLabelText('Pinned'), { target: { value: 'unpinned' } });
    expect(onChange).toHaveBeenLastCalledWith({ project: 'handbook', filter: { pinned: false } });

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Origin' })).getByLabelText('Written by a run')
    );
    expect(onChange).toHaveBeenLastCalledWith({
      project: 'handbook',
      filter: { origin: ['written'] }
    });

    fireEvent.change(screen.getByLabelText('Max documents'), { target: { value: '50' } });
    expect(onChange).toHaveBeenLastCalledWith({ project: 'handbook', limit: 50 });
  });

  it('falls back to the built-in kinds when the server list cannot be loaded', async () => {
    mockFetchAdminProjectKinds.mockRejectedValue(new Error('down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    render(<ProjectItemsForm config={{}} onChange={() => {}} />);
    const kinds = await screen.findByRole('group', { name: 'Item kinds' });
    await waitFor(() => expect(within(kinds).getByLabelText('ifinder-query')).toBeInTheDocument());
    console.error.mockRestore();
  });
});

describe('the read and save forms', () => {
  it('edits document, section, budget and output of a read step', async () => {
    const onChange = jest.fn();
    render(<ProjectReadForm config={{ project: 'handbook' }} onChange={onChange} />);
    await screen.findByLabelText('Project');
    fireEvent.change(screen.getByLabelText('Document'), {
      target: { value: '$.data._loopItem.id' }
    });
    expect(onChange).toHaveBeenLastCalledWith({
      project: 'handbook',
      document: '$.data._loopItem.id'
    });
    fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'Intro' } });
    expect(onChange).toHaveBeenLastCalledWith({ project: 'handbook', section: 'Intro' });
    fireEvent.change(screen.getByLabelText('Max characters'), { target: { value: '4000' } });
    expect(onChange).toHaveBeenLastCalledWith({ project: 'handbook', maxChars: 4000 });
    expect(screen.getByLabelText('Output variable')).toHaveAttribute(
      'placeholder',
      '_projectDocument'
    );
  });

  it('edits name, text, pinned and wait of a save step, with wait on by default', async () => {
    const onChange = jest.fn();
    render(<ProjectWriteForm config={{ project: 'handbook' }} onChange={onChange} />);
    await screen.findByLabelText('Project');
    expect(screen.getByLabelText('Document name')).toHaveAttribute(
      'placeholder',
      'Summary of {{item.name}}'
    );
    fireEvent.change(screen.getByLabelText('Document name'), {
      target: { value: 'Summary of {{item.name}}' }
    });
    expect(onChange).toHaveBeenLastCalledWith({
      project: 'handbook',
      name: 'Summary of {{item.name}}'
    });
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: '$.data.summary' } });
    expect(onChange).toHaveBeenLastCalledWith({ project: 'handbook', text: '$.data.summary' });

    expect(screen.getByLabelText('Pin the document')).not.toBeChecked();
    const wait = screen.getByLabelText('Wait until the document is ready');
    expect(wait).toBeChecked();
    fireEvent.click(wait);
    expect(onChange).toHaveBeenLastCalledWith({ project: 'handbook', wait: false });
    expect(screen.getByText(/needs a workflow project link with write access/)).toBeInTheDocument();
  });
});

describe('the start step', () => {
  it('offers Project as an input type and explains the reference', () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <StartForm
        config={{ inputVariables: [{ name: 'project', type: 'string' }] }}
        onChange={onChange}
      />
    );
    const select = screen.getByDisplayValue('String');
    expect(within(select).getByRole('option', { name: 'Project' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'project' } });
    expect(onChange).toHaveBeenCalledWith({
      inputVariables: [{ name: 'project', type: 'project' }]
    });

    rerender(
      <StartForm
        config={{ inputVariables: [{ name: 'project', type: 'project' }] }}
        onChange={onChange}
      />
    );
    expect(screen.getByText(/Project steps read it as \$\.data\.project/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('flags a project input named input, which a chat run uses for its message', () => {
    const { rerender } = render(
      <StartForm
        config={{ inputVariables: [{ name: 'input', type: 'project' }] }}
        onChange={() => {}}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('cannot be named "input"');
    // A text input of that name is what the chat fills; it is fine.
    rerender(
      <StartForm
        config={{ inputVariables: [{ name: 'input', type: 'string' }] }}
        onChange={() => {}}
      />
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
