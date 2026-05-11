/* global document */
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import './nextcloud.css';
// Initialize i18next so main app components (useTranslation) work in the embed.
// Side-effect import — i18n initializes synchronously and loads translations async.
import '../src/i18n/i18n';
import App from '../src/App';
import { OfficeConfigContext } from '../src/features/office/contexts/OfficeConfigContext';
import { EmbeddedHostProvider } from '../src/features/office/contexts/EmbeddedHostContext';
import OfficeLogin from '../src/features/office/components/OfficeLogin';
import { installOfficeAuthInterceptor } from '../src/features/office/api/officeAuthBridge';
import {
  getAccessToken,
  setOnSessionExpired,
  storeTokenResponse,
  clearTokens
} from '../src/features/office/api/officeAuth';
import { openNextcloudAuthDialog } from '../src/features/nextcloud-embed/utilities/nextcloudAuthDialog';
import {
  initNextcloudSelectionBridge,
  onSelectionChange
} from '../src/features/nextcloud-embed/utilities/nextcloudSelectionBridge';
import { fetchCurrentDocumentContext } from '../src/features/nextcloud-embed/utilities/nextcloudDocumentContext';

/**
 * Derive the base path from the current URL so the config fetch works
 * regardless of deployment subpath (e.g., /ihub/nextcloud/full-embed.html).
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

const SESSION_EXPIRED_EVENT = 'ihub:embed:session-expired';

// Root component: shows the OAuth gate when no iHub access token is present,
// otherwise mounts the full iHub <App />. Note `<App />` brings its own
// BrowserRouter and AuthProvider — we just wrap it in the embedded-host
// contexts so OfficeLogin (and any embed-aware code) can resolve
// useEmbeddedHost/useOfficeConfig.
function EmbedRoot({ initialError }) {
  const [hasToken, setHasToken] = useState(() => !!getAccessToken());
  const [sessionError, setSessionError] = useState(initialError);

  useEffect(() => {
    function handleExpired() {
      setHasToken(false);
      setSessionError('Your session has expired. Please sign in again.');
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleExpired);
  }, []);

  if (!hasToken) {
    return (
      <OfficeLogin
        initialError={sessionError}
        onSuccess={tokenData => {
          storeTokenResponse(tokenData);
          setSessionError(null);
          setHasToken(true);
        }}
      />
    );
  }

  return <App />;
}

(async () => {
  const rootEl = document.getElementById('ihub-embed-root');
  if (!rootEl) return;

  // Flag this tab/iframe as an embed context BEFORE any client code runs.
  // `client/src/utils/integrationSettings.js` checks sessionStorage for this
  // key and returns "hide header & footer" without touching localStorage,
  // so the embed experience always renders chrome-free *and* doesn't
  // pollute the visibility preference of direct-visit users in other tabs.
  try {
    sessionStorage.setItem('ihubEmbedMode', '1');
  } catch {
    /* benign — Safari private mode etc. */
  }

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

  // Install the iHub Bearer-token interceptor (same one Outlook + the
  // existing taskpane use). Every subsequent apiClient call — including
  // the AuthContext's /auth/status probe inside the full App — will carry
  // the user's OAuth-issued access token, so the App sees an authenticated
  // user without going through cookie-based /login.
  installOfficeAuthInterceptor(config);

  // When the OAuth refresh flow fails, the interceptor calls the
  // session-expired callback. We use it to unmount the App and re-show
  // the login gate via the EmbedRoot's event listener.
  setOnSessionExpired(() => {
    clearTokens();
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  });

  // Selection bridge — captures the file selection encoded in the URL hash
  // and forwarded via postMessage. The bridge stays initialized for the
  // lifetime of the iframe so future hashchange / message events keep
  // updating the in-memory selection. AppChat does not yet consume this;
  // see the plan's "out of scope" note for the follow-up that pre-attaches
  // selected files to the chat.
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

  // Nextcloud host adapter: same shape the taskpane uses so OfficeLogin's
  // host.runAuthDialog / loginBullets / loginSubtitle all resolve.
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

  // Reset chat when the user picks a different document set. The full app's
  // chat surface listens for `ihub:itemchanged` (introduced for the taskpane).
  onSelectionChange(() => {
    document.dispatchEvent(new CustomEvent('ihub:itemchanged'));
  });

  // Rewrite the iframe's URL before <App /> mounts. App.jsx wraps its routes
  // in <BrowserRouter basename={getBasePath()}>, which reads
  // window.location.pathname to resolve the initial route — and at this point
  // pathname is `/nextcloud/full-embed.html`, which matches no route and
  // would render the SPA's 404 page. Replacing it with the app root (under
  // the same base path, so deep-link deployments keep working) lets the
  // router resolve to the home / app-list route instead. The selection
  // bridge already captured the hash above, so dropping it from the URL is
  // safe; we preserve it anyway in case downstream code re-reads it.
  const homePath = (basePath || '') + '/';
  if (window.location.pathname !== homePath) {
    const preservedHash = window.location.hash || '';
    window.history.replaceState({}, '', homePath + preservedHash);
  }

  const root = createRoot(rootEl);
  root.render(
    // eslint-disable-next-line @eslint-react/no-context-provider
    <OfficeConfigContext.Provider value={config}>
      <EmbeddedHostProvider value={nextcloudHost}>
        <EmbedRoot initialError={null} />
      </EmbeddedHostProvider>
    </OfficeConfigContext.Provider>
  );
})();
