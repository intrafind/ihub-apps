// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * Deleting a group other groups inherit from is refused by the server (409
 * GROUP_IN_USE, ID-B4). The delete dialog stays open, says why, lists the
 * groups that inherit from it and offers only Close.
 */

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue, opts) => {
    let str = typeof defaultValue === 'string' ? defaultValue : key;
    if (opts && typeof str === 'string') {
      for (const [k, v] of Object.entries(opts)) {
        str = str.replace(new RegExp(`{{${k}}}`, 'g'), v);
      }
    }
    return str;
  };
  return { useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) };
});

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'failed'
}));

// One Delete button per row is all this test needs from the table.
jest.mock('../../../client/src/features/admin/components/data-table', () => ({
  DataTable: ({ data, actions }) => (
    <div>
      {data.map(row =>
        actions
          .filter(action => action.id === 'delete')
          .map(action => (
            <button key={row.id} type="button" onClick={() => action.onClick(row)}>
              Delete {row.id}
            </button>
          ))
      )}
    </div>
  )
}));

import AdminGroupsPage from '../../../client/src/features/admin/pages/AdminGroupsPage';

const GROUPS = {
  parent: { id: 'parent', name: 'Parent' },
  child: { id: 'child', name: 'Child group', inherits: ['parent'] }
};

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockImplementation((url, options = {}) => {
    if (options.method === 'DELETE') {
      return Promise.reject({
        response: {
          status: 409,
          data: {
            code: 'GROUP_IN_USE',
            detail: "Cannot delete group 'parent': child inherits from it.",
            details: { groupId: 'parent', dependants: ['child'] }
          }
        }
      });
    }
    return Promise.resolve({ data: { groups: GROUPS } });
  });
});

test('a refused delete keeps the dialog open, names the inheriting groups and offers only Close', async () => {
  render(
    <MemoryRouter>
      <AdminGroupsPage />
    </MemoryRouter>
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Delete parent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

  const dialog = await screen.findByRole('alertdialog');
  await waitFor(() => expect(within(dialog).getByText('Cannot delete group')).toBeInTheDocument());
  expect(within(dialog).getByRole('alert')).toHaveTextContent('child inherits from it');
  expect(within(dialog).getByTestId('group-delete-dependants')).toHaveTextContent('Child group');
  expect(within(dialog).queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});
