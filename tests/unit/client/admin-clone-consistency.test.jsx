// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Clone works the same on every admin list that offers it: the copy gets the
 * ID `<id>-copy` (or the next free one) and keeps the original's name, as on
 * Models and Prompts.
 *
 * - Groups: Clone opens a new group with the original's settings, the proposed
 *   ID and no external mappings; nothing is created before Save.
 * - Workflows: the copy keeps the name; there is no untranslated " (Copy)".
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate
}));

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue, opts) => {
    let str = typeof defaultValue === 'string' ? defaultValue : key;
    if (opts && typeof str === 'string') {
      for (const [k, v] of Object.entries(opts)) str = str.replace(`{{${k}}}`, v);
    }
    return str;
  };
  const translation = { t: translate, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockApi = {
  makeAdminApiCall: jest.fn(),
  fetchAdminWorkflows: jest.fn(),
  createAdminWorkflow: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockApi.makeAdminApiCall(...args),
  fetchAdminWorkflows: (...args) => mockApi.fetchAdminWorkflows(...args),
  createAdminWorkflow: (...args) => mockApi.createAdminWorkflow(...args),
  fetchAdminGroups: () => Promise.resolve({ groups: {} }),
  deleteAdminWorkflow: jest.fn(),
  toggleAdminWorkflow: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));

jest.mock('../../../client/src/features/admin/components/UploadConfigButton', () => ({
  __esModule: true,
  default: () => null
}));

// One Clone button per row is all these tests need from the table.
jest.mock('../../../client/src/features/admin/components/data-table', () => ({
  DataTable: ({ data, actions }) => (
    <div>
      {data.map(row =>
        actions
          .filter(action => action.id === 'clone')
          .map(action => (
            <button key={row.id} type="button" onClick={() => action.onClick(row)}>
              Clone {row.id}
            </button>
          ))
      )}
    </div>
  ),
  SearchInput: () => null,
  FilterSelect: () => null
}));

const { MemoryRouter } = jest.requireActual('react-router-dom');
const AdminGroupsPage = require('../../../client/src/features/admin/pages/AdminGroupsPage').default;
const AdminWorkflowsPage =
  require('../../../client/src/features/admin/pages/AdminWorkflowsPage').default;
const { groupCloneDraft } = require('../../../client/src/features/admin/utils/groupClone');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Groups', () => {
  const groups = {
    sales: {
      id: 'sales',
      name: 'Sales',
      permissions: { apps: ['crm'] },
      inherits: ['users'],
      mappings: ['Sales-Team']
    },
    'sales-copy': { id: 'sales-copy', name: 'Sales (old copy)' }
  };

  it('Clone opens a new group with the next free <id>-copy proposed', async () => {
    mockApi.makeAdminApiCall.mockResolvedValue({ data: { groups } });
    render(
      <MemoryRouter>
        <AdminGroupsPage />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Clone sales' }));
    expect(mockNavigate).toHaveBeenCalledWith('/admin/groups/new', {
      state: { templateGroup: groups.sales, cloneId: 'sales-copy-2' }
    });
    // Nothing is created from the list: the copy exists only once it is saved.
    expect(mockApi.makeAdminApiCall).not.toHaveBeenCalledWith(
      '/admin/groups',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('the copy keeps name, permissions and inheritance but no external mappings', () => {
    const defaults = { id: '', name: '', mappings: [], inherits: [], enabled: true };
    expect(groupCloneDraft(defaults, groups.sales, 'sales-copy-2')).toEqual({
      id: 'sales-copy-2',
      name: 'Sales',
      permissions: { apps: ['crm'] },
      inherits: ['users'],
      mappings: [],
      enabled: true
    });
  });
});

describe('Workflows', () => {
  it('the copy gets <id>-copy and keeps the name, without a " (Copy)" suffix', async () => {
    const workflow = { id: 'triage', name: { en: 'Triage', de: 'Sichtung' }, enabled: true };
    mockApi.fetchAdminWorkflows.mockResolvedValue([workflow]);
    mockApi.createAdminWorkflow.mockResolvedValue({});
    render(
      <MemoryRouter>
        <AdminWorkflowsPage />
      </MemoryRouter>
    );
    const clone = await screen.findByRole('button', { name: 'Clone triage' });
    await act(async () => {
      fireEvent.click(clone);
    });
    expect(mockApi.createAdminWorkflow).toHaveBeenCalledWith({
      ...workflow,
      id: 'triage-copy'
    });
  });
});
