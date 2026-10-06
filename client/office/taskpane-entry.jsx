/* global Office, document */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import './office.css';
// Initialize i18next so main chat components (useTranslation) work in the taskpane.
// This is a side-effect import — i18n initializes synchronously and loads translations async.
import '../src/i18n/i18n';
import { OfficeConfigContext } from '../src/features/office/contexts/OfficeConfigContext';
import { EmbeddedHostProvider } from '../src/features/office/contexts/EmbeddedHostContext';
import OfficeApp, {
  OFFICE_USER_KEY,
  storeSelectedApp
} from '../src/features/office/components/OfficeApp';
import {
  popoutChatRouteState,
  seedPopoutTranscript
} from '../src/features/office/utilities/officePopoutChat';
import { installOfficeAuthInterceptor } from '../src/features/office/api/officeAuthBridge';
import { storeTokenResponse } from '../src/features/office/api/officeAuth';
import { openOfficeAuthDialog } from '../src/features/office/utilities/officeAuthDialog';
import { fetchCurrentOutlookItemContext } from '../src/features/office/utilities/outlookMailContext';
import { initOfficeTheme } from '../src/features/office/utilities/officeTheme';
import { isPopoutPage } from '../src/features/office/utilities/officePopout';
import { connectPopoutToPane } from '../src/features/office/utilities/officePopoutChild';
import { OFFICE_CHAT_PATH } from '../src/features/office/utilities/officeStartPage';

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

// Apply the persisted light/dark preference (Settings → Appearance) before
// Office.js finishes initialising so dark-mode users never see a white flash.
// Re-run inside onReady: only then are Office.context.officeTheme and the
// OfficeThemeChanged event available for "auto" mode.
initOfficeTheme();

/**
 * The Outlook host adapter: popup-window auth dialog + Outlook mailbox context.
 *
 * No `contextToggles` are declared (issue #1467). The body /
 * attachments filters that used to live in the chat input's `+` menu
 * are now owned by OfficeMailContextBanner — the "Include body"
 * checkbox sits on the email card and each attachment ships with its
 * own X button, so the duplicated menu toggles only confused users.
 * The browser-extension side panel still declares its own `pageText`
 * toggle in sidepanel-entry.jsx; that surface keeps working unchanged.
 *
 * @param {string|null} officeHost - `Office.context.host`, e.g. "Outlook".
 * @param {object} [popout] - Set in the popped-out chat (officePopoutChild.js).
 */
function buildOutlookHost(officeHost, popout) {
  const isOutlookHost = officeHost === 'Outlook';
  const insertLabelKey = isOutlookHost ? 'office.insertIntoEmail' : 'office.insertIntoDocument';
  return {
    kind: 'office',
    loginSubtitle: 'iHub Apps for Outlook',
    runAuthDialog: openOfficeAuthDialog,
    // Unified reader dispatches between mail and appointment items by
    // inspecting `Office.context.mailbox.item.itemType`. Existing mail
    // surfaces get the same payload as before plus `itemKind: 'message'`;
    // calendar surfaces receive the appointment shape (subject, start,
    // end, organizer, attendees, location, body). In the popped-out chat it
    // asks the pane, which has the item.
    readMessageContext: fetchCurrentOutlookItemContext,
    // In the Office taskpane the "insert this response into the document /
    // email" button is the whole reason the user opened the add-in, so it
    // gets promoted to a labelled primary button beneath each assistant
    // message instead of the small icon used in the main web app.
    // See issue #1450.
    insertAction: {
      variant: 'primary',
      labelKey: insertLabelKey
    },
    ...(popout ? { popout } : {})
  };
}

function renderOfficeApp(rootEl, { config, host, initialEntries }) {
  const root = createRoot(rootEl);
  root.render(
    // eslint-disable-next-line @eslint-react/no-context-provider
    <OfficeConfigContext.Provider value={config}>
      <EmbeddedHostProvider value={host}>
        <MemoryRouter initialEntries={initialEntries}>
          <OfficeApp />
        </MemoryRouter>
      </EmbeddedHostProvider>
    </OfficeConfigContext.Provider>
  );
}

function showStartupError(rootEl, message) {
  if (!rootEl) return;
  rootEl.textContent = message;
  rootEl.style.cssText = 'padding:16px;font-family:sans-serif;color:#b91c1c;';
}

/**
 * The chat popped out of the pane into an Office dialog (officePopout.js).
 * It signs in with the pane's tokens, opens the chat the pane handed over and
 * reaches Outlook through the pane from then on.
 */
async function startPopout(rootEl) {
  let connection;
  try {
    connection = await connectPopoutToPane();
  } catch (err) {
    showStartupError(
      rootEl,
      `This window lost its connection to Outlook. Close it and open the chat again from the Outlook pane. (${err?.message || err})`
    );
    return;
  }
  const { init, popout } = connection;

  storeTokenResponse(init.tokens);
  try {
    if (init.user) localStorage.setItem(OFFICE_USER_KEY, JSON.stringify(init.user));
  } catch {
    // The chat still works; the settings dialog shows no name.
  }
  storeSelectedApp(init.chat?.app ?? null);
  seedPopoutTranscript(init.chat);
  installOfficeAuthInterceptor(init.config);

  renderOfficeApp(rootEl, {
    config: init.config,
    // Only Outlook pops its chat out.
    host: buildOutlookHost('Outlook', popout),
    initialEntries: [{ pathname: OFFICE_CHAT_PATH, state: popoutChatRouteState(init.chat) }]
  });
}

Office.onReady(async () => {
  initOfficeTheme();

  const rootEl = document.getElementById('office-root');
  if (isPopoutPage()) {
    await startPopout(rootEl);
    return;
  }

  const basePath = detectBasePath();

  let config;
  try {
    const res = await fetch(`${basePath}/api/integrations/office-addin/config`);
    if (!res.ok) {
      throw new Error(`Config fetch failed: ${res.status}`);
    }
    config = await res.json();
  } catch (err) {
    showStartupError(
      rootEl,
      `Failed to load add-in configuration. Please contact your administrator. (${err.message})`
    );
    return;
  }

  // Install Office Bearer token interceptor so apiClient works in the taskpane.
  // Passing config stores it in officeAuth so the SSE hook and Axios interceptor
  // can call refreshTokenOrExpireSession() without threading config everywhere.
  installOfficeAuthInterceptor(config);

  // ItemChanged fires when the pinned pane shows a different email; listeners
  // re-read the item. SelectedItemsChanged is deliberately not handled: it
  // only matters with SupportsMultiSelect, which the manifest dropped because
  // it turns off ItemChanged in Outlook for Mac (the pane stayed on the email
  // it was opened on). It also fires before ItemChanged there, which made
  // every switch refresh twice.
  if (Office.context?.mailbox?.addHandlerAsync) {
    Office.context.mailbox.addHandlerAsync(Office.EventType.ItemChanged, () =>
      document.dispatchEvent(new CustomEvent('ihub:itemchanged'))
    );
  }

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

  renderOfficeApp(rootEl, { config, host: buildOutlookHost(officeHost) });
});
