/* global document */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import './nextcloud.css';
// Initialize i18next so main chat components (useTranslation) work in the embed.
// Side-effect import — i18n initializes synchronously and loads translations async.
import '../src/i18n/i18n';
import { OfficeConfigContext } from '../src/features/office/contexts/OfficeConfigContext';
import { EmbeddedHostProvider } from '../src/features/office/contexts/EmbeddedHostContext';
import OfficeApp from '../src/features/office/components/OfficeApp';
import { installOfficeAuthInterceptor } from '../src/features/office/api/officeAuthBridge';
import { openNextcloudAuthDialog } from '../src/features/nextcloud-embed/utilities/nextcloudAuthDialog';
import {
  initNextcloudSelectionBridge,
  onSelectionChange
} from '../src/features/nextcloud-embed/utilities/nextcloudSelectionBridge';
import { fetchCurrentDocumentContext } from '../src/features/nextcloud-embed/utilities/nextcloudDocumentContext';

/**
 * Derive the base path from the current URL so the config fetch works
 * regardless of deployment subpath (e.g., /ihub/nextcloud/taskpane.html).
 */
function detectBasePath() {
  const pathname = window.location.pathname;
  const match = pathname.match(/^(\/.*?)\/nextcloud(?:\/.*)?$/);
  return match ? match[1] : '';
}

function renderError(rootEl, message) {
  rootEl.textContent = message;
  rootEl.style.cssText = 'padding:16px;font-family:sans-serif;color:#b91c1c;line-height:1.5;';
}

(async () => {
  const rootEl = document.getElementById('nextcloud-root');
  if (!rootEl) return;

  const basePath = detectBasePath();

  let config;
  try {
    const res = await fetch(`${basePath}/api/integrations/nextcloud-embed/config`);
    if (!res.ok) {
      throw new Error(`Config fetch failed: ${res.status}`);
    }
    config = await res.json();
  } catch (err) {
    renderError(
      rootEl,
      `Failed to load Nextcloud embed configuration. Please contact your administrator. (${err.message})`
    );
    return;
  }

  // Install the iHub Bearer-token interceptor (same one Outlook uses) so
  // apiClient calls (including the existing /api/integrations/nextcloud/*
  // endpoints) carry the user's iHub access token.
  installOfficeAuthInterceptor(config);

  // Spin up the selection bridge with the admin-configured origin allowlist.
  // The bridge seeds from the URL hash first, then listens for postMessage.
  initNextcloudSelectionBridge({ allowedHostOrigins: config.allowedHostOrigins || [] });

  // Replay any messages the inline buffer collected before the bridge
  // attached its own listener. Re-fire as MessageEvents so the bridge's
  // own origin/payload checks decide what to keep.
  try {
    const pending = window.__ihubPendingMessages || [];
    window.removeEventListener('message', window.__ihubMessageBuffer);
    for (const entry of pending) {
      window.dispatchEvent(new MessageEvent('message', { data: entry.data, origin: entry.origin }));
    }
    window.__ihubPendingMessages = [];
  } catch {
    /* benign — buffer is best-effort */
  }

  // Nextcloud host adapter: browser popup auth dialog + Nextcloud
  // document context built from the existing per-user OAuth grant.
  const nextcloudHost = {
    kind: 'nextcloud',
    loginSubtitle: 'iHub Apps for Nextcloud',
    runAuthDialog: openNextcloudAuthDialog,
    readMessageContext: fetchCurrentDocumentContext,
    contextToggles: [
      {
        key: 'documentContent',
        label: 'Include documents',
        defaultEnabled: true,
        controls: ['attachments']
      }
    ],
    // Surface in the login bullet list so first-time users understand
    // the flow before signing in.
    loginBullets: [
      {
        text: 'Run any iHub AI app against documents you picked in Nextcloud — summarise, translate, draft, ask.'
      },
      {
        text: 'Sign in once with your iHub account, then link your Nextcloud account from the connect prompt.'
      },
      {
        text: 'Documents stay in Nextcloud; iHub fetches them on demand through your existing OAuth grant.'
      }
    ]
  };

  // Reset chat when the user picks a different document set, mirroring
  // Outlook's `ItemChanged` handler. The OfficeApp shell listens to
  // `ihub:itemchanged` to clear the active conversation.
  onSelectionChange(() => {
    document.dispatchEvent(new CustomEvent('ihub:itemchanged'));
  });

  const root = createRoot(rootEl);
  root.render(
    // eslint-disable-next-line @eslint-react/no-context-provider
    <OfficeConfigContext.Provider value={config}>
      <EmbeddedHostProvider value={nextcloudHost}>
        <MemoryRouter>
          <OfficeApp />
        </MemoryRouter>
      </EmbeddedHostProvider>
    </OfficeConfigContext.Provider>
  );
})();
