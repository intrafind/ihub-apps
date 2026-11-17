// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Usage → Tracking mode: changing the mode opens a confirmation, and
 * Cancel returns keyboard focus to the select. The select must stay enabled
 * while the dialog is open: a focused element that becomes disabled loses
 * focus to <body>, and focus could not come back to it.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockFetchMeta = jest.fn();
const mockUpdateMode = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminUsageMeta: (...a) => mockFetchMeta(...a),
  updateAdminUsageTrackingMode: (...a) => mockUpdateMode(...a)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const { TrackingMode } = require('../../../client/src/features/admin/pages/AdminUsageReports');

test('the select stays enabled while the dialog is open and gets focus back on Cancel', async () => {
  mockFetchMeta.mockResolvedValue({ trackingMode: 'pseudonymous' });
  render(<TrackingMode />);
  const select = await screen.findByRole('combobox', { name: 'Tracking mode' });
  select.focus();
  fireEvent.change(select, { target: { value: 'identified' } });

  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  expect(select).not.toBeDisabled();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });
  await waitFor(() => expect(select).toHaveFocus());
  expect(select).toHaveValue('pseudonymous');
  expect(mockUpdateMode).not.toHaveBeenCalled();
});
