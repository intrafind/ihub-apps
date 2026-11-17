// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { readFileSync } from 'fs';
import path from 'path';

import { getStoredPreference, resolveIsDark } from '../../../client/src/utils/themePreference';

/**
 * The light/dark decision exists twice: `resolveIsDark(getStoredPreference())` in
 * themePreference.js for the React app, and an inline copy in client/index.html (the
 * `<script data-theme-prepaint>` block) that runs before any stylesheet or bundle loads, so a
 * dark-mode user never sees a light first paint. If the two disagree, the page flips theme once
 * the app starts. This test runs the inline script against the same inputs as the module and
 * pins them together (like known-routes-sync.test.jsx does for the route lists).
 *
 * The inline script is read as source text and run with a stand-in `window` and `document`, so
 * every input (URL, frame, storage, OS theme) is under the test's control.
 */

const repoRoot = path.resolve(__dirname, '../../..');

function prepaintSource() {
  const html = readFileSync(path.join(repoRoot, 'client/index.html'), 'utf8');
  const match = html.match(/<script data-theme-prepaint>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('pre-paint theme script not found in client/index.html');
  return match[1];
}

/**
 * Run the inline script and report what it did to <html>.
 *
 * @param {Object} options
 * @param {string} [options.search] - The page's query string.
 * @param {boolean} [options.framed] - Whether the page runs in an iframe.
 * @param {boolean} [options.osDark] - What `prefers-color-scheme: dark` answers.
 * @returns {{ theme: string|null, darkClass: boolean }}
 */
function runPrepaint({ search = '', framed = false, osDark = false } = {}) {
  const attributes = {};
  const classes = new Set();
  const fakeDocument = {
    documentElement: {
      setAttribute: (name, value) => {
        attributes[name] = value;
      },
      classList: { add: name => classes.add(name) }
    }
  };
  const fakeWindow = {
    location: { search },
    matchMedia: query => ({ matches: query === '(prefers-color-scheme: dark)' && osDark })
  };
  fakeWindow.self = fakeWindow;
  fakeWindow.top = framed ? {} : fakeWindow;

  const run = new Function(
    'window',
    'document',
    'localStorage',
    'sessionStorage',
    'URLSearchParams',
    prepaintSource()
  );
  run(fakeWindow, fakeDocument, localStorage, sessionStorage, URLSearchParams);
  return { theme: attributes['data-theme'] ?? null, darkClass: classes.has('dark') };
}

/** Make the module's `prefers-color-scheme` check answer `osDark`. */
function setOsTheme(osDark) {
  window.matchMedia = query => ({
    matches: query === '(prefers-color-scheme: dark)' && osDark,
    addEventListener: () => {},
    removeEventListener: () => {}
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  delete window.matchMedia;
});

describe('pre-paint theme script in client/index.html', () => {
  const storedValues = [null, 'auto', 'light', 'dark', 'not-a-mode'];
  const cases = storedValues.flatMap(stored => [false, true].map(osDark => [stored, osDark]));

  test.each(cases)('stored %p with OS dark %p matches resolveIsDark', (stored, osDark) => {
    if (stored !== null) localStorage.setItem('ih-dark-mode', stored);
    setOsTheme(osDark);

    const expected = resolveIsDark(getStoredPreference());
    const result = runPrepaint({ osDark });

    expect(result.theme === 'dark').toBe(expected);
    expect(result.darkClass).toBe(expected);
  });

  test.each(['?embed=true', '?mode=light', '?embed=true&mode=light', '?mode=dark'])(
    'leaves %s to embedBootstrap',
    search => {
      localStorage.setItem('ih-dark-mode', 'dark');
      expect(runPrepaint({ search, osDark: true })).toEqual({ theme: null, darkClass: false });
    }
  );

  test('leaves a framed embed session to embedBootstrap', () => {
    localStorage.setItem('ih-dark-mode', 'dark');
    sessionStorage.setItem('ihubEmbedMode', '1');
    expect(runPrepaint({ framed: true })).toEqual({ theme: null, darkClass: false });
  });

  test('a stale embed flag in a top-level tab does not stop a direct visit', () => {
    // Matches isEmbedMode(): the stored flag only counts while the page is framed.
    localStorage.setItem('ih-dark-mode', 'dark');
    sessionStorage.setItem('ihubEmbedMode', '1');
    expect(runPrepaint({ framed: false })).toEqual({ theme: 'dark', darkClass: true });
  });

  test('a framed page that is not an embed still gets the saved theme', () => {
    localStorage.setItem('ih-dark-mode', 'dark');
    expect(runPrepaint({ framed: true })).toEqual({ theme: 'dark', darkClass: true });
  });
});
