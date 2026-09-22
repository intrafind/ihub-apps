/**
 * Unit tests for client/src/features/office/utilities/officeTheme.js
 *
 * Dark mode for the Outlook add-in (issue #2366): the appearance chosen in
 * Settings must be persisted so it survives an Outlook restart, be applied as
 * `data-theme="dark"` on <html> (what the shared Tailwind `dark:` variant keys
 * off), and in "auto" mode follow the Outlook theme before the OS setting.
 */

import '@testing-library/jest-dom';

const MODULE_PATH = '../../../client/src/features/office/utilities/officeTheme';
const STORAGE_KEY = 'office_ihub_theme';

/** Fresh module instance per test — the module tracks bound listeners. */
function loadModule() {
  let mod;
  jest.isolateModules(() => {
    mod = require(MODULE_PATH);
  });
  return mod;
}

function mockMatchMedia({ matches }) {
  const listeners = new Set();
  const mediaQuery = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: jest.fn((_type, fn) => listeners.add(fn)),
    removeEventListener: jest.fn((_type, fn) => listeners.delete(fn))
  };
  window.matchMedia = jest.fn(() => mediaQuery);
  return {
    mediaQuery,
    setMatches(next) {
      mediaQuery.matches = next;
      listeners.forEach(fn => fn({ matches: next }));
    }
  };
}

/** Minimal Office.js surface: theme colours + the OfficeThemeChanged registration. */
function mockOffice({ bodyBackgroundColor }) {
  const handlers = [];
  global.Office = {
    context: {
      officeTheme: { bodyBackgroundColor },
      mailbox: { addHandlerAsync: jest.fn((_type, fn) => handlers.push(fn)) }
    },
    EventType: { OfficeThemeChanged: 'officeThemeChanged' }
  };
  return {
    changeTheme(nextBodyBackgroundColor) {
      global.Office.context.officeTheme.bodyBackgroundColor = nextBodyBackgroundColor;
      handlers.forEach(fn => fn({ type: 'officeThemeChanged' }));
    }
  };
}

const html = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  html().removeAttribute('data-theme');
  html().classList.remove('dark');
  delete window.matchMedia;
  delete global.Office;
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('defaults to light when nothing is stored', () => {
  const { getStoredThemePreference, initOfficeTheme } = loadModule();
  expect(getStoredThemePreference()).toBe('light');
  initOfficeTheme();
  expect(html()).not.toHaveAttribute('data-theme');
  expect(html().classList.contains('dark')).toBe(false);
});

test('ignores an unknown stored value', () => {
  localStorage.setItem(STORAGE_KEY, 'sepia');
  const { getStoredThemePreference } = loadModule();
  expect(getStoredThemePreference()).toBe('light');
});

test('setThemePreference persists the choice and applies it immediately', () => {
  const { setThemePreference } = loadModule();

  expect(setThemePreference('dark')).toBe(true);
  expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  expect(html()).toHaveAttribute('data-theme', 'dark');
  expect(html().classList.contains('dark')).toBe(true);

  expect(setThemePreference('light')).toBe(true);
  expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  expect(html()).not.toHaveAttribute('data-theme');
  expect(html().classList.contains('dark')).toBe(false);
});

test('rejects an unknown preference without touching storage or the document', () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const { setThemePreference } = loadModule();
  expect(setThemePreference('blue')).toBe(false);
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  expect(html()).not.toHaveAttribute('data-theme');
});

test('a saved dark preference is re-applied on the next start (survives a restart)', () => {
  // First session: the user turns dark mode on in Settings.
  loadModule().setThemePreference('dark');
  html().removeAttribute('data-theme'); // Outlook restarts: fresh document …

  // … fresh JS module, same localStorage.
  const { initOfficeTheme } = loadModule();
  initOfficeTheme();
  expect(html()).toHaveAttribute('data-theme', 'dark');
});

test('auto follows the OS setting when the host exposes no Office theme', () => {
  const media = mockMatchMedia({ matches: true });
  const { setThemePreference, initOfficeTheme } = loadModule();
  setThemePreference('auto');
  initOfficeTheme();
  expect(html()).toHaveAttribute('data-theme', 'dark');

  // The OS switches to light while the pane is open.
  media.setMatches(false);
  expect(html()).not.toHaveAttribute('data-theme');

  media.setMatches(true);
  expect(html()).toHaveAttribute('data-theme', 'dark');
});

test('auto prefers the Outlook theme over the OS setting and follows theme changes', () => {
  // OS says light, Outlook is in dark mode (Mailbox 1.14+ theme API).
  mockMatchMedia({ matches: false });
  const office = mockOffice({ bodyBackgroundColor: '#1F1F1F' });
  const { setThemePreference, initOfficeTheme } = loadModule();

  setThemePreference('auto');
  initOfficeTheme();
  expect(html()).toHaveAttribute('data-theme', 'dark');
  expect(global.Office.context.mailbox.addHandlerAsync).toHaveBeenCalledWith(
    'officeThemeChanged',
    expect.any(Function)
  );

  // The user switches Outlook back to a light theme.
  office.changeTheme('#FFFFFF');
  expect(html()).not.toHaveAttribute('data-theme');
});

test('an explicit choice is not overridden by OS or Outlook theme changes', () => {
  const media = mockMatchMedia({ matches: false });
  const office = mockOffice({ bodyBackgroundColor: '#FFFFFF' });
  const { setThemePreference, initOfficeTheme } = loadModule();

  setThemePreference('light');
  initOfficeTheme();
  media.setMatches(true);
  office.changeTheme('#1F1F1F');
  expect(html()).not.toHaveAttribute('data-theme');
});

test('initOfficeTheme registers each listener only once', () => {
  const media = mockMatchMedia({ matches: false });
  mockOffice({ bodyBackgroundColor: '#FFFFFF' });
  const { initOfficeTheme } = loadModule();

  initOfficeTheme(); // module evaluation (before Office.onReady)
  initOfficeTheme(); // inside Office.onReady
  expect(media.mediaQuery.addEventListener).toHaveBeenCalledTimes(1);
  expect(global.Office.context.mailbox.addHandlerAsync).toHaveBeenCalledTimes(1);
});

test('isDarkHexColor classifies Office theme colours and rejects garbage', () => {
  const { isDarkHexColor } = loadModule();
  expect(isDarkHexColor('#1F1F1F')).toBe(true); // Outlook "Black"
  expect(isDarkHexColor('3B3B3B')).toBe(true); // "Dark Gray" without the hash
  expect(isDarkHexColor('#FFFFFF')).toBe(false);
  expect(isDarkHexColor('#F3F2F1')).toBe(false); // Outlook "Colorful" body
  expect(isDarkHexColor('not-a-colour')).toBeNull();
  expect(isDarkHexColor(undefined)).toBeNull();
});
