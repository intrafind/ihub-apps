// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * When the Updates page counts the server as back after an update or a
 * rollback — including a rollback to a version from before the boot id.
 */
import { isRestartedServer } from '../../../client/src/features/admin/components/updates/restartDetection';

const before = { bootId: 'boot-1', version: '5.8.0' };

describe('isRestartedServer', () => {
  it('waits while the old process still answers or a swap is pending', () => {
    expect(isRestartedServer({ bootId: 'boot-1', currentVersion: '5.8.0' }, before, false)).toBe(
      false
    );
    expect(
      isRestartedServer(
        { bootId: 'boot-2', currentVersion: '5.9.0', pendingRestart: true },
        before,
        true
      )
    ).toBe(false);
    expect(isRestartedServer(null, before, true)).toBe(false);
  });

  it('accepts a new boot id', () => {
    expect(isRestartedServer({ bootId: 'boot-2', currentVersion: '5.8.0' }, before, false)).toBe(
      true
    );
  });

  it('accepts a server without boot id once it was down or reports another version', () => {
    const preBootId = { currentVersion: '5.7.0' };
    expect(isRestartedServer({ currentVersion: '5.8.0' }, before, false)).toBe(false);
    expect(isRestartedServer({ currentVersion: '5.8.0' }, before, true)).toBe(true);
    expect(isRestartedServer(preBootId, before, false)).toBe(true);
  });
});
