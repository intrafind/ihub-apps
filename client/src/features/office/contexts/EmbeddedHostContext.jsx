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
 * @typedef {Object} HostContextToggle
 * @property {string} key             Stable identifier — also the persistence key.
 * @property {string} label           User-visible toggle label.
 * @property {boolean} defaultEnabled Initial state when the user has no saved preference.
 * @property {Array<'bodyText'|'attachments'>} controls
 *                                    Which fields of the HostMailContext this
 *                                    toggle gates. When the toggle is OFF, every
 *                                    listed field is cleared from the context the
 *                                    chat hook merges into the outgoing message.
 *
 * @typedef {Object} InsertActionConfig
 * @property {'icon'|'primary'} variant                   How the per-message insert action is
 *                                                        rendered. `'icon'` is the compact
 *                                                        icon-only button used in the main
 *                                                        web app and the browser extension.
 *                                                        `'primary'` renders a labelled,
 *                                                        brand-coloured button beneath each
 *                                                        assistant message — the dominant
 *                                                        action in the Outlook/Word taskpane.
 * @property {string} labelKey                            i18n key resolved at render time —
 *                                                        e.g. `'office.insertIntoEmail'` for
 *                                                        Outlook, `'office.insertIntoDocument'`
 *                                                        for Word/PowerPoint hosts.
 *
 * @typedef {Object} EmbeddedHostAdapter
 * @property {string} kind                                'office' | 'extension' | 'nextcloud'
 * @property {string} loginSubtitle                       e.g. "iHub Apps for Outlook"
 * @property {(authorizeUrl: string, onSuccess: (callbackUrl: string) => void, onError: (err: any) => void) => void} runAuthDialog
 * @property {() => Promise<HostMailContext>} readMessageContext  Returns mail/page context appended to chat messages.
 * @property {Array<HostContextToggle>} [contextToggles]
 *                                                        Optional list of "include this in
 *                                                        the message?" toggles surfaced under
 *                                                        the chat input's `+` menu. Empty /
 *                                                        omitted means no toggles render and
 *                                                        all available context is always sent.
 * @property {InsertActionConfig} [insertAction]          Optional override for how the per-message
 *                                                        "Insert into document/email" action is
 *                                                        rendered. When omitted the host uses the
 *                                                        web app default (compact icon button on
 *                                                        the action row). Outlook ships
 *                                                        `{ variant: 'primary', labelKey: 'office.insertIntoEmail' }`
 *                                                        so the action becomes the dominant
 *                                                        call-to-action beneath each assistant
 *                                                        message — see issue #1450.
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
  },
  contextToggles: []
};

/**
 * Apply the user's per-message host-context toggles to a HostMailContext.
 * Returns a shallow copy of `ctx` with every field listed under a
 * disabled toggle's `controls` cleared (`bodyText` → `null`,
 * `attachments` → `[]`).
 *
 * Defaults to "include everything" when:
 *   - the adapter declares no toggles,
 *   - the flags map is undefined,
 *   - or a specific toggle's flag is undefined (i.e. the user has never
 *     opened the menu).
 *
 * Used by `useOfficeChatAdapter` right before merging context into the
 * outgoing chat message.
 *
 * @param {HostMailContext} ctx
 * @param {Array<HostContextToggle>|undefined} toggles
 * @param {Object<string, boolean>|undefined} flags
 * @returns {HostMailContext}
 */
export function applyHostContextFlags(ctx, toggles, flags) {
  if (!ctx || !Array.isArray(toggles) || toggles.length === 0) return ctx;
  const f = flags || {};
  const filtered = { ...ctx };
  for (const toggle of toggles) {
    if (f[toggle.key] === false) {
      for (const field of toggle.controls || []) {
        if (field === 'bodyText') filtered.bodyText = null;
        else if (field === 'attachments') filtered.attachments = [];
      }
    }
  }
  return filtered;
}
