/**
 * Request helpers shared by the inference API routes (`/api/inference/v1`).
 *
 * @module routes/inference/shared
 */
import configCache from '../../configCache.js';
import { enhanceUserWithPermissions, isAnonymousAccessAllowed } from '../../utils/authorization.js';
import logger from '../../utils/logger.js';
import { InferenceApiError } from '../../services/inference/errors.js';

/** The platform's default language. */
export function platformLanguage() {
  return configCache.getPlatform()?.defaultLanguage || 'en';
}

/** The request language: `Accept-Language`, else the platform default. */
export function requestLanguage(req) {
  return req.headers['accept-language']?.split(',')[0] || platformLanguage();
}

/**
 * The acting principal with permissions. Without a signed-in caller — only
 * possible when the platform allows anonymous access — this is the anonymous
 * principal, so app permissions still apply.
 *
 * @param {import('express').Request} req
 * @returns {Object|null}
 */
export function apiUser(req) {
  if (req.user) return req.user;
  const platform = configCache.getPlatform() || {};
  if (!isAnonymousAccessAllowed(platform)) return null;
  try {
    return enhanceUserWithPermissions(null, platform.auth || {}, platform);
  } catch (error) {
    logger.warn('Could not resolve the anonymous principal', {
      component: 'InferenceApi',
      error: error.message
    });
    return null;
  }
}

/**
 * A number field from the body, or undefined when absent.
 *
 * @param {Object} body
 * @param {string} field
 * @param {{min?: number, max?: number, integer?: boolean}} [bounds]
 * @returns {number|undefined}
 * @throws {InferenceApiError}
 */
export function numberField(
  body,
  field,
  { min = -Infinity, max = Infinity, integer = false } = {}
) {
  const value = body?.[field];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    const range = `${Number.isFinite(min) ? ` >= ${min}` : ''}${Number.isFinite(max) ? ` <= ${max}` : ''}`;
    throw new InferenceApiError(
      400,
      'invalid_parameter',
      `${field} must be ${integer ? 'an integer' : 'a number'}${range}`,
      { param: field }
    );
  }
  return value;
}

/** Start an SSE response. */
export function startEventStream(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}
