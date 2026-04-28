/* global Office, document */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import './office.css';
// Initialize i18next so main chat components (useTranslation) work in the taskpane.
// This is a side-effect import — i18n initializes synchronously and loads translations async.
import '../src/i18n/i18n';
import { OfficeConfigContext } from '../src/features/office/contexts/OfficeConfigContext';
import OfficeApp from '../src/features/office/components/OfficeApp';
import { installOfficeAuthInterceptor } from '../src/features/office/api/officeAuthBridge';

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
  try {
    const res = await fetch(`${basePath}/api/integrations/office-addin/config`);
    if (!res.ok) {
      throw new Error(`Config fetch failed: ${res.status}`);
    }
    config = await res.json();
  } catch (err) {
    const rootEl = document.getElementById('office-root');
    if (rootEl) {
      rootEl.textContent = `Failed to load add-in configuration. Please contact your administrator. (${err.message})`;
      rootEl.style.cssText = 'padding:16px;font-family:sans-serif;color:#b91c1c;';
    }
    return;
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

  const params = new URLSearchParams(window.location.search);
  const qaParam = params.get('qa');
  const qaIndex = qaParam != null ? Number(qaParam) : -1;
  const quickAction =
    qaIndex >= 0 && Number.isInteger(qaIndex) ? (config.quickActions?.[qaIndex] ?? null) : null;

  const rootEl = document.getElementById('office-root');
  if (!rootEl) return;

  const root = createRoot(rootEl);
  root.render(
    // eslint-disable-next-line @eslint-react/no-context-provider
    <OfficeConfigContext.Provider value={config}>
      <MemoryRouter>
        <OfficeApp quickAction={quickAction} />
      </MemoryRouter>
    </OfficeConfigContext.Provider>
  );
});
