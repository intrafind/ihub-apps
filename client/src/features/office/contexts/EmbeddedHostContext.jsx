import * as React from 'react';

/**
 * Host adapter for the embedded chat shell.
 *
 * The same React tree (`OfficeApp` → login / app picker / chat panel) renders
 * inside the Outlook taskpane and inside the iHub browser extension's side
 * panel. The two hosts differ in three places:
 *
 *   1. how the OAuth/PKCE authorize step is launched (popup window vs.
 *      `chrome.identity.launchWebAuthFlow`),
 *   2. what extra context is attached to outgoing chat messages (the current
 *      Outlook mail body + attachments vs. the active browser tab's text +
 *      selection),
 *   3. small cosmetic / copy differences (the login subtitle, post-logout
 *      navigation behaviour).
 *
 * Anything host-specific is funnelled through this context. Both the Outlook
 * taskpane entry and the browser-extension side panel entry wrap their root
 * in an `<EmbeddedHostProvider value={hostAdapter}>`. Components read the
 * adapter via `useEmbeddedHost()`.
 *
 * Default value matches the long-standing Outlook behaviour, so any component
 * that doesn't have a provider above it (existing tests, dev tools) keeps
 * working unchanged.
 *
 * @typedef {Object} HostMailContext
 * @property {boolean} available
 * @property {string|null} bodyText
 * @property {Array<{ name: string, contentType?: string, [k: string]: any }>} attachments
 *
 * @typedef {Object} EmbeddedHostAdapter
 * @property {string} kind                                'office' | 'extension'
 * @property {string} loginSubtitle                       e.g. "iHub Apps for Outlook"
 * @property {(authorizeUrl: string, onSuccess: (callbackUrl: string) => void, onError: (err: any) => void) => void} runAuthDialog
 * @property {() => Promise<HostMailContext>} readMessageContext  Returns mail/page context appended to chat messages.
 */

/** @type {React.Context<EmbeddedHostAdapter|null>} */
const EmbeddedHostContext = React.createContext(null);

export function EmbeddedHostProvider({ value, children }) {
  // eslint-disable-next-line @eslint-react/no-context-provider
  return <EmbeddedHostContext.Provider value={value}>{children}</EmbeddedHostContext.Provider>;
}

/**
 * Read the current host adapter. Falls back to a default Outlook-like
 * adapter when no provider is in scope, so the Outlook taskpane keeps
 * working without an explicit provider during the rollout window.
 */
export function useEmbeddedHost() {
  const adapter = React.useContext(EmbeddedHostContext);
  if (adapter) return adapter;
  return DEFAULT_OFFICE_ADAPTER;
}

/**
 * Default adapter — preserves the pre-context Outlook behaviour. Built lazily
 * to avoid pulling Office.js / the popup helper into every consumer at
 * module-evaluation time.
 */
const DEFAULT_OFFICE_ADAPTER = {
  kind: 'office',
  loginSubtitle: 'iHub Apps for Outlook',
  runAuthDialog: async (authorizeUrl, onSuccess, onError) => {
    const { openOfficeAuthDialog } = await import('../utilities/officeAuthDialog');
    openOfficeAuthDialog(authorizeUrl, onSuccess, onError);
  },
  readMessageContext: async () => {
    const { fetchCurrentMailContext } = await import('../utilities/outlookMailContext');
    return fetchCurrentMailContext();
  }
};
