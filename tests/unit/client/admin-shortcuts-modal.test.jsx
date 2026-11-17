// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `?` cheatsheet lists only shortcuts that work. `n` ("New item") has no caller: no admin page
 * passes `onNew` to useAdminKeyboardShortcuts, so the key does nothing and must not be advertised.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, fallback) => fallback ?? key, i18n: { language: 'en' } })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

import AdminShortcutsModal from '../../../client/src/features/admin/components/AdminShortcutsModal';

describe('AdminShortcutsModal', () => {
  it('does not list the dead "n" (new item) shortcut', () => {
    render(<AdminShortcutsModal isOpen onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(/new item/i)).not.toBeInTheDocument();
    const keys = screen.getAllByText((content, element) => element.tagName === 'KBD');
    expect(keys.map(kbd => kbd.textContent)).not.toContain('n');
  });

  it('still lists the shortcuts that work', () => {
    render(<AdminShortcutsModal isOpen onClose={() => {}} />);
    expect(screen.getByText('Open command palette')).toBeInTheDocument();
    expect(screen.getByText('Toggle this cheatsheet')).toBeInTheDocument();
  });
});
