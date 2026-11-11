// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One call to a watermark detector service (#3331).
 *
 * Contract (a superset of vLLM's example `POST /detect`):
 *
 *   request  { text, tokenizer, algorithm, prf, context_width,
 *              keys: [{ key_id, key }] }              // key: safe integer
 *   response { num_scored_tokens, results: [{ key_id, p_value, score?, is_watermarked? }] }
 *
 * The request carries every key, so: a bearer token is required (nothing is sent
 * without one), redirects are refused (one would forward token and keys to
 * another host), the target passes {@link checkDetectorUrl} at call time, DNS is
 * pinned to the addresses that passed, the response is size-capped and
 * schema-checked, and nothing but counts and the URL is ever logged. The call
 * goes through `httpFetch`, so `ssl.ignoreInvalidCertificates` +
 * `ssl.domainWhitelist` and the proxy apply.
 *
 * @module services/provenance/watermark/DetectorClient
 */
import { z } from 'zod';
import { httpFetch } from '../../../utils/httpConfig.js';
import { createPinnedLookup } from '../../../utils/ssrfGuard.js';
import { readBoundedBody } from '../../../utils/boundedBodyReader.js';
import { redactUrl, scrubSecrets } from '../../../utils/secretRedaction.js';
import { ServiceError } from '../../../utils/ServiceError.js';
import credentialService from '../../CredentialService.js';
import logger from '../../../utils/logger.js';
import { checkDetectorUrl } from './detectorUrlPolicy.js';

const COMPONENT = 'WatermarkDetector';

export const MAX_RESPONSE_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;

const responseSchema = z.object({
  num_scored_tokens: z.number().int().min(0),
  results: z
    .array(
      z.object({
        key_id: z.string().max(100),
        p_value: z.number().min(0).max(1),
        score: z.number().optional(),
        is_watermarked: z.boolean().optional()
      })
    )
    .max(1000)
});

function unreachable(message, details) {
  return new ServiceError('WATERMARK_DETECTOR_UNREACHABLE', message, details ? { details } : {});
}

/**
 * @param {Object} params
 * @param {string} params.url - Detector endpoint
 * @param {string} [params.credentialRef] - `bearer` credential id
 * @param {string} params.text - Sent as given (no normalization: that changes tokens)
 * @param {Array<{keyId: string, key: number}>} params.keys - Active first
 * @param {string} params.tokenizer
 * @param {string} [params.algorithm]
 * @param {string} [params.prf]
 * @param {number} [params.contextWidth]
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.resolve] - DNS override for tests
 * @returns {Promise<{numScoredTokens: number, results: Array<{keyId: string, pValue: number, score?: number}>, latencyMs: number}>}
 * @throws {ServiceError} WATERMARK_DETECTOR_NOT_CONFIGURED | WATERMARK_DETECTOR_UNREACHABLE
 *   (`details.reason`: `url_refused`, `unauthorized`, `http_error`, `timeout`, `network`,
 *   `redirect`, `too_large`, `bad_response`)
 */
export async function callDetector({
  url,
  credentialRef,
  text,
  keys,
  tokenizer,
  algorithm = 'gumbel',
  prf = 'philox',
  contextWidth = 4,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  resolve
}) {
  const token = credentialRef ? credentialService.tryResolveSecret(credentialRef) : undefined;
  if (!url || !token) {
    // Keys never go out unauthenticated, and not before a target is configured.
    throw new ServiceError(
      'WATERMARK_DETECTOR_NOT_CONFIGURED',
      'A detector URL and a bearer credential are required'
    );
  }
  const check = await checkDetectorUrl(url, { resolve });
  if (!check.ok) throw unreachable(check.reason, { reason: 'url_refused' });

  const secrets = [token, ...keys.map(entry => String(entry.key))];
  const body = JSON.stringify({
    text,
    tokenizer,
    algorithm,
    prf,
    context_width: contextWidth,
    keys: keys.map(entry => ({ key_id: entry.keyId, key: entry.key }))
  });
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const safeUrl = redactUrl(url);
  try {
    let res;
    try {
      res = await httpFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body,
        signal: controller.signal,
        redirect: 'error',
        lookup: createPinnedLookup(check.addresses, { allowPrivate: true })
      });
    } catch (error) {
      const message = scrubSecrets(String(error?.message || error), secrets);
      let reason = 'network';
      if (controller.signal.aborted) reason = 'timeout';
      else if (error?.type === 'no-redirect' || /redirect/i.test(message)) reason = 'redirect';
      logger.warn('Watermark detector call failed', {
        component: COMPONENT,
        url: safeUrl,
        reason,
        keysSent: keys.length
      });
      throw unreachable(`The watermark detector call failed (${reason})`, { reason });
    }
    if (res.status === 401 || res.status === 403) {
      throw unreachable('The watermark detector refused the credential', {
        reason: 'unauthorized',
        status: res.status
      });
    }
    if (!res.ok) {
      throw unreachable(`The watermark detector answered ${res.status}`, {
        reason: 'http_error',
        status: res.status
      });
    }
    let parsed;
    try {
      const raw = await readBoundedBody(res, MAX_RESPONSE_BYTES, 'Watermark detector response');
      parsed = responseSchema.safeParse(JSON.parse(raw.toString('utf8')));
    } catch (error) {
      const tooLarge = /limit/.test(String(error?.message));
      throw unreachable(
        tooLarge
          ? 'The watermark detector response is too large'
          : 'The watermark detector answered with invalid JSON',
        { reason: tooLarge ? 'too_large' : 'bad_response' }
      );
    }
    if (!parsed.success) {
      throw unreachable('The watermark detector response does not match the contract', {
        reason: 'bad_response'
      });
    }
    const latencyMs = Date.now() - started;
    logger.info('Watermark detector call', {
      component: COMPONENT,
      url: safeUrl,
      status: res.status,
      latencyMs,
      keysSent: keys.length,
      scoredTokens: parsed.data.num_scored_tokens
    });
    return {
      numScoredTokens: parsed.data.num_scored_tokens,
      latencyMs,
      results: parsed.data.results.map(item => ({
        keyId: item.key_id,
        pValue: item.p_value,
        ...(item.score !== undefined ? { score: item.score } : {})
      }))
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
