/**
 * Embed mode: an embedding host (iFinder, Nextcloud, …) steers iHub's chrome, theme and language
 * with URL parameters — `embed`, `mode`, `header`, `footer`, `sidebar`, `language` — and none of it
 * may reach `localStorage`, which a same-site iframe shares with people who open iHub directly.
 *
 * These tests pin the parameter whitelists and the no-persist guarantee, including the
 * acceptance URL from the issue.
 */

import fs from 'node:fs';
import path from 'node:path';
import { renderHook, act } from '@testing-library/react';

import {
  EMBED_MODE_KEY,
  activateEmbedMode,
  activateEmbedModeFromUrl,
  getSessionValue,
  isEmbedMode,
  removeSessionValue,
  resetEmbedSession,
  setSessionValue
} from '../../../client/src/utils/embedMode';
import {
  SUPPORTED_LANGUAGES,
  parseLanguageParam
} from '../../../client/src/utils/supportedLanguages';
import {
  applyThemeToDocument,
  getStoredPreference,
  parseModeParam,
  storePreference
} from '../../../client/src/utils/themePreference';
import { bootstrapFromUrl } from '../../../client/src/utils/embedBootstrap';
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  updateSettingsFromUrl
} from '../../../client/src/utils/integrationSettings';
import useDarkMode from '../../../client/src/hooks/useDarkMode';

jest.mock('../../../client/src/api', () => ({
  fetchTranslations: jest.fn(() => Promise.resolve({})),
  fetchUIConfig: jest.fn(() => Promise.resolve({}))
}));

const ACCEPTANCE_QUERY = 'embed=true&sidebar=false&header=false&footer=false&mode=dark&language=de';

// What a direct-visit user of iHub has saved in this browser.
const DIRECT_VISIT_SETTINGS = {
  showHeader: true,
  showFooter: true,
  showSidebar: true,
  language: null
};

function seedDirectVisitPreferences() {
  localStorage.setItem('ih-dark-mode', 'light');
  localStorage.setItem('i18nextLng', 'en');
  localStorage.setItem('ihubIntegrationSettings', JSON.stringify(DIRECT_VISIT_SETTINGS));
}

function localStorageSnapshot() {
  return Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]));
}

/**
 * Record every localStorage read, write and removal while still performing it. `sessionStorage`
 * shares the Storage prototype, so the spies tell the two apart by the receiver. With
 * `blockSessionStorage` every sessionStorage access throws, as when a browser blocks it.
 */
function trackLocalStorage({ blockSessionStorage = false } = {}) {
  const calls = [];
  const spies = ['getItem', 'setItem', 'removeItem'].map(method => {
    const original = Storage.prototype[method];
    return jest.spyOn(Storage.prototype, method).mockImplementation(function (...args) {
      if (this === window.localStorage) calls.push([method, args[0]]);
      if (blockSessionStorage && this === window.sessionStorage) {
        throw new DOMException('blocked', 'SecurityError');
      }
      return original.apply(this, args);
    });
  });
  return {
    calls,
    stop: () => spies.forEach(spy => spy.mockRestore())
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
  applyThemeToDocument(false);
  // Drop what the in-memory fallback may have kept from a test with blocked storage.
  resetEmbedSession();
  removeSessionValue(EMBED_MODE_KEY);
});

describe('parameter whitelists', () => {
  test('mode accepts light, dark and auto, in any case', () => {
    expect(parseModeParam('light')).toBe('light');
    expect(parseModeParam('dark')).toBe('dark');
    expect(parseModeParam('auto')).toBe('auto');
    expect(parseModeParam(' Dark ')).toBe('dark');
  });

  test.each([null, undefined, '', 'blue', 'dark;drop', 'system', '<script>'])(
    'mode ignores %p',
    value => {
      expect(parseModeParam(value)).toBeNull();
    }
  );

  test('language accepts the supported languages, with a region variant selecting its base', () => {
    expect(parseLanguageParam('de')).toBe('de');
    expect(parseLanguageParam('EN')).toBe('en');
    expect(parseLanguageParam(' de-DE ')).toBe('de');
  });

  test.each([null, undefined, '', 'fr', 'xx', 'de_DE', 'deutsch', '../../etc/passwd', 'de,en'])(
    'language ignores %p',
    value => {
      expect(parseLanguageParam(value)).toBeNull();
    }
  );

  test('the supported languages are the built-in locale files', () => {
    const localesDir = path.resolve(__dirname, '../../../shared/i18n');
    const shipped = fs
      .readdirSync(localesDir)
      .filter(file => file.endsWith('.json'))
      .map(file => path.basename(file, '.json'))
      .sort();
    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(shipped);
  });
});

describe('activating embed mode', () => {
  test('only embed=true switches it on', () => {
    expect(activateEmbedModeFromUrl('')).toBe(false);
    expect(activateEmbedModeFromUrl('embed=false')).toBe(false);
    expect(activateEmbedModeFromUrl('embed=1')).toBe(false);
    expect(activateEmbedModeFromUrl('embed=')).toBe(false);
    expect(isEmbedMode()).toBe(false);

    expect(activateEmbedModeFromUrl(new URLSearchParams('embed=true'))).toBe(true);
    expect(isEmbedMode()).toBe(true);
  });

  test('an embed page that carries data-ihub-embed is an embed without any parameter', () => {
    document.documentElement.setAttribute('data-ihub-embed', 'true');
    try {
      expect(isEmbedMode()).toBe(false);
      bootstrapFromUrl('');
      expect(isEmbedMode()).toBe(true);
    } finally {
      document.documentElement.removeAttribute('data-ihub-embed');
    }
  });

  test('the attribute keeps the session of the frame, the URL parameter restarts it', () => {
    document.documentElement.setAttribute('data-ihub-embed', 'true');
    try {
      bootstrapFromUrl('mode=dark');
      expect(getSessionValue('ih-dark-mode')).toBe('dark');
      // Another load of the same page: the session is kept.
      bootstrapFromUrl('');
      expect(getSessionValue('ih-dark-mode')).toBe('dark');
    } finally {
      document.documentElement.removeAttribute('data-ihub-embed');
    }
  });

  test('the flag stays after the in-app router drops the query string', () => {
    bootstrapFromUrl('embed=true');
    bootstrapFromUrl('');
    expect(isEmbedMode()).toBe(true);
  });

  test('loading an embed URL starts a fresh session, other URLs keep it', () => {
    bootstrapFromUrl('embed=true&header=true&mode=dark&language=de');
    expect(getSessionValue('ih-dark-mode')).toBe('dark');
    expect(getSessionValue('i18nextLng')).toBe('de');

    // A reload of an in-app URL keeps the session.
    bootstrapFromUrl('');
    expect(getSessionValue('ih-dark-mode')).toBe('dark');

    // The host loads the frame again with other parameters: nothing is left over.
    bootstrapFromUrl('embed=true');
    expect(getSessionValue('ih-dark-mode')).toBeNull();
    expect(getSessionValue('i18nextLng')).toBeNull();
    expect(getSessionValue('ihubIntegrationSettings')).toBeNull();
    expect(getIntegrationSettings()).toEqual({
      showHeader: false,
      showFooter: false,
      showSidebar: false,
      language: null
    });
  });

  test('keeps working when sessionStorage is blocked, without touching localStorage', () => {
    const tracker = trackLocalStorage({ blockSessionStorage: true });

    activateEmbedMode();
    expect(isEmbedMode()).toBe(true);
    saveIntegrationSettings({
      showHeader: true,
      showFooter: false,
      showSidebar: false,
      language: 'de'
    });
    expect(getIntegrationSettings()).toEqual({
      showHeader: true,
      showFooter: false,
      showSidebar: false,
      language: 'de'
    });
    storePreference('dark');
    expect(getStoredPreference()).toBe('dark');
    tracker.stop();

    expect(tracker.calls).toEqual([]);
  });
});

describe('integration settings in embed mode', () => {
  test('start without iHub chrome, and the host opts in per part', () => {
    bootstrapFromUrl('embed=true');
    expect(getIntegrationSettings()).toEqual({
      showHeader: false,
      showFooter: false,
      showSidebar: false,
      language: null
    });

    const settings = updateSettingsFromUrl(new URLSearchParams('header=true&sidebar=true'));
    expect(settings).toMatchObject({ showHeader: true, showFooter: false, showSidebar: true });
  });

  test('survive in-app navigation in the tab, and stay out of localStorage', () => {
    bootstrapFromUrl('embed=true');
    const tracker = trackLocalStorage();

    updateSettingsFromUrl(new URLSearchParams('header=true&footer=true&language=de'));
    // The next route has no query string.
    const afterNavigation = updateSettingsFromUrl(new URLSearchParams(''));
    tracker.stop();

    expect(afterNavigation).toMatchObject({ showHeader: true, showFooter: true, language: 'de' });
    expect(tracker.calls).toEqual([]);
    expect(localStorage.getItem('ihubIntegrationSettings')).toBeNull();
  });

  test('ignore an unsupported language and keep the current one', () => {
    bootstrapFromUrl('embed=true');
    updateSettingsFromUrl(new URLSearchParams('language=de'));
    const settings = updateSettingsFromUrl(new URLSearchParams('language=xx'));
    expect(settings.language).toBe('de');
  });

  test('never read stale localStorage settings of a direct visit', () => {
    seedDirectVisitPreferences();
    bootstrapFromUrl('embed=true');
    expect(getIntegrationSettings()).toMatchObject({
      showHeader: false,
      showFooter: false,
      showSidebar: false
    });
  });

  test('a corrupted session value falls back to the embed defaults', () => {
    bootstrapFromUrl('embed=true');
    setSessionValue('ihubIntegrationSettings', '{not json');
    expect(getIntegrationSettings()).toEqual({
      showHeader: false,
      showFooter: false,
      showSidebar: false,
      language: null
    });

    setSessionValue(
      'ihubIntegrationSettings',
      JSON.stringify({ showHeader: 'yes', showFooter: true, language: 'xx', extra: 1 })
    );
    expect(getIntegrationSettings()).toEqual({
      showHeader: false,
      showFooter: true,
      showSidebar: false,
      language: null
    });
  });
});

describe('outside embed mode', () => {
  test('an unsupported language is ignored there too', () => {
    const settings = updateSettingsFromUrl(new URLSearchParams('language=xx'));
    expect(settings.language).toBeNull();
    expect(localStorage.getItem('ihubIntegrationSettings')).toBeNull();
  });

  test('header, footer, sidebar and language are remembered in localStorage as before', () => {
    updateSettingsFromUrl(
      new URLSearchParams('header=false&footer=false&sidebar=false&language=de')
    );
    expect(JSON.parse(localStorage.getItem('ihubIntegrationSettings'))).toEqual({
      showHeader: false,
      showFooter: false,
      showSidebar: false,
      language: 'de'
    });
    expect(sessionStorage.length).toBe(0);
  });

  test('mode is stored like a click on the dark-mode toggle', () => {
    bootstrapFromUrl('mode=dark');
    expect(localStorage.getItem('ih-dark-mode')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(isEmbedMode()).toBe(false);
  });

  test('an invalid mode changes nothing', () => {
    localStorage.setItem('ih-dark-mode', 'light');
    bootstrapFromUrl('mode=blue');
    expect(localStorage.getItem('ih-dark-mode')).toBe('light');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  test('embed-mode language seeding does not happen', () => {
    bootstrapFromUrl('language=de');
    expect(getSessionValue('i18nextLng')).toBeNull();
  });
});

describe('dark mode in embed mode', () => {
  test('mode applies before the first render and is not read from localStorage', () => {
    localStorage.setItem('ih-dark-mode', 'light');
    bootstrapFromUrl('embed=true&mode=dark');

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(getStoredPreference()).toBe('dark');
  });

  test('without mode, an embed follows the system and ignores the direct visit choice', () => {
    localStorage.setItem('ih-dark-mode', 'dark');
    bootstrapFromUrl('embed=true');
    expect(getStoredPreference()).toBe('auto');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  test('the toggle changes the tab only', () => {
    localStorage.setItem('ih-dark-mode', 'light');
    bootstrapFromUrl('embed=true&mode=dark');
    const tracker = trackLocalStorage();

    const { result } = renderHook(() => useDarkMode());
    expect(result.current.preference).toBe('dark');
    expect(result.current.isDark).toBe(true);

    act(() => result.current.enableLight());
    tracker.stop();

    expect(result.current.preference).toBe('light');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(getSessionValue('ih-dark-mode')).toBe('light');
    expect(tracker.calls).toEqual([]);
    expect(localStorage.getItem('ih-dark-mode')).toBe('light');
  });

  test('outside embed mode the toggle still persists to localStorage', () => {
    const { result } = renderHook(() => useDarkMode());
    act(() => result.current.enableDark());
    expect(localStorage.getItem('ih-dark-mode')).toBe('dark');
    expect(sessionStorage.getItem('ih-dark-mode')).toBeNull();
  });

  test('storePreference writes where getStoredPreference reads', () => {
    storePreference('dark');
    expect(getStoredPreference()).toBe('dark');
    expect(localStorage.getItem('ih-dark-mode')).toBe('dark');

    activateEmbedMode();
    expect(getStoredPreference()).toBe('auto');
    storePreference('light');
    expect(getStoredPreference()).toBe('light');
    expect(localStorage.getItem('ih-dark-mode')).toBe('dark');
  });
});

describe('the acceptance URL', () => {
  test('renders without chrome, dark and German, and leaves the direct-visit settings alone', () => {
    seedDirectVisitPreferences();
    const before = localStorageSnapshot();
    const tracker = trackLocalStorage();

    // index.jsx: the bootstrap runs first, then Layout applies the URL on every render.
    bootstrapFromUrl(ACCEPTANCE_QUERY);
    const settings = updateSettingsFromUrl(new URLSearchParams(ACCEPTANCE_QUERY));
    saveIntegrationSettings(settings); // Layout's effect
    const { result } = renderHook(() => useDarkMode());
    act(() => result.current.toggleMode());
    act(() => result.current.toggleMode());

    tracker.stop();

    expect(settings).toEqual({
      showHeader: false,
      showFooter: false,
      showSidebar: false,
      language: 'de'
    });
    expect(getSessionValue('i18nextLng')).toBe('de');
    expect(tracker.calls).toEqual([]);
    expect(localStorageSnapshot()).toEqual(before);

    // The same frame after an in-app navigation (no query string).
    expect(updateSettingsFromUrl(new URLSearchParams(''))).toEqual(settings);

    // The user opens iHub directly in another tab: a fresh sessionStorage, the same localStorage.
    sessionStorage.clear();
    expect(isEmbedMode()).toBe(false);
    expect(getIntegrationSettings()).toEqual(DIRECT_VISIT_SETTINGS);
    expect(getStoredPreference()).toBe('light');
    expect(localStorage.getItem('i18nextLng')).toBe('en');
  });

  test('ignores invalid values and applies the valid ones', () => {
    const query = 'embed=true&mode=blue&language=xx&header=true';
    bootstrapFromUrl(query);
    const settings = updateSettingsFromUrl(new URLSearchParams(query));

    expect(settings).toEqual({
      showHeader: true,
      showFooter: false,
      showSidebar: false,
      language: null
    });
    expect(getStoredPreference()).toBe('auto');
    expect(getSessionValue('i18nextLng')).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('i18nService language handling', () => {
  // i18next and its language detector are singletons that read their storage when the service is
  // imported, so each test loads a fresh copy.
  let broadcastChannels;

  class FakeBroadcastChannel {
    constructor() {
      this.posted = [];
      broadcastChannels.push(this);
    }
    addEventListener() {}
    postMessage(message) {
      this.posted.push(message);
    }
  }

  function loadI18nService() {
    jest.resetModules();
    return require('../../../client/src/services/i18nService');
  }

  beforeEach(() => {
    broadcastChannels = [];
    global.BroadcastChannel = FakeBroadcastChannel;
  });

  afterEach(() => {
    delete global.BroadcastChannel;
  });

  test('outside embed mode the language comes from and goes to localStorage', async () => {
    localStorage.setItem('i18nextLng', 'de');
    const { default: service, i18n } = loadI18nService();
    expect(i18n.language).toBe('de');

    await service.changeLanguage('en');
    expect(localStorage.getItem('i18nextLng')).toBe('en');
    expect(sessionStorage.getItem('i18nextLng')).toBeNull();
  });

  test('in embed mode the language comes from and goes to the tab only', async () => {
    seedDirectVisitPreferences(); // localStorage i18nextLng = en
    bootstrapFromUrl('embed=true&language=de');
    const tracker = trackLocalStorage();

    const { default: service, i18n } = loadI18nService();
    expect(i18n.language).toBe('de');

    await service.changeLanguage('en');
    tracker.stop();

    expect(sessionStorage.getItem('i18nextLng')).toBe('en');
    expect(tracker.calls).toEqual([]);
    expect(localStorage.getItem('i18nextLng')).toBe('en');
  });

  test('the service sets up embed mode from the URL by itself', async () => {
    // A production bundle runs the entry chunk's own code after the chunks it imports, so the
    // service cannot count on anything having run before it: loading it must be enough.
    seedDirectVisitPreferences(); // localStorage i18nextLng = en
    window.history.pushState({}, '', '/apps/translator?embed=true&language=de');
    const tracker = trackLocalStorage();
    try {
      const { default: service, i18n } = loadI18nService();
      expect(isEmbedMode()).toBe(true);
      expect(i18n.language).toBe('de');

      await service.changeLanguage('en');
      tracker.stop();

      expect(sessionStorage.getItem('i18nextLng')).toBe('en');
      expect(tracker.calls).toEqual([]);
      expect(localStorage.getItem('i18nextLng')).toBe('en');
    } finally {
      tracker.stop();
      window.history.pushState({}, '', '/');
    }
  });

  test('in embed mode a language change is not published to other tabs', async () => {
    bootstrapFromUrl('embed=true&language=de');
    const { default: service } = loadI18nService();
    await service.changeLanguage('en');
    expect(broadcastChannels.flatMap(channel => channel.posted)).toEqual([]);
  });

  test('outside embed mode a language change is still published', async () => {
    const { default: service } = loadI18nService();
    await service.changeLanguage('de');
    expect(broadcastChannels.flatMap(channel => channel.posted)).toContainEqual({
      type: 'language-changed',
      language: 'de'
    });
  });
});
