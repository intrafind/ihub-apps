// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Pages → New page: an id of only spaces passes the browser's
 * `required` check, so the form catches it with an inline error (no native
 * alert), and typing clears that error.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockCreatePage = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  createPage: (...a) => mockCreatePage(...a),
  updatePage: jest.fn(),
  fetchAdminPage: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ blocker: { state: 'unblocked' }, markSaved: jest.fn() })
}));
jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
  useParams: () => ({ pageId: 'new' })
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const AdminPageEditPage =
  require('../../../client/src/features/admin/pages/AdminPageEditPage').default;

test('a blank id shows an inline error, and typing clears it', async () => {
  const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
  render(<AdminPageEditPage />);
  const idField = screen.getByLabelText('Page ID');
  fireEvent.change(idField, { target: { value: '   ' } });
  await act(async () => {
    fireEvent.submit(idField.closest('form'));
  });

  expect(screen.getByRole('alert')).toHaveTextContent('ID is required');
  expect(idField).toHaveAttribute('aria-invalid', 'true');
  expect(idField).toHaveFocus();
  expect(mockCreatePage).not.toHaveBeenCalled();

  fireEvent.change(idField, { target: { value: 'faq' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(alertSpy).not.toHaveBeenCalled();
  alertSpy.mockRestore();
});
