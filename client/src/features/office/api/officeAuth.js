/**
 * Office add-in authentication module.
 * Uses prefixed localStorage keys to avoid conflicts with the main SPA's auth tokens.
 * All OAuth URLs are derived from OfficeConfigContext at runtime (no build-time env vars).
 */

export const OFFICE_TOKEN_KEY = 'office_ihubtoken';
export const OFFICE_REFRESH_TOKEN_KEY = 'office_ihub_refresh_token';
export const OFFICE_PKCE_VERIFIER_KEY = 'office_ihub_pkce_code_verifier';

const defaultHeaders = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Token storage helpers
// ---------------------------------------------------------------------------

export function getAccessToken() {
  try {
    return localStorage.getItem(OFFICE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getRefreshToken() {
  try {
    return localStorage.getItem(OFFICE_REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeTokenResponse(data) {
  try {
    const token = data?.token ?? data?.access_token ?? data?.accessToken ?? null;
    if (token) localStorage.setItem(OFFICE_TOKEN_KEY, token);

    const refreshToken = data?.refresh_token ?? data?.refreshToken ?? null;
    if (refreshToken) localStorage.setItem(OFFICE_REFRESH_TOKEN_KEY, refreshToken);
  } catch {
    // ignore storage errors
  }
}

export function clearTokens() {
  try {
    localStorage.removeItem(OFFICE_TOKEN_KEY);
    localStorage.removeItem(OFFICE_REFRESH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

export function getStoredPkceVerifier() {
  try {
    return sessionStorage.getItem(OFFICE_PKCE_VERIFIER_KEY);
  } catch {
    return null;
  }
}

const generateRandomString = length => {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const randomValues = new Uint32Array(length);
  window.crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += charset[randomValues[i] % charset.length];
  }
  return result;
};

const sha256 = async plain => {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hashBuffer);
};

const base64UrlEncode = buffer => {
  const base64 = window.btoa(String.fromCharCode.apply(null, buffer));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const createPkceParams = async () => {
  const codeVerifier = generateRandomString(43);
  const hash = await sha256(codeVerifier);
  const codeChallenge = base64UrlEncode(hash);
  const state = generateRandomString(32);

  try {
    sessionStorage.setItem(OFFICE_PKCE_VERIFIER_KEY, codeVerifier);
  } catch {}

  return { codeVerifier, codeChallenge, state };
};

export const parseAuthCodeFromUrl = url => {
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    return { code, state };
  } catch {
    return { code: null, state: null };
  }
};

// ---------------------------------------------------------------------------
// OAuth URL builders (require runtime config)
// ---------------------------------------------------------------------------

export function getAuthorizeUrl(config, { codeChallenge, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid profile email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });
  return `${config.baseUrl}/api/oauth/authorize?${params.toString()}`;
}

export function getTokenUrl(config) {
  return `${config.baseUrl}/api/oauth/token`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export const exchangeAuthCodeForToken = async (config, { code, codeVerifier }) => {
  const response = await fetch(getTokenUrl(config), {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier
    })
  });

  if (!response.ok) {
    let errorBody = null;
    try {
      errorBody = await response.json();
    } catch {}
    throw errorBody || new Error(`Token request failed with status ${response.status}`);
  }

  return response.json();
};

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export const refreshAccessToken = async config => {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    throw new Error('No refresh token available.');
  }

  const response = await fetch(getTokenUrl(config), {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId
    })
  });

  if (!response.ok) {
    let errorBody = null;
    try {
      errorBody = await response.json();
    } catch {}
    throw errorBody || new Error(`Token refresh failed with status ${response.status}`);
  }

  const data = await response.json();
  storeTokenResponse(data);
  return data;
};

// ---------------------------------------------------------------------------
// Authenticated fetch with auto-refresh
// ---------------------------------------------------------------------------

let onSessionExpiredCallback = null;
let refreshPromise = null;

// Stored at startup via setOfficeConfig — allows modules (Axios interceptor,
// SSE hook) to call refreshTokenOrExpireSession() without threading config through.
let officeConfig = null;

export function setOnSessionExpired(callback) {
  onSessionExpiredCallback = callback;
}

export function setOfficeConfig(config) {
  officeConfig = config;
}

function ensureTokenRefreshed(config) {
  const cfg = config ?? officeConfig;
  if (!cfg) throw new Error('Office config not initialized');
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken(cfg).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/**
 * Attempt a silent token refresh using the stored Office config.
 * On failure, invokes the session-expired callback and re-throws so callers
 * can propagate the error appropriately.
 */
export async function refreshTokenOrExpireSession() {
  try {
    await ensureTokenRefreshed();
  } catch (err) {
    onSessionExpiredCallback?.();
    throw err;
  }
}

export async function authenticatedFetch(config, url, options = {}) {
  const token = getAccessToken();
  const headers = { ...(options.headers ?? {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    try {
      await refreshTokenOrExpireSession();
    } catch {
      throw new Error('Session expired');
    }

    const newToken = getAccessToken();
    const retryHeaders = { ...(options.headers ?? {}) };
    if (newToken) {
      retryHeaders.Authorization = `Bearer ${newToken}`;
    }
    response = await fetch(url, { ...options, headers: retryHeaders });

    if (response.status === 401) {
      onSessionExpiredCallback?.();
      throw new Error('Session expired');
    }
  }

  return response;
}

// ---------------------------------------------------------------------------
// User info
// ---------------------------------------------------------------------------

export const fetchUserInfo = async config => {
  const response = await authenticatedFetch(config, `${config.baseUrl}/api/oauth/userinfo`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`UserInfo request failed with status ${response.status}`);
  }

  const data = await response.json();
  return {
    ...data,
    username: data.username ?? data.preferred_username ?? null
  };
};
