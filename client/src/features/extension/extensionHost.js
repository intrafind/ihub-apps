/* global chrome */

/**
 * Browser-extension host adapter for the embedded chat shell.
 *
 * Implements the same `EmbeddedHostAdapter` shape that the Outlook taskpane
 * provides to `OfficeApp` — see `features/office/contexts/EmbeddedHostContext.jsx`.
 * The two halves: a Chrome-extension-native auth dialog (replaces the popup
 * window) and a page-context reader (replaces Outlook's mailbox reader).
 */

/**
 * Run the OAuth/PKCE authorize step via `chrome.identity.launchWebAuthFlow`.
 *
 * Mirrors the contract of `openOfficeAuthDialog`:
 * `(authorizeUrl, onRedirectUrl, onError) => void`. The Chrome API is
 * promise-style; we adapt it to the callback-style the embedded login
 * component expects.
 */
export function runChromeIdentityAuth(authorizeUrl, onRedirectUrl, onError) {
  if (!globalThis.chrome?.identity?.launchWebAuthFlow) {
    onError?.(
      new Error(
        'chrome.identity is not available — the extension must be loaded with the "identity" permission.'
      )
    );
    return;
  }
  chrome.identity.launchWebAuthFlow({ url: authorizeUrl, interactive: true }, redirectedTo => {
    const lastError = chrome.runtime?.lastError;
    if (lastError || !redirectedTo) {
      onError?.(new Error(lastError?.message || 'Authorization cancelled'));
      return;
    }
    onRedirectUrl?.(redirectedTo);
  });
}

/**
 * Compute the redirect URI Chrome will deliver the authorize callback to.
 * Always `https://<extension-id>.chromiumapp.org/cb` (or the equivalent
 * Firefox host). The `/cb` suffix matches what the iHub admin endpoint
 * registers on the OAuth client.
 */
export function getExtensionRedirectUri() {
  const base = chrome.identity.getRedirectURL();
  return base.endsWith('/') ? `${base}cb` : `${base}/cb`;
}

/**
 * Return the active tab's text content, with the user's selection (if any)
 * preferred over the full page. Shape matches what `useOfficeChatAdapter`
 * expects from `host.readMessageContext()`:
 *
 *   { available, bodyText, attachments }
 *
 * `attachments` is always an empty array in the extension because we don't
 * surface page resources as separate attachments today.
 */
export async function readActiveTabContext() {
  const empty = { available: false, bodyText: null, attachments: [] };
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = tabs[0];
  if (!tab?.id || !tab.url) {
    console.info('[iHub] readActiveTabContext: no active tab found in current window');
    return empty;
  }

  const blockedSchemes = ['chrome:', 'edge:', 'about:', 'chrome-extension:', 'moz-extension:'];
  if (blockedSchemes.some(s => tab.url.startsWith(s))) {
    console.info(
      `[iHub] readActiveTabContext: skipping unsupported URL scheme (${tab.url.split(':')[0]}:)`
    );
    return empty;
  }

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const MAX_CHARS = 200000;
        const url = location.href;
        const title = document.title || '';
        const sel = (window.getSelection && window.getSelection().toString().trim()) || '';
        if (sel) {
          return { url, title, mode: 'selection', text: sel.slice(0, MAX_CHARS) };
        }
        const NOISE = 'script,style,noscript,iframe,nav,footer,aside,header,form,template';
        const collect = root => {
          const clone = root.cloneNode(true);
          clone.querySelectorAll(NOISE).forEach(el => el.remove());
          return clone.innerText || clone.textContent || '';
        };
        let text = '';
        let mode = 'fallback';
        const article = document.querySelector('article');
        if (article && article.innerText && article.innerText.trim().length > 200) {
          text = collect(article);
          mode = 'article';
        } else {
          const main = document.querySelector('main');
          if (main && main.innerText && main.innerText.trim().length > 200) {
            text = collect(main);
            mode = 'main';
          } else if (document.body) {
            text = collect(document.body);
            mode = 'body';
          }
        }
        return {
          url,
          title,
          mode,
          text: (text || '').replace(/\n{3,}/g, '\n\n').slice(0, MAX_CHARS)
        };
      }
    });
    if (!result?.text) {
      console.info('[iHub] readActiveTabContext: extractor returned empty text', tab.url);
      return empty;
    }
    const header = `# ${result.title || result.url}\n\nSource: ${result.url}\n\n`;
    return {
      available: true,
      bodyText: header + result.text,
      attachments: []
    };
  } catch (err) {
    // Most common cause: the iHub extension lacks host permission for this
    // tab's origin (chrome://, file://, or a site the user hasn't granted).
    // host_permissions in manifest.json defaults to <all_urls>, so this only
    // fires for browser-internal URLs and tabs like the new-tab page.
    console.warn('[iHub] readActiveTabContext failed:', err?.message || err, tab.url);
    return empty;
  }
}
