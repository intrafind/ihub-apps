/* global Office, document, window */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import './office.css';
// Initialize i18next so main chat components (useTranslation) work in the taskpane.
// This is a side-effect import — i18n initializes synchronously and loads translations async.
import '../src/i18n/i18n';
import { OfficeConfigContext } from '../src/features/office/contexts/OfficeConfigContext';
import OfficeApp from '../src/features/office/components/OfficeApp';
import { installOfficeAuthInterceptor } from '../src/features/office/api/officeAuthBridge';

// Signal that the JS bundle loaded successfully and cancel the offline fallback timer
// set in taskpane.html. This runs before Office.onReady() so the timer is cleared
// as early as possible even if Office.onReady takes a moment.
window.__appInitialized = true;
if (window.__offlineTimer) {
  clearTimeout(window.__offlineTimer);
}

const CONFIG_STORAGE_KEY = 'office_ihub_config';

/**
 * Derive the base path from the current URL so the config fetch works
 * regardless of deployment subpath (e.g., /ihub/office/taskpane.html).
 */
function detectBasePath() {
  const pathname = window.location.pathname;
  // Remove /office/taskpane.html (or just /office/) from the end
  const match = pathname.match(/^(\/.*?)\/office(?:\/.*)?$/);
  return match ? match[1] : '';
}

Office.onReady(async () => {
  const basePath = detectBasePath();

  let config;
  let offline = false;

  try {
    const res = await fetch(`${basePath}/api/integrations/office-addin/config`);
    if (!res.ok) {
      throw new Error(`Config fetch failed: ${res.status}`);
    }
    config = await res.json();
    // Cache for offline use on next load.
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch {
      // localStorage may be unavailable in some managed environments.
    }
  } catch {
    // Network or server error — try the locally cached config.
    try {
      const cached = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (cached) {
        config = JSON.parse(cached);
        // Re-derive baseUrl from the current URL in case the deployment address changed.
        config.baseUrl = window.location.origin + basePath;
        offline = true;
      }
    } catch {
      // Parse error or localStorage unavailable.
    }

    if (!config) {
      // No cache and no network — show the inline offline fallback.
      const rootEl = document.getElementById('office-root');
      const fallback = document.getElementById('office-offline-fallback');
      if (rootEl) rootEl.style.display = 'none';
      if (fallback) fallback.style.display = 'flex';
      return;
    }
  }

  // Install Office Bearer token interceptor so apiClient works in the taskpane.
  // Passing config stores it in officeAuth so the SSE hook and Axios interceptor
  // can call refreshTokenOrExpireSession() without threading config everywhere.
  installOfficeAuthInterceptor(config);

  // Register the ItemChanged event to reset chat when user switches emails
  if (Office.context?.mailbox?.addHandlerAsync) {
    Office.context.mailbox.addHandlerAsync(Office.EventType.ItemChanged, () => {
      document.dispatchEvent(new CustomEvent('ihub:itemchanged'));
    });
  }

  const rootEl = document.getElementById('office-root');
  if (!rootEl) return;

  const root = createRoot(rootEl);
  root.render(
    // eslint-disable-next-line @eslint-react/no-context-provider
    <OfficeConfigContext.Provider value={config}>
      <MemoryRouter>
        <OfficeApp offline={offline} />
      </MemoryRouter>
    </OfficeConfigContext.Provider>
  );
});
