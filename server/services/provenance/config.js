/**
 * Effective EU AI Act transparency settings: `platform.aiTransparency` over
 * the shared defaults, gated by the `aiTransparency` feature flag.
 *
 * @module services/provenance/config
 */
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { resolveAiTransparency } from '../../../shared/aiTransparency.js';

export const AI_TRANSPARENCY_FEATURE = 'aiTransparency';

/**
 * Whether the transparency subsystem is on (feature flag, default on).
 * @returns {boolean}
 */
export function isAiTransparencyActive() {
  try {
    return isFeatureEnabled(AI_TRANSPARENCY_FEATURE, configCache.getFeatures());
  } catch {
    return true;
  }
}

/**
 * The resolved `platform.aiTransparency` section.
 * @param {Object} [platform] - platform config; defaults to the cached one
 * @returns {Object}
 */
export function getAiTransparencyConfig(platform) {
  const source = platform || configCache.getPlatform() || {};
  return resolveAiTransparency(source.aiTransparency);
}
