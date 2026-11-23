// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The shared save bar: it exists only while there is something to save, says "Save Changes"
 * unless the page names its action (a new resource says "Create"), and offers Discard.
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}));

const AdminSaveBar = require('../../../client/src/features/admin/components/AdminSaveBar').default;

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

describe('AdminSaveBar', () => {
  test('is not there without changes', () => {
    render(<AdminSaveBar dirty={false} saving={false} onSave={() => {}} onDiscard={() => {}} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  test('appears with changes; Save and Discard call their handlers', () => {
    const onSave = jest.fn();
    const onDiscard = jest.fn();
    render(<AdminSaveBar dirty saving={false} onSave={onSave} onDiscard={onDiscard} />);

    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  test('a page can name the action: Create for a new resource', () => {
    render(
      <AdminSaveBar
        dirty
        saving={false}
        saveLabel="Create"
        onSave={() => {}}
        onDiscard={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
  });

  test('stays while a save runs, and shows Saving instead of the label', () => {
    render(
      <AdminSaveBar
        dirty={false}
        saving
        saveLabel="Create"
        onSave={() => {}}
        onDiscard={() => {}}
      />
    );
    expect(screen.getAllByText('Saving…').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });
});
