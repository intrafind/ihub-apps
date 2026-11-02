// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The change history drawer is a modal dialog (the shared Drawer), and its
 * rollback confirmation is an alert dialog stacked on top of it: Escape in the
 * confirmation cancels the rollback and leaves the drawer open.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
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

// jsdom has no layout, which the focus trap reads as "not rendered". Give
// elements a box, as a browser would, so the trap sees the dialog's buttons.
describe('ChangeHistoryDrawer rollback confirmation with layout', () => {
  const layoutProps = ['offsetWidth', 'offsetHeight', 'offsetParent'];
  const originals = {};
  beforeEach(() => {
    for (const prop of layoutProps) {
      originals[prop] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 100
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 20
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() {
        return this.parentNode;
      }
    });
  });
  afterEach(() => {
    for (const prop of layoutProps) {
      if (originals[prop]) Object.defineProperty(HTMLElement.prototype, prop, originals[prop]);
    }
  });

  test('keeps keys inside the confirmation when a click focused the dialog itself', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<ChangeHistoryDrawer isOpen onClose={onClose} resource="apps" resourceId="chat" />);

    await user.click(await screen.findByText(/by ada/));
    await user.click(await screen.findByRole('button', { name: 'Rollback to this version' }));

    // A click on the message text focuses the dialog container (tabIndex -1),
    // not <body>, so the drawer underneath does not take Tab or Escape.
    const confirm = screen.getByRole('alertdialog', { name: 'Confirm Rollback' });
    expect(confirm).toHaveAttribute('tabindex', '-1');
    confirm.focus();
    expect(confirm).toHaveFocus();

    // Shift+Tab from the container wraps to the confirmation's last button.
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    const buttons = within(confirm).getAllByRole('button');
    expect(buttons.at(-1)).toHaveFocus();

    confirm.focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Change History' })).toBeInTheDocument();
  });
});
