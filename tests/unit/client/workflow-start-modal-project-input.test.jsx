// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The run dialog's input of type `project` (#1036, slice 6): it lists the
 * projects the running user may use, grouped like the project list, and
 * sends the picked project id in `initialData`. Without projects it takes a
 * typed id. The execution page shows the project's name for such an input.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPost = jest.fn();
jest.mock('../../../client/src/api/client', () => ({
  apiClient: { post: (...args) => mockPost(...args) }
}));
jest.mock('../../../client/src/api/endpoints/models', () => ({
  fetchModels: jest.fn().mockResolvedValue([])
}));
jest.mock('../../../client/src/features/upload/components/UnifiedUploader', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/LoadingSpinner', () => ({
  __esModule: true,
  default: () => null
}));

let mockProjectsState;
jest.mock('../../../client/src/features/projects/hooks/useProjects', () => ({
  useUsableProjects: () => mockProjectsState
}));

jest.mock('react-i18next', () => {
  const en = require('../../../shared/i18n/en.json');
  const lookup = key => key.split('.').reduce((node, part) => node?.[part], en);
  const translate = (key, fallbackOrOptions, maybeOptions) => {
    const options = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions || {};
    const fallback = typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key;
    const text = typeof lookup(key) === 'string' ? lookup(key) : fallback;
    return Object.entries(options).reduce(
      (out, [name, value]) => out.replaceAll(`{{${name}}}`, String(value)),
      text
    );
  };
  const translation = { t: translate, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const StartWorkflowModal =
  require('../../../client/src/features/workflows/components/StartWorkflowModal').default;
const {
  ProjectInputValue
} = require('../../../client/src/features/workflows/components/ProjectInputField');

const PROJECTS = [
  { id: 'prj_mine', name: 'Due diligence', ownership: 'user', permissions: { isOwner: true } },
  { id: 'prj_team', name: 'Team notes', ownership: 'user', permissions: { isOwner: false } },
  { id: 'handbook', name: { en: 'Employee handbook' }, ownership: 'admin' }
];

const WORKFLOW = {
  id: 'summarize-project',
  name: { en: 'Summarize a project' },
  nodes: [
    {
      id: 'start',
      type: 'start',
      config: {
        inputVariables: [
          { name: 'project', type: 'project', required: true, label: { en: 'Project' } }
        ]
      }
    },
    { id: 'items', type: 'project-items', config: { project: '$.data.project' } }
  ]
};

const renderModal = () =>
  render(<StartWorkflowModal workflow={WORKFLOW} isOpen onClose={() => {}} onStarted={() => {}} />);

beforeAll(() => {
  // jsdom has no layout: the dialog scrolls the first invalid field into view.
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  mockPost.mockReset().mockResolvedValue({ data: { executionId: 'wf-exec-1' } });
  mockProjectsState = {
    projects: PROJECTS,
    loading: false,
    error: null,
    available: true,
    reload: jest.fn()
  };
});

describe('the run dialog project input', () => {
  it('lists the usable projects grouped into mine, shared with me and from apps', () => {
    renderModal();
    const select = screen.getByRole('combobox', { name: 'Project' });
    const groups = within(select).getAllByRole('group');
    expect(groups.map(group => group.getAttribute('label'))).toEqual([
      'Mine',
      'Shared with me',
      'From apps'
    ]);
    expect(within(select).getByRole('option', { name: 'Employee handbook' })).toBeInTheDocument();
  });

  it('sends the picked project id in initialData', async () => {
    renderModal();
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), {
      target: { value: 'handbook' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Start Workflow/ }));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledWith('/workflows/summarize-project/execute', {
      initialData: { project: 'handbook' },
      options: { checkpointOnNode: true }
    });
  });

  it('asks for a required project before starting', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Start Workflow/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('This field is required');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('says so when the user has no project to choose', () => {
    mockProjectsState = { ...mockProjectsState, projects: [] };
    renderModal();
    expect(screen.getByRole('combobox', { name: 'Project' })).toBeDisabled();
    expect(screen.getByText('You have no projects to choose from yet.')).toBeInTheDocument();
  });

  it('takes a typed project id when projects are not available', async () => {
    mockProjectsState = { ...mockProjectsState, projects: [], available: false };
    renderModal();
    const input = screen.getByRole('textbox', { name: 'Project' });
    expect(screen.getByText(/Projects are not available to you here/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: ' prj_typed ' } });
    fireEvent.click(screen.getByRole('button', { name: /Start Workflow/ }));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0][1].initialData).toEqual({ project: 'prj_typed' });
  });

  it('offers a retry when the list cannot be loaded', () => {
    mockProjectsState = { ...mockProjectsState, projects: [], error: new Error('down') };
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mockProjectsState.reload).toHaveBeenCalled();
  });
});

describe('a project input on the execution page', () => {
  it("shows the project's name with its id", () => {
    render(<ProjectInputValue projectId="handbook" />);
    expect(screen.getByText('Employee handbook')).toBeInTheDocument();
    expect(screen.getByText('handbook')).toBeInTheDocument();
  });

  it('shows the id alone for a project outside the list', () => {
    render(<ProjectInputValue projectId="prj_gone" />);
    expect(screen.getAllByText('prj_gone')).toHaveLength(1);
  });
});
