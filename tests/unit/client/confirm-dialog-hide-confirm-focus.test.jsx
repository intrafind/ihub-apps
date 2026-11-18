// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * ConfirmDialog: when the Confirm button is hidden while the dialog is open
 * (the action was refused), focus moves to the remaining button instead of
 * falling back to the page body outside the dialog (WCAG 2.4.3).
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}));
jest.mock('../../../client/src/shared/components/Icon', () => () => null);

import ConfirmDialog from '../../../client/src/shared/components/ConfirmDialog';

const props = {
  isOpen: true,
  title: 'Delete user',
  message: 'Really?',
  confirmLabel: 'Delete',
  denyLabel: 'Cancel',
  onConfirm: () => {},
  onDeny: () => {}
};

test('hiding Confirm while it has focus moves focus to the remaining button', () => {
  const { rerender } = render(<ConfirmDialog {...props} />);
  const confirm = screen.getByRole('button', { name: 'Delete' });
  confirm.focus();
  expect(confirm).toHaveFocus();

  rerender(<ConfirmDialog {...props} denyLabel="Close" hideConfirm />);

  expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
});
