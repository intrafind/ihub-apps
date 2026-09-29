/**
 * HTTP surface of provenance: response headers for machine clients and the
 * guard that keeps watermarking server-owned (concept §8.1 hook 3/4).
 *
 * @module services/provenance/httpProvenance
 */
import logger from '../../utils/logger.js';
import { isAiTransparencyActive } from './config.js';
import { getInstallationUrl } from './installation.js';

/**
 * Request fields a caller could use to switch the text watermark off or
 * smuggle sampler parameters to the upstream server. The per-request
 * watermark setting comes only from the model configuration.
 */
export const WATERMARK_OVERRIDE_FIELDS = Object.freeze([
  'watermarking',
  'watermark',
  'watermark_config',
  'watermarkConfig',
  'extra_body',
  'extraBody',
  'vllm_xargs',
  'sampling_params'
]);

/**
 * Remove watermark overrides from a request body, in place.
 * @param {Object} body
 * @returns {string[]} the removed field names
 */
export function removeWatermarkOverrides(body) {
  if (!body || typeof body !== 'object') return [];
  const removed = [];
  for (const field of WATERMARK_OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      delete body[field];
      removed.push(field);
    }
  }
  return removed;
}

/**
 * Express middleware: strip watermark overrides from the JSON body.
 */
export function stripWatermarkOverrides(req, _res, next) {
  const removed = removeWatermarkOverrides(req.body);
  if (removed.length) {
    logger.warn('Ignored client watermark override fields', {
      component: 'Provenance',
      path: req.path,
      fields: removed
    });
  }
  next();
}

/**
 * `X-AI-Generated`, `X-AI-Provenance` (the signpost) and `X-AI-Content-Id`.
 * @param {import('express').Response} res
 * @param {Object|null} provenance
 */
export function setProvenanceHeaders(res, provenance) {
  if (!res || res.headersSent || !isAiTransparencyActive()) return;
  res.setHeader('X-AI-Generated', 'true');
  const url = getInstallationUrl();
  if (url) res.setHeader('X-AI-Provenance', `${url}/.well-known/ai-provenance`);
  if (provenance?.contentId) res.setHeader('X-AI-Content-Id', provenance.contentId);
}
