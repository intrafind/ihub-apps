// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The summary an admin confirms before an update is installed (#2971):
 * a downgrade needs a tick, an unsigned archive the typed version, and a
 * rejected archive offers no install at all.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, fallback, params) =>
      String(typeof fallback === 'string' ? fallback : key).replace(
        /\{\{(\w+)\}\}/g,
        (_, name) => params?.[name] ?? ''
      )
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

import StagedUpdatePanel from '../../../client/src/features/admin/components/updates/StagedUpdatePanel';

const base = {
  accepted: true,
  version: '5.7.0',
  currentVersion: '5.8.0',
  comparison: 'downgrade',
  platform: 'linux',
  arch: 'x64',
  source: 'upload',
  fileName: 'ihub-apps-v5.7.0-linux.tar.gz',
  archiveSha256: 'a'.repeat(64),
  archiveSize: 150 * 1024 * 1024,
  signature: { status: 'missing', via: null },
  checksum: 'missing',
  trusted: false,
  applyMode: 'swap-on-start',
  requiresConfirmation: { downgrade: true, unsigned: true },
  warnings: [{ code: 'downgrade', message: 'Version 5.7.0 is older than the running 5.8.0' }],
  problems: [],
  stagedAt: '2026-10-29T00:00:00Z'
};

describe('StagedUpdatePanel', () => {
  it('installs only after the downgrade is ticked and the version typed', () => {
    const onApply = jest.fn();
    render(
      <StagedUpdatePanel summary={base} busy={false} onApply={onApply} onDiscard={jest.fn()} />
    );
    const install = screen.getByRole('button', { name: /install and restart/i });
    expect(install).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(install).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '5.7' } });
    expect(install).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '5.7.0' } });
    expect(install).toBeEnabled();

    fireEvent.click(install);
    expect(onApply).toHaveBeenCalledWith({ confirmDowngrade: true, confirmUnsigned: '5.7.0' });
  });

  it('installs a signed upgrade without extra confirmation', () => {
    const onApply = jest.fn();
    render(
      <StagedUpdatePanel
        summary={{
          ...base,
          comparison: 'upgrade',
          currentVersion: '5.6.0',
          trusted: true,
          signature: { status: 'valid', via: 'manifest', keyId: 'abcd' },
          requiresConfirmation: { downgrade: false, unsigned: false },
          warnings: []
        }}
        busy={false}
        onApply={onApply}
        onDiscard={jest.fn()}
      />
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /install and restart/i }));
    expect(onApply).toHaveBeenCalledWith({ confirmDowngrade: false, confirmUnsigned: undefined });
  });

  it('shows why a rejected archive cannot be installed and offers no install', () => {
    const onDiscard = jest.fn();
    render(
      <StagedUpdatePanel
        summary={{
          ...base,
          accepted: false,
          problems: [
            {
              code: 'wrong-platform',
              message: 'The archive is for windows, this server runs on linux',
              params: { archive: 'windows', server: 'linux' }
            }
          ]
        }}
        busy={false}
        onApply={jest.fn()}
        onDiscard={onDiscard}
      />
    );
    expect(screen.getByText(/cannot be installed/i)).toBeInTheDocument();
    expect(screen.getByText(/The archive is for windows/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install and restart/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onDiscard).toHaveBeenCalled();
  });
});
