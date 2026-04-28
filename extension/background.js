/**
 * iHub Apps browser extension — background service worker.
 *
 * Owns the OAuth/PKCE flow with the user's iHub instance, holds the access /
 * refresh tokens (chrome.storage.session for access, chrome.storage.local for
 * refresh), forwards chat / app requests on behalf of the side panel, and
 * refreshes tokens transparently on 401.
 *
 * The side panel and content script never see tokens — they always go through
 * the worker via chrome.runtime messages.
 */

// ---------------------------------------------------------------------------
// Config / storage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEYS = {
  baseUrl: 'ihub_base_url',
  refreshToken: 'ihub_refresh_token',
  accessToken: 'ihub_access_token',
  // Cached runtime config from /api/integrations/extension/config
  runtimeConfig: 'ihub_runtime_config',
  pkceVerifier: 'ihub_pkce_verifier'
};

async function getBaseUrl() {
  const { [STORAGE_KEYS.baseUrl]: baseUrl } = await chrome.storage.local.get(STORAGE_KEYS.baseUrl);
  return baseUrl || '';
}

async function setBaseUrl(url) {
  await chrome.storage.local.set({ [STORAGE_KEYS.baseUrl]: url });
}

async function getRefreshToken() {
  const { [STORAGE_KEYS.refreshToken]: token } = await chrome.storage.local.get(
    STORAGE_KEYS.refreshToken
  );
  return token || null;
}

async function setRefreshToken(token) {
  if (token) {
    await chrome.storage.local.set({ [STORAGE_KEYS.refreshToken]: token });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.refreshToken);
  }
}

async function getAccessToken() {
  const { [STORAGE_KEYS.accessToken]: token } = await chrome.storage.session.get(
    STORAGE_KEYS.accessToken
  );
  return token || null;
}

async function setAccessToken(token) {
  if (token) {
    await chrome.storage.session.set({ [STORAGE_KEYS.accessToken]: token });
  } else {
    await chrome.storage.session.remove(STORAGE_KEYS.accessToken);
  }
}

async function clearTokens() {
  await chrome.storage.session.remove(STORAGE_KEYS.accessToken);
  await chrome.storage.local.remove(STORAGE_KEYS.refreshToken);
}

async function getRuntimeConfig() {
  const { [STORAGE_KEYS.runtimeConfig]: cfg } = await chrome.storage.local.get(
    STORAGE_KEYS.runtimeConfig
  );
  return cfg || null;
}

async function setRuntimeConfig(cfg) {
  await chrome.storage.local.set({ [STORAGE_KEYS.runtimeConfig]: cfg });
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function randomString(length) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < length; i++) out += charset[buf[i] % charset.length];
  return out;
}

function base64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(plain) {
  const data = new TextEncoder().encode(plain);
  return crypto.subtle.digest('SHA-256', data);
}

async function createPkceParams() {
  const codeVerifier = randomString(64);
  const codeChallenge = base64url(await sha256(codeVerifier));
  const state = randomString(32);
  return { codeVerifier, codeChallenge, state };
}

// ---------------------------------------------------------------------------
// Runtime config + redirect URI
// ---------------------------------------------------------------------------

function getRedirectUri() {
  // chrome.identity.getRedirectURL() returns:
  //   https://<extension-id>.chromiumapp.org/  (Chromium)
  //   https://<extension-id>.extensions.allizom.org/  (Firefox)
  // The admin pre-registers `<base>/cb` so we explicitly append the path.
  const base = chrome.identity.getRedirectURL();
  // Some browsers append a trailing slash, others don't.
  return base.endsWith('/') ? `${base}cb` : `${base}/cb`;
}

async function fetchRuntimeConfig(baseUrl) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/integrations/extension/config`;
  const res = await fetch(url, { method: 'GET', credentials: 'omit' });
  if (!res.ok) {
    throw new Error(
      `Failed to load extension runtime config (${res.status}). Has the admin enabled the integration?`
    );
  }
  const cfg = await res.json();
  await setRuntimeConfig(cfg);
  return cfg;
}

async function ensureRuntimeConfig(baseUrl) {
  const cfg = await getRuntimeConfig();
  if (cfg && cfg.baseUrl === baseUrl && cfg.clientId) return cfg;
  return await fetchRuntimeConfig(baseUrl);
}

// ---------------------------------------------------------------------------
// OAuth: authorize + token exchange + refresh
// ---------------------------------------------------------------------------

async function startSignIn() {
  const baseUrl = await getBaseUrl();
  if (!baseUrl) {
    throw new Error('iHub base URL is not set. Open the extension options to configure it.');
  }
  const cfg = await ensureRuntimeConfig(baseUrl);
  if (!cfg.clientId) {
    throw new Error('Extension OAuth client is not configured on the server.');
  }

  const { codeVerifier, codeChallenge, state } = await createPkceParams();
  await chrome.storage.session.set({ [STORAGE_KEYS.pkceVerifier]: codeVerifier });

  const redirectUri = getRedirectUri();
  const authorizeUrl = new URL(`${baseUrl.replace(/\/$/, '')}/api/oauth/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', cfg.clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', 'openid profile email');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const callbackUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authorizeUrl.toString(), interactive: true },
      redirectedTo => {
        if (chrome.runtime.lastError || !redirectedTo) {
          reject(new Error(chrome.runtime.lastError?.message || 'Authorization cancelled'));
          return;
        }
        resolve(redirectedTo);
      }
    );
  });

  const parsed = new URL(callbackUrl);
  const returnedState = parsed.searchParams.get('state');
  const code = parsed.searchParams.get('code');
  const error = parsed.searchParams.get('error');
  if (error) {
    throw new Error(`Authorization failed: ${error}`);
  }
  if (!code || returnedState !== state) {
    throw new Error('Authorization response is invalid');
  }

  const tokenRes = await fetch(`${baseUrl.replace(/\/$/, '')}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      code_verifier: codeVerifier
    })
  });

  if (!tokenRes.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await tokenRes.json());
    } catch {}
    throw new Error(`Token exchange failed (${tokenRes.status}) ${detail}`);
  }

  const data = await tokenRes.json();
  const accessToken = data.access_token || data.token || data.accessToken;
  const refreshToken = data.refresh_token || data.refreshToken;
  if (!accessToken) throw new Error('Token endpoint returned no access_token');

  await setAccessToken(accessToken);
  if (refreshToken) await setRefreshToken(refreshToken);
  await chrome.storage.session.remove(STORAGE_KEYS.pkceVerifier);

  return { ok: true };
}

async function refreshAccessToken() {
  const baseUrl = await getBaseUrl();
  const cfg = await getRuntimeConfig();
  const refreshToken = await getRefreshToken();
  if (!baseUrl || !cfg?.clientId || !refreshToken) {
    throw new Error('Cannot refresh: missing base URL, client ID, or refresh token');
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: cfg.clientId
    })
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status})`);
  }
  const data = await res.json();
  const accessToken = data.access_token || data.token || data.accessToken;
  const newRefresh = data.refresh_token || data.refreshToken;
  if (!accessToken) throw new Error('Refresh response had no access_token');
  await setAccessToken(accessToken);
  if (newRefresh) await setRefreshToken(newRefresh);
  return accessToken;
}

async function signOut() {
  await clearTokens();
}

async function fetchUserInfo() {
  const baseUrl = await getBaseUrl();
  if (!baseUrl) throw new Error('iHub base URL is not set');
  const res = await authenticatedFetch(`${baseUrl.replace(/\/$/, '')}/api/oauth/userinfo`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`UserInfo failed (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Authenticated fetch wrapper (handles 401 → refresh → retry once)
// ---------------------------------------------------------------------------

let refreshInFlight = null;

async function authenticatedFetch(url, options = {}) {
  let token = await getAccessToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res = await fetch(url, { ...options, headers });
  if (res.status !== 401) return res;

  // Coalesce concurrent refreshes
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken().finally(() => {
      refreshInFlight = null;
    });
  }
  try {
    token = await refreshInFlight;
  } catch {
    await clearTokens();
    throw new Error('Session expired');
  }

  const retryHeaders = { ...(options.headers || {}) };
  if (token) retryHeaders.Authorization = `Bearer ${token}`;
  res = await fetch(url, { ...options, headers: retryHeaders });
  if (res.status === 401) {
    await clearTokens();
    throw new Error('Session expired');
  }
  return res;
}

// ---------------------------------------------------------------------------
// Apps + Chat helpers
// ---------------------------------------------------------------------------

async function listApps() {
  const baseUrl = await getBaseUrl();
  if (!baseUrl) throw new Error('iHub base URL is not set');
  const res = await authenticatedFetch(`${baseUrl.replace(/\/$/, '')}/api/apps`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Failed to load apps (${res.status})`);
  return res.json();
}

async function streamChat({ appId, modelId, messages, fileData, port }) {
  const baseUrl = await getBaseUrl();
  if (!baseUrl) throw new Error('iHub base URL is not set');
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat/${encodeURIComponent(appId)}`;

  const body = { messages };
  if (modelId) body.modelId = modelId;
  if (fileData) body.fileData = fileData;

  const res = await authenticatedFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    port.postMessage({ type: 'error', error: `Chat request failed (${res.status}): ${errText}` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = rawEvent.split('\n');
      let dataLine = '';
      for (const line of lines) {
        if (line.startsWith('data:')) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;
      try {
        const parsed = JSON.parse(dataLine);
        port.postMessage({ type: 'chat-event', event: parsed });
      } catch {
        port.postMessage({ type: 'chat-event', event: { content: dataLine } });
      }
    }
  }
  port.postMessage({ type: 'chat-done' });
}

// ---------------------------------------------------------------------------
// Page extraction (run in the active tab via scripting.executeScript)
// ---------------------------------------------------------------------------

async function extractCurrentTab({ selectionOnly = false } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error('No active tab to read');
  }
  const blockedSchemes = ['chrome:', 'edge:', 'about:', 'chrome-extension:', 'moz-extension:'];
  if (blockedSchemes.some(s => tab.url.startsWith(s))) {
    throw new Error('This tab type is not supported');
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [{ selectionOnly }],
    func: extractPageInPage
  });
  if (!result) throw new Error('Page extraction returned no result');
  return result;
}

/**
 * Page content extractor — runs in the active tab's content world via
 * chrome.scripting.executeScript({ func, args }). Must be self-contained:
 * outer-scope references are not available after the function is serialized.
 */
function extractPageInPage({ selectionOnly = false } = {}) {
  const MAX_CHARS = 200000;
  const url = location.href;
  const title = document.title || '';
  const trim = s => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

  if (selectionOnly) {
    try {
      const sel = window.getSelection && window.getSelection();
      const text = sel ? sel.toString() : '';
      if (text && text.trim()) {
        return {
          url,
          title,
          mode: 'selection',
          text: text.slice(0, MAX_CHARS),
          truncated: text.length > MAX_CHARS
        };
      }
    } catch {
      // fall through
    }
  }

  const NOISE = 'script,style,noscript,iframe,nav,footer,aside,header,form,template';
  const collectText = root => {
    const clone = root.cloneNode(true);
    clone.querySelectorAll(NOISE).forEach(el => el.remove());
    return clone.innerText || clone.textContent || '';
  };

  let text = '';
  let mode = 'fallback';

  const article = document.querySelector('article');
  if (article && article.innerText && article.innerText.trim().length > 200) {
    text = collectText(article);
    mode = 'article';
  } else {
    const main = document.querySelector('main');
    if (main && main.innerText && main.innerText.trim().length > 200) {
      text = collectText(main);
      mode = 'main';
    } else if (document.body) {
      text = collectText(document.body);
      mode = 'body';
    }
  }

  text = (text || '').replace(/\n{3,}/g, '\n\n');

  const metaContent = name => {
    const el = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
    return el ? trim(el.getAttribute('content') || '') : '';
  };

  return {
    url,
    title,
    mode,
    siteName: metaContent('og:site_name') || location.hostname,
    description: metaContent('description') || metaContent('og:description'),
    byline: metaContent('author') || metaContent('article:author'),
    text: text.slice(0, MAX_CHARS),
    truncated: text.length > MAX_CHARS
  };
}

// ---------------------------------------------------------------------------
// Side panel: open on action click
// ---------------------------------------------------------------------------

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(err => console.warn('sidePanel.setPanelBehavior failed', err));
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'get-base-url':
          sendResponse({ ok: true, baseUrl: await getBaseUrl() });
          break;
        case 'set-base-url': {
          const url = String(msg.baseUrl || '').trim();
          if (!url) throw new Error('Base URL is required');
          if (!/^https?:\/\//i.test(url)) throw new Error('Base URL must start with http(s)://');
          await setBaseUrl(url);
          // Clear cached runtime config; refetch lazily on next sign-in
          await chrome.storage.local.remove(STORAGE_KEYS.runtimeConfig);
          sendResponse({ ok: true });
          break;
        }
        case 'get-runtime-config': {
          const baseUrl = await getBaseUrl();
          if (!baseUrl) {
            sendResponse({ ok: false, error: 'No base URL configured' });
            return;
          }
          try {
            const cfg = await ensureRuntimeConfig(baseUrl);
            sendResponse({ ok: true, config: cfg });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
          break;
        }
        case 'auth-status': {
          const accessToken = await getAccessToken();
          const refreshToken = await getRefreshToken();
          sendResponse({
            ok: true,
            signedIn: Boolean(accessToken || refreshToken),
            hasAccessToken: Boolean(accessToken)
          });
          break;
        }
        case 'sign-in': {
          await startSignIn();
          sendResponse({ ok: true });
          break;
        }
        case 'sign-out': {
          await signOut();
          sendResponse({ ok: true });
          break;
        }
        case 'user-info': {
          const info = await fetchUserInfo();
          sendResponse({ ok: true, user: info });
          break;
        }
        case 'list-apps': {
          const apps = await listApps();
          sendResponse({ ok: true, apps });
          break;
        }
        case 'extract-page': {
          const page = await extractCurrentTab({ selectionOnly: !!msg.selectionOnly });
          sendResponse({ ok: true, page });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // keep the channel open for async sendResponse
});

// Streaming chat uses a long-lived port to avoid sendResponse single-reply
// limits and to let the side panel cancel mid-stream.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'chat-stream') return;
  port.onMessage.addListener(async msg => {
    if (msg?.type !== 'start') return;
    try {
      await streamChat({
        appId: msg.appId,
        modelId: msg.modelId,
        messages: msg.messages,
        fileData: msg.fileData,
        port
      });
    } catch (err) {
      port.postMessage({ type: 'error', error: err?.message || String(err) });
    }
  });
});
