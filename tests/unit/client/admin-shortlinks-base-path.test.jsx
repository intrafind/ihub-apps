// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import AdminShortLinks from '../../../client/src/features/admin/pages/AdminShortLinks';
import ShortLinkDetailsPopup from '../../../client/src/shared/components/ShortLinkDetailsPopup';
import AdminPagesPage from '../../../client/src/features/admin/pages/AdminPagesPage';
import { makeAdminApiCall, fetchAdminPages } from '../../../client/src/api/adminApi';

/**
 * Under a base path (`/ihub`) the admin's short-link Copy and Test, the
 * details popup's Test and the Pages "View" keep the base path (CU-B9):
 * `https://host/ihub/s/abc`, not `https://host/s/abc`, which 404s there.
 * `runtimeBasePath.js` reads `import.meta`, which jest cannot load, so
 * `buildPath` is stood in for by its contract: the base path in front.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

let mockBasePath = '/ihub';
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: path => `${mockBasePath}${path.startsWith('/') ? path : `/${path}`}`
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  fetchAdminPages: jest.fn(),
  deletePage: jest.fn(),
  getAdminApiErrorMessage: err => err?.message
}));

const mockCopyText = jest.fn();
jest.mock('../../../client/src/shared/hooks/useClipboard', () => ({
  useClipboard: () => ({ copyText: mockCopyText })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));

// One button per row action is all these tests need of the table.
jest.mock('../../../client/src/features/admin/components/data-table', () => ({
  DataTable: ({ data, actions, getRowId }) => (
    <ul>
      {data.map(row => (
        <li key={getRowId ? getRowId(row) : row.id}>
          {actions.map(action => (
            <button key={action.id} type="button" onClick={() => action.onClick(row)}>
              {action.label}
            </button>
          ))}
        </li>
      ))}
    </ul>
  ),
  SearchInput: () => null,
  parseSortParam: () => null,
  formatSortParam: () => ''
}));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let openSpy;
beforeEach(() => {
  jest.clearAllMocks();
  mockBasePath = '/ihub';
  mockCopyText.mockResolvedValue({ success: true });
  openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
});

afterEach(() => {
  openSpy.mockRestore();
});

const expected = `${window.location.origin}/ihub/s/abc12`;

test('Copy link copies the short link with the base path', async () => {
  makeAdminApiCall.mockResolvedValue({ data: { items: [{ code: 'abc12', appId: 'chat' }] } });
  render(
    <MemoryRouter initialEntries={['/admin/shortlinks']}>
      <AdminShortLinks />
    </MemoryRouter>
  );
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  await flush();
  expect(mockCopyText).toHaveBeenCalledWith(expected);
});

test('Test link opens the short link with the base path', async () => {
  makeAdminApiCall.mockResolvedValue({ data: { items: [{ code: 'abc12', appId: 'chat' }] } });
  render(
    <MemoryRouter initialEntries={['/admin/shortlinks']}>
      <AdminShortLinks />
    </MemoryRouter>
  );
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Test link' }));
  expect(openSpy).toHaveBeenCalledWith(expected, '_blank');
});

test('the details popup opens the short link with the base path', () => {
  render(
    <MemoryRouter>
      <ShortLinkDetailsPopup link={{ code: 'abc12', appId: 'chat' }} isOpen onClose={() => {}} />
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  expect(openSpy).toHaveBeenCalledWith(expected, '_blank');
});

test('Pages "View" opens the page under the base path', async () => {
  fetchAdminPages.mockResolvedValue([{ id: 'imprint', title: { en: 'Imprint' } }]);
  render(
    <MemoryRouter initialEntries={['/admin/pages']}>
      <AdminPagesPage />
    </MemoryRouter>
  );
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'View' }));
  expect(openSpy).toHaveBeenCalledWith('/ihub/pages/imprint', '_blank');
});

test('at the root the short link has no base path', async () => {
  mockBasePath = '';
  makeAdminApiCall.mockResolvedValue({ data: { items: [{ code: 'abc12', appId: 'chat' }] } });
  render(
    <MemoryRouter initialEntries={['/admin/shortlinks']}>
      <AdminShortLinks />
    </MemoryRouter>
  );
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  await flush();
  expect(mockCopyText).toHaveBeenCalledWith(`${window.location.origin}/s/abc12`);
});
