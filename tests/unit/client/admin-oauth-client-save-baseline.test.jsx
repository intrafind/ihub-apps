// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → OAuth → client editor, what counts as saved. The saved baseline is the snapshot a
 * save SENT, not whatever the form holds when the answer arrives:
 *
 * - an edit made while the save runs is still unsaved afterwards, and keeps the bar;
 * - after a save, Discard puts back what was saved, not what the page loaded with.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

const AdminOAuthClientEditPage =
  require('../../../client/src/features/admin/pages/AdminOAuthClientEditPage').default;

const STORED = {
  clientId: 'svc-1',
  name: 'Reporting',
  allowedApps: ['chat'],
  allowedModels: [],
  allowedPrompts: [],
  grantTypes: ['client_credentials']
};

let releasePut;

function renderEditor({ deferPut = false } = {}) {
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockImplementation(async (url, options = {}) => {
    if (url === '/admin/apps') return { data: [{ id: 'chat', name: { en: 'Chat' } }] };
    if (url === '/admin/models') return { data: { items: [] } };
    if (url === '/admin/prompts') return { data: [] };
    if (url === '/admin/oauth/clients/svc-1' && options.method === 'PUT') {
      if (deferPut) await new Promise(resolve => (releasePut = resolve));
      return { data: {} };
    }
    if (url === '/admin/oauth/clients/svc-1') return { data: STORED };
    return { data: {} };
  });
  render(
    <MemoryRouter initialEntries={['/admin/oauth/clients/svc-1']}>
      <Routes>
        <Route path="/admin/oauth/clients/:clientId" element={<AdminOAuthClientEditPage />} />
      </Routes>
    </MemoryRouter>
  );
}

const bar = () => screen.queryByRole('region', { name: /save changes/i });
const saveButton = () => within(bar()).getAllByRole('button').at(-1);
const nameField = () => screen.getByLabelText(/Client Name/);

describe('OAuth client editor: the saved baseline', () => {
  test('an edit made while the save runs stays unsaved and keeps the bar', async () => {
    renderEditor({ deferPut: true });
    await waitFor(() => expect(nameField()).toHaveValue('Reporting'));

    fireEvent.change(nameField(), { target: { value: 'Reports B' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(releasePut).toBeDefined());

    // The form is still editable while the request is out.
    fireEvent.change(nameField(), { target: { value: 'Reports C' } });
    await act(async () => {
      releasePut();
    });

    const put = mockMakeAdminApiCall.mock.calls.find(([, o]) => o?.method === 'PUT');
    expect(put[1].body.name).toBe('Reports B');
    expect(nameField()).toHaveValue('Reports C');
    expect(bar()).toBeInTheDocument();
  });

  test('after a save, Discard puts back what was saved, not what the page loaded with', async () => {
    renderEditor();
    await waitFor(() => expect(nameField()).toHaveValue('Reporting'));

    fireEvent.change(nameField(), { target: { value: 'Reports B' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(bar()).not.toBeInTheDocument());

    fireEvent.change(nameField(), { target: { value: 'Reports C' } });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Discard' }));

    expect(nameField()).toHaveValue('Reports B');
    expect(bar()).not.toBeInTheDocument();
  });
});
