/**
 * Preview mode for the app editor's test panel (issue #2510).
 *
 * The panel loads `/apps/:appId?ihubPreview=1` in an iframe. There the page
 * renders without header, footer and sidebar, and never writes integration
 * settings: the iframe shares localStorage with the admin's own tabs.
 */
import {
  APP_PREVIEW_PARAM,
  appChatPath,
  isAppPreviewMode,
  resetAppPreviewModeDetection
} from '../../../client/src/utils/appPreviewMode';
import {
  getIntegrationSettings,
  updateSettingsFromUrl
} from '../../../client/src/utils/integrationSettings';

const realSelf = window.self;

// jsdom never runs in a frame; `self` is replaceable, `top` is not.
function simulateFrame(framed) {
  Object.defineProperty(window, 'self', {
    configurable: true,
    get: () => (framed ? {} : window)
  });
}

function goTo(url) {
  window.history.replaceState({}, '', url);
  resetAppPreviewModeDetection();
}

afterEach(() => {
  Object.defineProperty(window, 'self', { configurable: true, value: realSelf, writable: true });
  goTo('/');
  localStorage.clear();
});

describe('appChatPath', () => {
  test('builds the chat path, with the preview flag on request', () => {
    expect(appChatPath('chat')).toBe('/apps/chat');
    expect(appChatPath('chat', { preview: true })).toBe(`/apps/chat?${APP_PREVIEW_PARAM}=1`);
    expect(appChatPath('a b/c')).toBe('/apps/a%20b%2Fc');
  });
});

describe('isAppPreviewMode', () => {
  test('is on in a frame that was opened with the flag', () => {
    simulateFrame(true);
    goTo('/apps/chat?ihubPreview=1');
    expect(isAppPreviewMode()).toBe(true);
  });

  test('stays on after in-app navigation drops the query string', () => {
    simulateFrame(true);
    goTo('/apps/chat?ihubPreview=1');
    window.history.replaceState({}, '', '/apps/chat/c/chat-123');
    expect(isAppPreviewMode()).toBe(true);
  });

  test('is off outside a frame, even with the flag', () => {
    simulateFrame(false);
    goTo('/apps/chat?ihubPreview=1');
    expect(isAppPreviewMode()).toBe(false);
  });

  test('is off in a frame without the flag', () => {
    simulateFrame(true);
    goTo('/apps/chat');
    expect(isAppPreviewMode()).toBe(false);
  });
});

describe('integration settings in preview mode', () => {
  test('hide all chrome and leave the stored settings alone', () => {
    const stored = { showHeader: true, showFooter: true, showSidebar: true, language: null };
    localStorage.setItem('ihubIntegrationSettings', JSON.stringify(stored));
    simulateFrame(true);
    goTo('/apps/chat?ihubPreview=1&header=true');

    expect(getIntegrationSettings()).toEqual({
      showHeader: false,
      showFooter: false,
      showSidebar: false,
      language: null
    });
    updateSettingsFromUrl(new URLSearchParams('header=false&sidebar=false'));
    expect(JSON.parse(localStorage.getItem('ihubIntegrationSettings'))).toEqual(stored);
  });

  test('are unchanged when not in preview mode', () => {
    simulateFrame(false);
    goTo('/apps/chat');
    expect(getIntegrationSettings()).toEqual({
      showHeader: true,
      showFooter: true,
      showSidebar: true,
      language: null
    });
  });
});
