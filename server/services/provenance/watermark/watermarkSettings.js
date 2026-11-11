// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Detection tunables, `platform.provenance.watermark`, with code defaults (no
 * migration: an absent block behaves like a present one).
 *
 * - `alpha` (1e-4): family-wise false-positive rate for "consistent with our
 *   watermark". Bonferroni-corrected by the number of (key, detector) tests.
 *   vLLM's example detector uses 0.01, far too loose for an origin claim.
 * - `minScoredTokens` (200): below this a negative becomes "too short to tell".
 * - `detectorTimeoutMs` (15000).
 *
 * @module services/provenance/watermark/watermarkSettings
 */
import configCache from '../../../configCache.js';

export const DEFAULT_ALPHA = 1e-4;
export const DEFAULT_MIN_SCORED_TOKENS = 200;
export const DEFAULT_DETECTOR_TIMEOUT_MS = 15_000;

export function watermarkSettings(platform = configCache.getPlatform() || {}) {
  const raw = platform?.provenance?.watermark || {};
  const alpha = Number(raw.alpha);
  const min = Number(raw.minScoredTokens);
  const timeout = Number(raw.detectorTimeoutMs);
  return {
    alpha: alpha > 0 && alpha < 1 ? alpha : DEFAULT_ALPHA,
    minScoredTokens: Number.isInteger(min) && min > 0 ? min : DEFAULT_MIN_SCORED_TOKENS,
    detectorTimeoutMs:
      Number.isInteger(timeout) && timeout >= 1000 ? timeout : DEFAULT_DETECTOR_TIMEOUT_MS
  };
}
