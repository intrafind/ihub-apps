/**
 * Azure Speech token broker.
 *
 * The Azure subscription key is a server-side secret (stored encrypted in
 * platform.speech.azure). The browser Speech SDK authenticates with a
 * short-lived authorization token instead of the key, so the key never leaves
 * the server. This module exchanges the subscription key for such a token via
 * the Azure STS `issueToken` endpoint, with a small in-memory cache (tokens are
 * valid ~10 minutes; Microsoft recommends refreshing before that).
 *
 * https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text-short#authentication
 */
import logger from '../utils/logger.js';

// Azure regions are lowercase alphanumerics (optionally hyphenated), e.g.
// `westeurope`, `eastus2`. Rejecting anything else prevents an
// attacker-influenced region from redirecting the token request (SSRF).
const REGION_RE = /^[a-z0-9-]+$/;

// Refresh a little before the ~10-minute Azure token lifetime.
const TOKEN_TTL_MS = 9 * 60 * 1000;

const cache = new Map(); // key -> { token, region, expiresAt }

/**
 * Exchange an Azure subscription key for a short-lived authorization token.
 *
 * @param {{subscriptionKey?: string, region?: string}} cfg
 * @param {typeof fetch} [fetchImpl] Injectable for testing.
 * @returns {Promise<{ok: true, token: string, region: string} | {ok: false, error: string}>}
 */
export async function issueAzureSpeechToken(cfg = {}, fetchImpl = fetch) {
  const subscriptionKey = cfg.subscriptionKey;
  const region = (cfg.region || '').trim();

  if (!subscriptionKey) {
    return { ok: false, error: 'Azure subscription key is not configured' };
  }
  if (!region) {
    return { ok: false, error: 'Azure region is not configured' };
  }
  if (!REGION_RE.test(region)) {
    return { ok: false, error: `Invalid Azure region "${region}"` };
  }

  const url = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'Content-Length': '0'
      }
    });
    if (!res.ok) {
      return { ok: false, error: `Azure token request failed (HTTP ${res.status})` };
    }
    const token = await res.text();
    return { ok: true, token, region };
  } catch (err) {
    return { ok: false, error: `Azure token request failed: ${err.message}` };
  }
}

/**
 * Cached variant of {@link issueAzureSpeechToken}. Returns a still-valid cached
 * token when available, otherwise issues (and caches) a fresh one.
 */
export async function getAzureSpeechToken(cfg = {}, fetchImpl = fetch, now = Date.now()) {
  const region = (cfg.region || '').trim();
  const key = `${region}:${cfg.subscriptionKey || ''}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return { ok: true, token: cached.token, region: cached.region };
  }

  const result = await issueAzureSpeechToken(cfg, fetchImpl);
  if (result.ok) {
    cache.set(key, { token: result.token, region: result.region, expiresAt: now + TOKEN_TTL_MS });
  } else {
    logger.warn('Azure Speech token issuance failed', {
      component: 'AzureSpeechToken',
      error: result.error
    });
  }
  return result;
}

/** Clear the token cache (used in tests). */
export function _clearAzureTokenCache() {
  cache.clear();
}
