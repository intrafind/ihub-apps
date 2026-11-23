// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The CIMD client page shows the bottom save bar only for unsaved policy edits, saves the
 * policy it shows, discards back to the stored one, and (new) asks before leaving with
 * unsaved edits.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...a) => mockApi(...a)
}));
const stub = () => ({ __esModule: true, default: () => null });
jest.mock('../../../client/src/shared/components/Icon', () => stub());
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => stub());
jest.mock('../../../client/src/features/admin/components/ResourceSelector', () => stub());
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const en = require('../../../shared/i18n/en.json');
const AdminOAuthCimdClientEditPage =
  require('../../../client/src/features/admin/pages/AdminOAuthCimdClientEditPage').default;

const CLIENT = {
  name: 'Claude',
  policy: {},
  effective: { allowedGroups: ['users'], allowedApps: [], tokenExpirationMinutes: 60 }
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/oauth/clients/cimd/abc']}>
      <Routes>
        <Route
          path="/admin/oauth/clients/cimd/:encodedClientId"
          element={<AdminOAuthCimdClientEditPage />}
        />
        <Route path="/admin/oauth/clients" element={<div>clients list</div>} />
      </Routes>
    </MemoryRouter>
  );

const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const saveButton = () => within(bar()).getAllByRole('button').at(-1);
/** The first "Inherit the global default" checkbox: the groups policy. */
const groupsInherit = async () =>
  (await screen.findAllByLabelText(/Inherit the global default/))[0];

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.mockImplementation(async (path, options = {}) => {
    if (options.method === 'PUT') return { data: { client: CLIENT } };
    if (path.startsWith('/admin/oauth/clients/cimd/')) return { data: CLIENT };
    return { data: { items: [] } };
  });
});

describe('AdminOAuthCimdClientEditPage save bar', () => {
  it('has no bar until the policy changes; Discard restores the stored policy', async () => {
    renderPage();
    const inherit = await groupsInherit();
    expect(inherit).toBeChecked();
    expect(bar()).toBeNull();

    fireEvent.click(inherit);
    expect(bar()).toBeInTheDocument();
    expect((await groupsInherit()).checked).toBe(false);

    fireEvent.click(within(bar()).getByRole('button', { name: en.admin.ui.saveBar.discard }));
    expect(await groupsInherit()).toBeChecked();
    expect(bar()).toBeNull();
  });

  it('saves the policy and the page is clean again', async () => {
    renderPage();
    fireEvent.click(await groupsInherit());

    await act(async () => {
      fireEvent.click(saveButton());
    });

    const put = mockApi.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(put[0]).toBe('/admin/oauth/clients/cimd/abc');
    // Leaving "inherit" starts from what the field effectively has: access is not widened.
    expect(put[1].body.allowedGroups).toEqual(['users']);
    expect(bar()).toBeNull();
    expect(screen.getByText('Policy saved')).toBeInTheDocument();
  });

  it('asks before leaving with unsaved policy edits', async () => {
    const { container } = renderPage();
    fireEvent.click(await groupsInherit());

    // The arrow in the page header leads back to the list.
    fireEvent.click(container.querySelector('button.mr-4'));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Leave without saving?')).toBeInTheDocument();
    expect(screen.queryByText('clients list')).not.toBeInTheDocument();
  });

  it('leaves without a prompt when nothing changed', async () => {
    const { container } = renderPage();
    await groupsInherit();

    fireEvent.click(container.querySelector('button.mr-4'));

    expect(screen.getByText('clients list')).toBeInTheDocument();
  });
});
