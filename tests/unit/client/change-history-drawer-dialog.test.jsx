// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The change history drawer is a modal dialog (the shared Drawer), and its
 * rollback confirmation is an alert dialog stacked on top of it: Escape in the
 * confirmation cancels the rollback and leaves the drawer open.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

const mockCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockCall(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
// A stable `t`, as react-i18next's: the drawer refetches when it changes.
const mockI18n = {
  t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key)
};
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const ChangeHistoryDrawer =
  require('../../../client/src/features/admin/components/ChangeHistoryDrawer').default;

const SNAPSHOT = {
  filename: '2026-10-22T10-00-00.json',
  ts: '2026-10-22T10:00:00.000Z',
  admin: 'ada'
};

beforeEach(() => {
  mockCall.mockReset();
  mockCall.mockImplementation(async url =>
    url.endsWith('.json')
      ? { data: { ...SNAPSHOT, before: { name: 'Old' }, after: { name: 'New' } } }
      : { data: [SNAPSHOT] }
  );
});

describe('ChangeHistoryDrawer as a dialog', () => {
  test('is a modal dialog named "Change History" that closes on Escape', async () => {
    const onClose = jest.fn();
    render(<ChangeHistoryDrawer isOpen onClose={onClose} resource="apps" resourceId="chat" />);

    const dialog = await screen.findByRole('dialog', { name: 'Change History' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('apps / chat');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('is hidden from assistive technology while closed', () => {
    render(
      <ChangeHistoryDrawer isOpen={false} onClose={() => {}} resource="apps" resourceId="chat" />
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('confirms a rollback in an alert dialog that Escape cancels without closing the drawer', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<ChangeHistoryDrawer isOpen onClose={onClose} resource="apps" resourceId="chat" />);

    await user.click(await screen.findByText(/by ada/));
    await user.click(await screen.findByRole('button', { name: 'Rollback to this version' }));

    const confirm = screen.getByRole('alertdialog', { name: 'Confirm Rollback' });
    expect(confirm).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Change History' })).toBeInTheDocument();
  });
});
