/**
 * Regression tests for #1691: playwrightScreenshot and seleniumScreenshot must
 * validate the caller-supplied URL (protocol + SSRF guard) before ever
 * launching a browser, matching the guard webContentExtractor already has.
 *
 * The repo's source is native ESM (uses `import.meta.url`), so this file uses
 * `jest.unstable_mockModule` + dynamic imports rather than the CommonJS-only
 * `jest.mock` API. Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import os from 'os';

const page = {
  goto: jest.fn(async () => {}),
  pdf: jest.fn(async () => {}),
  screenshot: jest.fn(async () => {})
};
const browser = {
  newPage: jest.fn(async () => page),
  close: jest.fn(async () => {})
};
const chromiumLaunch = jest.fn(async () => browser);

jest.unstable_mockModule('playwright', () => ({
  chromium: { launch: chromiumLaunch }
}));

jest.unstable_mockModule('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) })
}));

const driver = {
  get: jest.fn(async () => {}),
  executeScript: jest.fn(async () => 0),
  manage: jest.fn(() => ({ window: () => ({ setRect: jest.fn(async () => {}) }) })),
  takeScreenshot: jest.fn(async () => Buffer.from('').toString('base64')),
  getDevToolsSession: jest.fn(async () => ({ send: jest.fn(async () => ({ data: '' })) })),
  quit: jest.fn(async () => {})
};
const seleniumBuild = jest.fn(async () => driver);
const chromeOptions = { addArguments: jest.fn() };

jest.unstable_mockModule('selenium-webdriver', () => ({
  Builder: jest.fn(() => ({
    forBrowser: jest.fn(() => ({
      setChromeOptions: jest.fn(() => ({ build: seleniumBuild }))
    }))
  }))
}));

jest.unstable_mockModule('selenium-webdriver/chrome.js', () => ({
  default: { Options: jest.fn(() => chromeOptions) }
}));

jest.unstable_mockModule('pdf-parse', () => ({
  default: jest.fn(async () => ({ text: '' }))
}));

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => os.tmpdir()
}));

const { default: playwrightScreenshot } = await import('../tools/playwrightScreenshot.js');
const { default: seleniumScreenshot } = await import('../tools/seleniumScreenshot.js');

describe.each([
  ['playwrightScreenshot', playwrightScreenshot, chromiumLaunch],
  ['seleniumScreenshot', seleniumScreenshot, seleniumBuild]
])('%s SSRF guard', (_name, tool, launchSpy) => {
  it('rejects a missing url', async () => {
    await expect(tool({})).rejects.toMatchObject({ code: 'MISSING_URL' });
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed url', async () => {
    await expect(tool({ url: 'not a url' })).rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) protocol', async () => {
    await expect(tool({ url: 'file:///etc/passwd' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROTOCOL'
    });
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('rejects a private IP literal (SSRF)', async () => {
    await expect(tool({ url: 'http://127.0.0.1/secret' })).rejects.toMatchObject({
      code: 'SSRF_BLOCKED'
    });
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('rejects the cloud metadata link-local address', async () => {
    await expect(tool({ url: 'http://169.254.169.254/latest/meta-data' })).rejects.toMatchObject({
      code: 'SSRF_BLOCKED'
    });
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('rejects localhost by hostname', async () => {
    await expect(tool({ url: 'http://localhost:8080/' })).rejects.toMatchObject({
      code: 'SSRF_BLOCKED'
    });
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('allows a public IP literal through to the browser launch', async () => {
    await expect(tool({ url: 'http://8.8.8.8/page' })).resolves.toBeDefined();
    expect(launchSpy).toHaveBeenCalled();
  });
});
