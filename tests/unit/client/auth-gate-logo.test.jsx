// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs';
import path from 'node:path';

/**
 * The sign-in screen (the pre-React auth gate) shows the configured header logo
 * under the deployment's base path, and does not add the base path to a logo
 * URL that already holds it (`/ihub/ihub/…`).
 */

const GATE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../../client/src/auth-gate/auth-gate.js'),
  'utf8'
);

async function renderGate(logoUrl, basePath = '/ihub') {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      success: true,
      authenticated: false,
      authMode: 'local',
      authMethods: { local: { enabled: true } },
      gateUI: { appName: 'iHub', logoUrl }
    })
  }));
  window.history.replaceState({}, '', `${basePath}/`);
  document.body.innerHTML =
    '<div id="auth-gate-root"></div><div id="root" style="display:none"></div>';
  window.__AUTH_GATE_DEV_MODE__ = true;
  window.__BASE_PATH__ = basePath;
  global.__authGateI18n = { t: key => key };
  new Function(GATE_SOURCE)();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return document.querySelector('.ag-logo img')?.getAttribute('src');
}

afterEach(() => {
  delete global.fetch;
  window.history.replaceState({}, '', '/');
});

test.each([
  ['/uploads/assets/logo.png', '/ihub/uploads/assets/logo.png'],
  ['/ihub/uploads/assets/logo.png', '/ihub/uploads/assets/logo.png'],
  ['https://cdn.example.com/logo.png', 'https://cdn.example.com/logo.png'],
  [null, '/ihub/icons/apps-svg-logo.svg']
])('logo %s is shown from %s', async (logoUrl, expected) => {
  expect(await renderGate(logoUrl)).toBe(expected);
});

test('at the root the logo path is used as it is', async () => {
  expect(await renderGate('/uploads/assets/logo.png', '')).toBe('/uploads/assets/logo.png');
});
