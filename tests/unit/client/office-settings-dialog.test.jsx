/**
 * Unit tests for the Outlook add-in settings dialog
 * (client/src/features/office/components/settings-dialog).
 *
 * Issue #2366: dark mode can be activated in Settings and is remembered
 * across restarts. The dialog must persist the chosen appearance on Save,
 * apply it without a reload, and discard an abandoned selection on Cancel.
 *
 * Issue #2446: the default answer action is a per-user override on the same
 * terms — persisted, applied without a reload, and only offered in Outlook.
 */

import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (_key, fallback) => fallback ?? _key })
}));
jest.mock('@heroicons/react/24/outline', () => ({
  __esModule: true,
  XMarkIcon: () => null
}));
// The real module reloads the window on a language change.
jest.mock('../../../client/src/features/office/utilities/officeLocale', () => ({
  __esModule: true,
  officeLocale: 'en',
  SUPPORTED_LANGUAGES: [
    { key: 'en', label: 'English' },
    { key: 'de', label: 'Deutsch' }
  ],
  setOfficeLocale: jest.fn()
}));

const SettingsDialog =
  require('../../../client/src/features/office/components/settings-dialog').default;
const { setOfficeLocale } = require('../../../client/src/features/office/utilities/officeLocale');
const {
  EmbeddedHostProvider
} = require('../../../client/src/features/office/contexts/EmbeddedHostContext');

const STORAGE_KEY = 'office_ihub_theme';
const MAIL_ACTION_STORAGE_KEY = 'office_ihub_mail_action';
const html = () => document.documentElement;
const user = { name: 'Ada Lovelace', email: 'ada@example.com' };

beforeEach(() => {
  localStorage.clear();
  html().removeAttribute('data-theme');
  html().classList.remove('dark');
  setOfficeLocale.mockClear();
});

test('renders nothing while closed', () => {
  const { container } = render(<SettingsDialog user={user} isOpen={false} onClose={jest.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

test('Save persists the selected appearance and applies it without a reload', () => {
  const onClose = jest.fn();
  render(<SettingsDialog user={user} isOpen onClose={onClose} />);

  const appearance = screen.getByLabelText('Appearance');
  expect(appearance).toHaveValue('light');

  fireEvent.change(appearance, { target: { value: 'dark' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  expect(html()).toHaveAttribute('data-theme', 'dark');
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(setOfficeLocale).not.toHaveBeenCalled();
});

test('Cancel discards the selection and the next open starts from the persisted value', () => {
  const onClose = jest.fn();
  const { rerender } = render(<SettingsDialog user={user} isOpen onClose={onClose} />);

  fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'dark' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  expect(html()).not.toHaveAttribute('data-theme');

  rerender(<SettingsDialog user={user} isOpen={false} onClose={onClose} />);
  rerender(<SettingsDialog user={user} isOpen onClose={onClose} />);
  expect(screen.getByLabelText('Appearance')).toHaveValue('light');
});

test('the dialog opens on the persisted appearance', () => {
  localStorage.setItem(STORAGE_KEY, 'auto');
  render(<SettingsDialog user={user} isOpen onClose={jest.fn()} />);
  expect(screen.getByLabelText('Appearance')).toHaveValue('auto');
});

test('saving a language change persists the appearance before the pane reloads', () => {
  const onClose = jest.fn();
  render(<SettingsDialog user={user} isOpen onClose={onClose} />);

  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'de' } });
  fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'auto' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(localStorage.getItem(STORAGE_KEY)).toBe('auto');
  expect(setOfficeLocale).toHaveBeenCalledWith('de');
  // The reload closes the dialog; onClose is only used on the no-reload path.
  expect(onClose).not.toHaveBeenCalled();
});

test('the automatic-mode hint names Outlook in the task pane and the system elsewhere', () => {
  const { unmount } = render(<SettingsDialog user={user} isOpen onClose={jest.fn()} />);
  expect(screen.getByText(/follows the Outlook theme/)).toBeInTheDocument();
  unmount();

  render(
    <EmbeddedHostProvider value={{ kind: 'extension' }}>
      <SettingsDialog user={user} isOpen onClose={jest.fn()} />
    </EmbeddedHostProvider>
  );
  expect(screen.getByText('Automatic follows the system setting.')).toBeInTheDocument();
});

test('Save persists the default answer action and announces it without a reload', () => {
  const onClose = jest.fn();
  const heard = jest.fn();
  document.addEventListener('ihub:mailactionchanged', heard);
  render(<SettingsDialog user={user} isOpen onClose={onClose} />);

  const answerAction = screen.getByLabelText('Default answer action');
  expect(answerAction).toHaveValue('auto');

  fireEvent.change(answerAction, { target: { value: 'forward' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(localStorage.getItem(MAIL_ACTION_STORAGE_KEY)).toBe('forward');
  // The open chat re-resolves its default off this event rather than a reload.
  expect(heard).toHaveBeenCalledTimes(1);
  document.removeEventListener('ihub:mailactionchanged', heard);
});

test('the dialog opens on the persisted answer action', () => {
  localStorage.setItem(MAIL_ACTION_STORAGE_KEY, 'answer');
  render(<SettingsDialog user={user} isOpen onClose={jest.fn()} />);
  expect(screen.getByLabelText('Default answer action')).toHaveValue('answer');
});

test('Cancel leaves the stored answer action alone', () => {
  render(<SettingsDialog user={user} isOpen onClose={jest.fn()} />);

  fireEvent.change(screen.getByLabelText('Default answer action'), {
    target: { value: 'forward' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(localStorage.getItem(MAIL_ACTION_STORAGE_KEY)).toBeNull();
});

test('the answer action is not offered outside Outlook — the side panel has no mail item', () => {
  render(
    <EmbeddedHostProvider value={{ kind: 'extension' }}>
      <SettingsDialog user={user} isOpen onClose={jest.fn()} />
    </EmbeddedHostProvider>
  );
  expect(screen.queryByLabelText('Default answer action')).not.toBeInTheDocument();
});
