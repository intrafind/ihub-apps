/**
 * Regression test for #1799: runUpdateCLI's catch block used `catch (error)`,
 * which shadowed the module-scoped `error(msg)` logger, so any real failure
 * crashed with "TypeError: error is not a function" instead of printing the
 * actual failure message.
 *
 * Note: The repo's source is native ESM (uses `import.meta.url`), so this
 * file uses `jest.unstable_mockModule` + dynamic imports rather than the
 * CommonJS-only `jest.mock` API. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';

const failure = new Error('network error contacting GitHub');

jest.unstable_mockModule('../services/updateService.js', () => ({
  checkForUpdate: jest.fn(async () => {
    throw failure;
  }),
  downloadUpdate: jest.fn(),
  applyUpdate: jest.fn(),
  rollback: jest.fn(),
  getUpdateStatus: jest.fn(),
  isBinaryInstallation: () => true,
  isContainerInstallation: () => false,
  checkDiskSpace: jest.fn(),
  checkWritePermissions: jest.fn()
}));

const { runUpdateCLI } = await import('../cli/update.js');

describe('runUpdateCLI error handling', () => {
  it('logs the real failure message instead of crashing on a shadowed error() helper', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await runUpdateCLI('check');

    const loggedMessages = errorSpy.mock.calls.map(call => call.join(' '));
    expect(loggedMessages.some(msg => msg.includes(failure.message))).toBe(true);
    expect(loggedMessages.some(msg => msg.includes('is not a function'))).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});
