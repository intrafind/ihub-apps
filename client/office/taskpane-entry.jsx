/* global Office, document */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import './office.css';
// Initialize i18next so main chat components (useTranslation) work in the taskpane.
// This is a side-effect import — i18n initializes synchronously and loads translations async.
import '../src/i18n/i18n';
import { OfficeConfigContext } from '../src/features/office/contexts/OfficeConfigContext';
import { EmbeddedHostProvider } from '../src/features/office/contexts/EmbeddedHostContext';
import OfficeApp from '../src/features/office/components/OfficeApp';
import { installOfficeAuthInterceptor } from '../src/features/office/api/officeAuthBridge';
import { openOfficeAuthDialog } from '../src/features/office/utilities/officeAuthDialog';
import { fetchCurrentMailContext } from '../src/features/office/utilities/outlookMailContext';

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

  const rootEl = document.getElementById('office-root');
  if (!rootEl) return;

  // Detect which Office host is running this add-in so we can pick host-aware
  // copy for the "insert into document" primary action. `Office.context.host`
  // returns the Office.HostType enum string ("Outlook" | "Word" | "PowerPoint"
  // | …); we fall back to the mailbox presence check that the rest of the
  // codebase already uses, so older clients that don't populate `host` still
  // get the Outlook label.
  const officeHost = (() => {
    try {
      if (Office.context?.host) return String(Office.context.host);
    } catch {
      // Office.context.host can throw in some weird embed scenarios.
    }
    if (Office.context?.mailbox) return 'Outlook';
    return null;
  })();
  const isOutlookHost = officeHost === 'Outlook';
  const insertLabelKey = isOutlookHost ? 'office.insertIntoEmail' : 'office.insertIntoDocument';

  // Outlook host adapter: popup-window auth dialog + Outlook mailbox context.
  const outlookHost = {
    kind: 'office',
    loginSubtitle: 'iHub Apps for Outlook',
    runAuthDialog: openOfficeAuthDialog,
    readMessageContext: fetchCurrentMailContext,
    // Per-message opt-out toggles surfaced under the chat input's `+` menu.
    // Both default to ON to preserve the long-standing Outlook behaviour
    // (every message attaches the email body + attachments).
    contextToggles: [
      {
        key: 'emailBody',
        label: 'Include email body',
        defaultEnabled: true,
        controls: ['bodyText']
      },
      {
        key: 'attachments',
        label: 'Include attachments',
        defaultEnabled: true,
        controls: ['attachments']
      }
    ],
    // In the Office taskpane the "insert this response into the document /
    // email" button is the whole reason the user opened the add-in, so it
    // gets promoted to a labelled primary button beneath each assistant
    // message instead of the small icon used in the main web app.
    // See issue #1450.
    insertAction: {
      variant: 'primary',
      labelKey: insertLabelKey
    }
  };

  const root = createRoot(rootEl);
  root.render(
    // eslint-disable-next-line @eslint-react/no-context-provider
    <OfficeConfigContext.Provider value={config}>
      <EmbeddedHostProvider value={outlookHost}>
        <MemoryRouter>
          <OfficeApp />
        </MemoryRouter>
      </EmbeddedHostProvider>
    </OfficeConfigContext.Provider>
  );
});
