// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Cached connectivity probe of the watermark detectors for the status page
 * (#3329). It reuses `pingDetector` of #3331, which sends a throwaway random key
 * (never a real one) through `callDetector` and so through `httpFetch`: the SSL
 * whitelist and the proxy configuration apply. Only the timeout is shorter
 * (3 s) so a dead detector cannot hold the page.
 *
 * @module services/euAiAct/detectorProbe
 */
import { callDetector } from '../provenance/watermark/DetectorClient.js';
import { pingDetector } from '../provenance/watermark/selfTest.js';

export const PROBE_TIMEOUT_MS = 3000;
export const PROBE_TTL_MS = 30_000;
/** `refresh=true` may bypass the cache at most this often per detector. */
export const PROBE_REFRESH_MIN_MS = 5000;
export const PROBE_CONCURRENCY = 8;

const cache = new Map();

/** Test hook. */
export function clearProbeCache() {
  cache.clear();
}

function cacheKey(model) {
  const marking = model.contentMarking?.text || {};
  return JSON.stringify([
    model.id,
    marking.detectorUrl,
    marking.detectorCredentialRef,
    marking.tokenizer,
    marking.algorithm,
    marking.prf,
    marking.contextWidth
  ]);
}

/**
 * Probe one model's detector.
 *
 * @param {Object} model
 * @param {Object} [options]
 * @param {boolean} [options.refresh] - Bypass the cache (rate limited)
 * @param {() => number} [options.now]
 * @param {Function} [options.call] - Detector call, for tests
 * @returns {Promise<{reachable: boolean, authenticated: boolean, contractValid: boolean, latencyMs: number|null, error?: string, checkedAt: string}>}
 */
export async function probeDetector(
  model,
  { refresh = false, now = Date.now, call = callDetector } = {}
) {
  const key = cacheKey(model);
  const hit = cache.get(key);
  const age = hit ? now() - hit.at : Infinity;
  if (hit && age < (refresh ? PROBE_REFRESH_MIN_MS : PROBE_TTL_MS)) return hit.result;
  let result;
  try {
    const ping = await pingDetector(model, {
      call: args => call({ ...args, timeoutMs: PROBE_TIMEOUT_MS })
    });
    result = { ...ping, checkedAt: new Date(now()).toISOString() };
  } catch (error) {
    result = {
      reachable: false,
      authenticated: false,
      contractValid: false,
      latencyMs: null,
      error: error?.code === 'WATERMARK_DETECTOR_NOT_CONFIGURED' ? 'not_configured' : 'network',
      checkedAt: new Date(now()).toISOString()
    };
  }
  cache.set(key, { at: now(), result });
  return result;
}

/**
 * Probe many detectors, at most {@link PROBE_CONCURRENCY} at once. Models that
 * share one detector are probed once.
 *
 * @param {Object[]} models - `by: "ihub"` models with a URL and a credential
 * @param {Object} [options] - See {@link probeDetector}
 * @returns {Promise<Map<string, Object>>} Result by model id
 */
export async function probeDetectors(models, options = {}) {
  const results = new Map();
  const byKey = new Map();
  for (const model of models) {
    const key = cacheKey({ ...model, id: '' });
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(model);
  }
  const groups = [...byKey.values()];
  let next = 0;
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, groups.length) }, async () => {
    while (next < groups.length) {
      const group = groups[next++];
      const result = await probeDetector(group[0], options);
      for (const model of group) results.set(model.id, result);
    }
  });
  await Promise.all(workers);
  return results;
}
