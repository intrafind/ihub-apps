/* global chrome */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import './extension.css';
import { OfficeConfigContext } from '../src/features/office/contexts/OfficeConfigContext';
import { EmbeddedHostProvider } from '../src/features/office/contexts/EmbeddedHostContext';
import OfficeApp from '../src/features/office/components/OfficeApp';
import { installExtensionAuth } from '../src/features/extension/installExtensionAuth';
import {
  runChromeIdentityAuth,
  getExtensionRedirectUri,
  readActiveTabContext
} from '../src/features/extension/extensionHost';
// NB: i18next is loaded *dynamically* below (after installExtensionAuth).
// `client/src/i18n/i18n.js` fires a module-init `loadPlatformConfig()` that
// hits `/configs/ui` via apiClient. If we imported it statically at the top
// of this file, that fetch would happen *before* installExtensionAuth has a
// chance to set apiClient.defaults.baseURL — so the request resolves
// against chrome-extension://<id>/ instead of the iHub server.

/**
 * Resolve the iHub runtime config the side panel needs to bootstrap:
 *
 *   { baseUrl, clientId, redirectUri, displayName, description, starterPrompts }
 *
 * Two sources, in order of preference:
 *
 *   1. globalThis.IHUB_RUNTIME_CONFIG — populated by the runtime-config.js
 *      script tag the download endpoint bakes into the packaged extension.
 *   2. The unpacked dev fallback — read the iHub URL the user typed into
 *      chrome.storage.local (set by the legacy options page) and fetch
 *      /api/integrations/browser-extension/config from it.
 *
 * `redirectUri` is always derived from chrome.identity.getRedirectURL() so
 * that the value matches the URI registered on the server's OAuth client.
 */
async function resolveConfig() {
  const baked = globalThis.IHUB_RUNTIME_CONFIG;
  if (baked && baked.baseUrl && baked.clientId) {
    return {
      baseUrl: baked.baseUrl,
      clientId: baked.clientId,
      redirectUri: getExtensionRedirectUri(),
      displayName: baked.displayName || {},
      description: baked.description || {},
      starterPrompts: Array.isArray(baked.starterPrompts) ? baked.starterPrompts : []
    };
  }

  const { ihub_base_url: storedBaseUrl } = await chrome.storage.local.get('ihub_base_url');
  if (!storedBaseUrl) {
    throw new Error(
      'No iHub base URL configured. Open the extension options to set one, or install a build downloaded from the iHub admin page.'
    );
  }

  const trimmed = String(storedBaseUrl).replace(/\/$/, '');
  const res = await fetch(`${trimmed}/api/integrations/browser-extension/config`);
  if (!res.ok) {
    throw new Error(
      `Failed to load extension runtime config (${res.status}). Has the admin enabled the integration on ${trimmed}?`
    );
  }
  const remote = await res.json();
  return {
    baseUrl: remote.baseUrl || trimmed,
    clientId: remote.clientId,
    redirectUri: getExtensionRedirectUri(),
    displayName: remote.displayName || {},
    description: remote.description || {},
    starterPrompts: Array.isArray(remote.starterPrompts) ? remote.starterPrompts : []
  };
}

function renderError(rootEl, message) {
  rootEl.textContent = message;
  rootEl.style.cssText = 'padding:16px;font-family:sans-serif;color:#b91c1c;line-height:1.5;';
}

(async () => {
  const rootEl = document.getElementById('extension-root');
  if (!rootEl) return;

  let config;
  try {
    config = await resolveConfig();
  } catch (err) {
    renderError(rootEl, err.message || 'Failed to load extension configuration.');
    return;
  }

  // Re-target the Axios clients at the iHub server (chrome-extension://
  // origin obviously doesn't host the API), then attach the Bearer-token
  // and 401-refresh interceptors the office bridge already provides.
  installExtensionAuth(config);

  // i18next must be loaded *after* installExtensionAuth — the module
  // kicks off `loadPlatformConfig()` (apiClient.get('/configs/ui')) at
  // import time. Loading it dynamically here means the apiClient
  // baseURL is already pointing at the iHub server when that fetch
  // fires.
  await import('../src/i18n/i18n');

  const extensionHost = {
    kind: 'extension',
    loginSubtitle: 'iHub Apps for the browser',
    runAuthDialog: runChromeIdentityAuth,
    readMessageContext: readActiveTabContext,
    // Single per-message toggle — "Include page" — surfaced under the
    // chat input's `+` menu. Defaults to ON since attaching the page
    // is the whole point of the extension; users can turn it off when
    // they want to ask the AI a generic question without the active
    // tab leaking into the prompt.
    contextToggles: [
      {
        key: 'pageText',
        label: 'Include page',
        defaultEnabled: true,
        controls: ['bodyText']
      }
    ],
    // Override the default Outlook-flavoured login bullets with copy that
    // describes the page-context flow.
    loginBullets: [
      {
        text: 'Run any iHub AI app against the page you are reading — summarize, translate, ask, draft a reply.'
      },
      {
        text: 'Pick "Send page" or select text first to send only the highlighted passage.'
      },
      {
        text: 'Choose any app you have access to in iHub; the panel mirrors your account permissions.'
      },
      {
        text: 'Sign in once with your iHub account; tokens stay inside the extension and refresh automatically.'
      }
    ]
  };

  const root = createRoot(rootEl);
  root.render(
    // eslint-disable-next-line @eslint-react/no-context-provider
    <OfficeConfigContext.Provider value={config}>
      <EmbeddedHostProvider value={extensionHost}>
        <MemoryRouter>
          <OfficeApp />
        </MemoryRouter>
      </EmbeddedHostProvider>
    </OfficeConfigContext.Provider>
  );
})();
