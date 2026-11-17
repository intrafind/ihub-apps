// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Backup & Restore (PL-B1, PL-B7, PL-B2):
 *   - choosing a ZIP does not upload it; a type-to-confirm dialog names the
 *     file, its size and the pre-import copy, and only the confirm button sends
 *     POST /admin/backup/_import;
 *   - the picker is one keyboard-operable button (no invisible input in the tab order);
 *   - the page warns that the export holds the keys.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
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

const AdminBackupPage = require('../../../client/src/features/admin/pages/AdminBackupPage').default;

const importCalls = () =>
  mockMakeAdminApiCall.mock.calls.filter(([url]) => url === '/admin/backup/_import');

function chooseFile(name = 'ihub-config-backup.zip', size = 2048) {
  const input = document.querySelector('input[type="file"]');
  const file = new File(['x'.repeat(size)], name, { type: 'application/zip' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockResolvedValue({
    data: { importedFiles: 12, backupPath: 'contents/.backups/backup-1' }
  });
});

describe('Backup import', () => {
  it('uses one labelled button for the picker; the file input is out of the tab order', () => {
    render(<AdminBackupPage />);
    const button = screen.getByRole('button', { name: 'Import Configuration' });
    const input = document.querySelector('input[type="file"]');
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input).toHaveAttribute('accept', expect.stringContaining('.zip'));
    const click = jest.spyOn(input, 'click');
    fireEvent.click(button);
    expect(click).toHaveBeenCalled();
  });

  it('choosing a ZIP opens a type-to-confirm dialog and sends no import request', () => {
    render(<AdminBackupPage />);
    chooseFile('prod-backup.zip', 2048);

    const dialog = screen.getByRole('alertdialog', {
      name: 'Replace all contents with "prod-backup.zip"?'
    });
    expect(dialog).toHaveTextContent('File: prod-backup.zip (2.0 KB)');
    expect(dialog).toHaveTextContent(
      'Current contents are kept as a pre-import copy in contents/.backups (the last 3 are kept).'
    );
    expect(within(dialog).getByText(window.location.host).tagName).toBe('CODE');
    expect(importCalls()).toHaveLength(0);
  });

  it('Cancel and Escape import nothing', () => {
    render(<AdminBackupPage />);
    chooseFile();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    chooseFile();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(importCalls()).toHaveLength(0);
  });

  it('imports only after the host name was typed', async () => {
    render(<AdminBackupPage />);
    const file = chooseFile();
    const dialog = screen.getByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Import and replace' });

    fireEvent.click(confirm);
    expect(importCalls()).toHaveLength(0);

    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'wrong-host' } });
    fireEvent.click(confirm);
    expect(importCalls()).toHaveLength(0);

    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: window.location.host }
    });
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(importCalls()).toHaveLength(1);
    const [, options] = importCalls()[0];
    expect(options.method).toBe('POST');
    expect(options.body.get('backup')).toBe(file);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText(/12 files imported/)).toBeInTheDocument();
  });

  it('keeps the dialog open with the server error when the import fails', async () => {
    mockMakeAdminApiCall.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: { data: { code: 'IMPORT_FAILED', detail: 'Nothing was changed.' } }
      })
    );
    render(<AdminBackupPage />);
    chooseFile();
    const dialog = screen.getByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: window.location.host }
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Import and replace' }));
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Nothing was changed.');
  });

  it('rejects a non-ZIP file without opening the dialog', () => {
    render(<AdminBackupPage />);
    chooseFile('notes.txt');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('Please select a ZIP file')).toBeInTheDocument();
  });
});

test('the page says the export must be stored like a key (PL-B2)', () => {
  render(<AdminBackupPage />);
  const callout = screen.getByTestId('backup-sensitivity-callout');
  expect(callout).toHaveTextContent('Store the export like a key');
  expect(callout).toHaveTextContent(/encryption key/);
  expect(callout).toHaveTextContent(/JWT signing keys/);
  expect(callout).toHaveTextContent(/password hashes/);
});
