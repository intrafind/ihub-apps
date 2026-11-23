// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Group editor and the optimistic lock on group saves.
 *
 * The page keeps the `ETag` of the `GET /admin/groups` it loaded and sends it as
 * `If-Match` with `PUT /admin/groups/{id}`. When someone else saved the groups in
 * between, the server answers 412 `PRECONDITION_FAILED`: the page says so, keeps
 * the admin's edits, and offers Reload, which loads the group as it is stored now.
 */

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({ getBasePath: () => '' }));
jest.mock('../../../client/src/utils/schemaService', () => ({
  getSchemaByType: async () => null
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));
jest.mock('../../../client/src/features/admin/components/GroupMembersSection', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/UsageLimitsEditor', () => ({
  __esModule: true,
  default: () => null,
  normalizeUsageLimits: value => value ?? null
}));
// A stand-in editor: shows the group name and has one button that renames it.
jest.mock('../../../client/src/shared/components/DualModeEditor', () => ({
  __esModule: true,
  default: ({ value, onChange }) =>
    value && onChange ? (
      <div>
        <span data-testid="group-name">{value.name}</span>
        <button type="button" onClick={() => onChange({ ...value, name: 'Team (edited)' })}>
          rename
        </button>
      </div>
    ) : null
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

const AdminGroupEditPage =
  require('../../../client/src/features/admin/pages/AdminGroupEditPage').default;

let storedName;
let etag;
let putResult;

beforeEach(() => {
  storedName = 'Team';
  etag = '"rev-1"';
  putResult = null;
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockImplementation(async (url, options) => {
    if (url === '/admin/groups' && (!options || !options.method)) {
      return {
        data: {
          groups: {
            team: {
              id: 'team',
              name: storedName,
              description: '',
              permissions: { apps: [], prompts: [], models: [] }
            }
          }
        },
        headers: { etag }
      };
    }
    if (url === '/admin/groups/team' && options?.method === 'PUT') {
      if (putResult) throw putResult;
      return { data: {}, headers: { etag: '"rev-2"' } };
    }
    if (url === '/admin/groups/resources') return { data: {} };
    return { data: {} };
  });
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/admin/groups/team']}>
      <Routes>
        <Route path="/admin/groups/:groupId" element={<AdminGroupEditPage />} />
        <Route path="/admin/groups" element={<div>group list</div>} />
      </Routes>
    </MemoryRouter>
  );
}

async function renameAndSave() {
  fireEvent.click(await screen.findByRole('button', { name: 'rename' }));
  const bar = screen.getByRole('region', { name: 'Save changes' });
  const buttons = within(bar).getAllByRole('button');
  await act(async () => {
    fireEvent.click(buttons[buttons.length - 1]);
  });
}

const putCall = () =>
  mockMakeAdminApiCall.mock.calls.find(
    ([url, options]) => url === '/admin/groups/team' && options?.method === 'PUT'
  );

describe('group editor save with If-Match', () => {
  test('sends the ETag of the read the form was loaded from', async () => {
    renderPage();
    await renameAndSave();

    expect(putCall()[1].headers['If-Match']).toBe('"rev-1"');
    expect(await screen.findByText('group list')).toBeInTheDocument();
  });

  test('on 412 says someone else changed the groups and keeps the edits', async () => {
    putResult = Object.assign(new Error('changed'), {
      response: { status: 412, data: { code: 'PRECONDITION_FAILED' } }
    });
    renderPage();
    await renameAndSave();

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Changed by someone else')).toBeInTheDocument();
    expect(within(alert).getByText(/Nothing was saved/)).toBeInTheDocument();
    // The page stays with the admin's edit.
    expect(screen.queryByText('group list')).toBeNull();
    expect(screen.getByTestId('group-name')).toHaveTextContent('Team (edited)');
  });

  test('Reload loads the group as stored now and the next save sends its ETag', async () => {
    putResult = Object.assign(new Error('changed'), {
      response: { status: 412, data: { code: 'PRECONDITION_FAILED' } }
    });
    renderPage();
    await renameAndSave();

    // Someone else's save.
    storedName = 'Team (by someone else)';
    etag = '"rev-9"';
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Reload' }));
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('group-name')).toHaveTextContent('Team (by someone else)');

    putResult = null;
    mockMakeAdminApiCall.mockClear();
    await renameAndSave();
    expect(putCall()[1].headers['If-Match']).toBe('"rev-9"');
  });
});
