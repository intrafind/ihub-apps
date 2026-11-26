// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One call to a watermark detector service (#3331). Three contracts:
 *
 * {@link callDetector}: iHub's own (a superset of vLLM's example `POST /detect`),
 * for keys held by iHub (`contentMarking.text.keyHolder: "ihub"`):
 *
 *   request  { text, tokenizer, algorithm, prf, context_width,
 *              keys: [{ key_id, key }] }              // key: safe integer
 *   response { num_scored_tokens, results: [{ key_id, p_value, score?, is_watermarked? }] }
 *
 * {@link callModelDetector}: the detection endpoint built into iFinder's if-vllm
 * model image (`POST /watermark/v1/detect`, next to the chat API), for keys held
 * by the model image (`keyHolder: "model"`). The image holds its keys; iHub sends
 * the text only and gets an uncorrected p-value per key file and algorithm:
 *
 *   request  { text }
 *   response { tokenizer, vllm_version, results: [{ key_label, algorithm, parameters,
 *              p_value, score, num_scored_tokens }] }
 *
 * {@link callGatewayDetector}: the detection endpoint of an iFinder Model Gateway
 * (`POST /v1/gateway/detections/text`), which asks the installation's detectors
 * and answers with a verdict:
 *
 *   request  { text }
 *   response { detection: { verdict, alpha, text_sha256, detected_at, gateway_version,
 *              schemes: [{ scheme, verdict, unclear_reasons, strongest_result?: {
 *              reported_by: [{ detector, key_label }], algorithm, p_value,
 *              num_scored_tokens }, evaluation?: { tests } }] } }
 *
 * `reported_by` names every detector that reported the strongest check (the gateway
 * counts a check several detectors report identically once); iHub names the key
 * file of the first.
 *
 * The `ihub` request carries every key, so: redirects are refused (one would
 * forward token and keys to another host), the target passes
 * {@link checkDetectorUrl} at call time, DNS is pinned to the addresses that
 * passed, the response is size-capped and schema-checked, and nothing but counts
 * and the URL is ever logged. The other calls get the same treatment, since they
 * carry a token and the text. A credential is optional (a detector on an
 * internal network may not ask for one): a `bearer` token, or an `oauth2` client
 * whose token iHub fetches and caches (client credentials); the model image's
 * endpoint gets the model's own API key, as the chat API does. When a credential
 * is referenced but cannot be read, nothing is sent. The calls go through
 * `httpFetch`, so `ssl.ignoreInvalidCertificates` + `ssl.domainWhitelist` and the
 * proxy apply.
 *
 * @module services/provenance/watermark/DetectorClient
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { httpFetch } from '../../../utils/httpConfig.js';
import { readBoundedBody } from '../../../utils/boundedBodyReader.js';
import { redactUrl, scrubSecrets } from '../../../utils/secretRedaction.js';
import { ServiceError } from '../../../utils/ServiceError.js';
import credentialService from '../../CredentialService.js';
import {
  ClientCredentialsTokenCache,
  clientCredentialsBody,
  credentialProfileAuth
} from '../../integrations/auth/ServiceAccountAuth.js';
import logger from '../../../utils/logger.js';
import { checkDetectorUrl, pinnedDetectorLookup } from './detectorUrlPolicy.js';

const COMPONENT = 'WatermarkDetector';

export const MAX_RESPONSE_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

/** OAuth2 tokens of detector credentials, until shortly before they expire. */
const tokenCache = new ClientCredentialsTokenCache();

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

/** The answer of the if-vllm image's `/watermark/v1/detect`; more fields may follow. */
const modelDetectorResponseSchema = z.object({
  // null as well as absent: a missing detail must not discard the results.
  tokenizer: z.string().max(300).nullish(),
  vllm_version: z.string().max(100).nullish(),
  results: z
    .array(
      z.object({
        key_label: z.string().max(255),
        algorithm: z.string().max(64),
        parameters: z.record(z.string(), z.unknown()),
        p_value: z.number().min(0).max(1),
        score: z.number().nullish(),
        num_scored_tokens: z.number().int().min(0)
      })
    )
    .max(1000)
});

const GATEWAY_VERDICTS = ['DETECTED', 'NOT_DETECTED', 'UNCLEAR'];

/** The part of the Model Gateway's `DetectTextResponseBody` iHub reads; more fields may follow. */
const gatewayResponseSchema = z.object({
  detection: z.object({
    verdict: z.enum(GATEWAY_VERDICTS),
    alpha: z.number().min(0).max(1),
    text_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    detected_at: z.string().max(64),
    gateway_version: z.string().max(100),
    schemes: z
      .array(
        z.object({
          scheme: z.string().max(64),
          verdict: z.enum(GATEWAY_VERDICTS),
          unclear_reasons: z.array(z.string().max(64)).max(10),
          strongest_result: z
            .object({
              reported_by: z
                .array(z.object({ detector: z.string().max(200), key_label: z.string().max(255) }))
                .min(1)
                .max(100),
              algorithm: z.string().max(64),
              p_value: z.number().min(0).max(1),
              num_scored_tokens: z.number().int().min(0)
            })
            .nullish(),
          // iHub shows no number of checks without it.
          evaluation: z.object({ tests: z.number().int().min(0) }).nullish()
        })
      )
      .max(20)
  })
});

function unreachable(message, details) {
  return new ServiceError('WATERMARK_DETECTOR_UNREACHABLE', message, details ? { details } : {});
}

function notConfigured(message) {
  return new ServiceError('WATERMARK_DETECTOR_NOT_CONFIGURED', message);
}

/** The cache key of a detector credential's token: a changed secret gets a new entry. */
function tokenCacheKey(credentialRef, profile) {
  return JSON.stringify([
    credentialRef,
    profile.tokenUrl,
    profile.clientId,
    profile.scope || '',
    createHash('sha256')
      .update(String(profile.clientSecret || ''))
      .digest('hex')
  ]);
}

/**
 * An OAuth2 client-credentials token for a detector credential. The request goes
 * to the addresses the token URL policy accepted (no second DNS answer), through
 * `httpFetch` (proxy, certificate whitelist), and stops with the detector call's
 * deadline. Cached per credential and secret, so a changed credential fetches anew.
 *
 * @param {string} credentialRef
 * @param {Object} profile - The resolved `oauth2` credential
 * @param {string[]} addresses - From {@link checkDetectorUrl}
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
function fetchToken(credentialRef, profile, addresses, signal) {
  return tokenCache.getToken(tokenCacheKey(credentialRef, profile), async () => {
    const body = clientCredentialsBody({
      clientId: profile.clientId,
      clientSecret: profile.clientSecret,
      scope: profile.scope,
      grantType: profile.grantType || 'client_credentials',
      refreshToken: profile.refreshToken
    });
    const res = await httpFetch(profile.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: body.toString(),
      signal,
      redirect: 'error',
      lookup: pinnedDetectorLookup(addresses)
    });
    if (!res.ok) throw new Error(`OAuth token request failed: ${res.status}`);
    const raw = await readBoundedBody(res, MAX_TOKEN_RESPONSE_BYTES, 'OAuth token response');
    return JSON.parse(raw.toString('utf8'));
  });
}

/** Forget cached detector tokens (tests, a credential change). */
export function clearDetectorTokens() {
  tokenCache.clear();
}

/**
 * The request headers of a detector credential, and the secrets they carry (for
 * scrubbing error messages). `bearer` (or an opaque `secret`) is sent as is; an
 * `oauth2` client gets a token from its token endpoint, which must pass the same
 * URL policy as a detector, and the token is cached until shortly before it
 * expires.
 *
 * @param {string|undefined} credentialRef
 * @param {{resolve?: Function, bearerToken?: string|null}} [options] - `bearerToken`: sent
 *   when no credential is referenced (a model's own API key)
 * @returns {Promise<{headers: Object<string, string>, secrets: string[], forget?: Function}>}
 *   `forget` drops a cached OAuth2 token the detector rejected
 * @throws {ServiceError} WATERMARK_DETECTOR_NOT_CONFIGURED | WATERMARK_DETECTOR_UNREACHABLE (`token`)
 */
async function credentialHeaders(credentialRef, { resolve, bearerToken, signal } = {}) {
  if (!credentialRef) {
    return bearerToken
      ? { headers: { Authorization: `Bearer ${bearerToken}` }, secrets: [bearerToken] }
      : { headers: {}, secrets: [] };
  }
  const profile = credentialService.tryResolve(credentialRef);
  // A referenced credential that cannot be read is a misconfiguration: never
  // fall back to an unauthenticated call the operator did not choose.
  if (!profile) throw notConfigured('The detector credential cannot be read');
  if (!['bearer', 'secret', 'oauth2'].includes(profile.type)) {
    throw notConfigured(
      `The detector credential must be a bearer token or an OAuth2 client, not "${profile.type}"`
    );
  }
  const headers = { ...credentialProfileAuth(profile).headers };
  let forget = () => {};
  if (profile.type === 'oauth2') {
    const check = await checkDetectorUrl(profile.tokenUrl, { resolve });
    if (!check.ok) {
      throw unreachable(`The token URL of the detector credential is refused: ${check.reason}`, {
        reason: 'token'
      });
    }
    try {
      const token = await fetchToken(credentialRef, profile, check.addresses, signal);
      headers.Authorization = `Bearer ${token}`;
      // A detector that rejects the token before it expires gets a new one next time.
      forget = () => tokenCache.invalidate(tokenCacheKey(credentialRef, profile), token);
    } catch (error) {
      logger.warn('Watermark detector token request failed', {
        component: COMPONENT,
        credentialRef,
        error: scrubSecrets(String(error?.message || error), [profile.clientSecret].filter(Boolean))
      });
      throw unreachable('The token for the detector credential could not be fetched', {
        reason: signal?.aborted ? 'timeout' : 'token'
      });
    }
  }
  const auth = { headers };
  const secrets = Object.values(auth.headers).filter(Boolean);
  if (profile.clientSecret) secrets.push(profile.clientSecret);
  return { headers: auth.headers, secrets, forget };
}

/**
 * POST a JSON body to a detector and parse the answer against a schema.
 *
 * @returns {Promise<{data: Object, status: number, latencyMs: number}>}
 */
async function postJson({
  url,
  credentialRef,
  bearerToken,
  body,
  schema,
  secrets: bodySecrets = [],
  logFields = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  resolve
}) {
  if (!url) throw notConfigured('No detector URL is configured');
  // One deadline for the whole call, the token request of an OAuth2 credential included.
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
    // The URL first: a refused detector gets no token request.
    const check = await checkDetectorUrl(url, { resolve });
    if (!check.ok) throw unreachable(check.reason, { reason: 'url_refused' });
    const auth = await credentialHeaders(credentialRef, {
      resolve,
      bearerToken,
      signal: controller.signal
    });
    const secrets = [...auth.secrets, ...bodySecrets];
    let res;
    try {
      res = await httpFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth.headers },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
        lookup: pinnedDetectorLookup(check.addresses)
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
        ...logFields
      });
      throw unreachable(`The watermark detector call failed (${reason})`, { reason });
    }
    if (res.status === 401 || res.status === 403) {
      auth.forget?.();
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
      parsed = schema.safeParse(JSON.parse(raw.toString('utf8')));
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
    return { data: parsed.data, status: res.status, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Call a detector of iHub's own contract (`keyHolder: "ihub"`).
 *
 * @param {Object} params
 * @param {string} params.url - Detector endpoint
 * @param {string} [params.credentialRef] - `bearer` or `oauth2` credential id
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
 *   (`details.reason`: `url_refused`, `token`, `unauthorized`, `http_error`, `timeout`,
 *   `network`, `redirect`, `too_large`, `bad_response`)
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
  timeoutMs,
  signal,
  resolve
}) {
  const { data, status, latencyMs } = await postJson({
    url,
    credentialRef,
    body: {
      text,
      tokenizer,
      algorithm,
      prf,
      context_width: contextWidth,
      keys: keys.map(entry => ({ key_id: entry.keyId, key: entry.key }))
    },
    schema: responseSchema,
    secrets: keys.map(entry => String(entry.key)),
    logFields: { keysSent: keys.length },
    timeoutMs,
    signal,
    resolve
  });
  logger.info('Watermark detector call', {
    component: COMPONENT,
    url: redactUrl(url),
    status,
    latencyMs,
    keysSent: keys.length,
    scoredTokens: data.num_scored_tokens
  });
  return {
    numScoredTokens: data.num_scored_tokens,
    latencyMs,
    results: data.results.map(item => ({
      keyId: item.key_id,
      pValue: item.p_value,
      ...(item.score !== undefined ? { score: item.score } : {})
    }))
  };
}

/**
 * Call the detection endpoint built into an if-vllm model image
 * (`keyHolder: "model"`). No key leaves iHub; the image holds its keys.
 *
 * @param {Object} params
 * @param {string} params.url - `https://<vllm>/watermark/v1/detect`
 * @param {string|null} [params.apiKey] - The model's API key (the image checks
 *   `VLLM_API_KEY` on this endpoint as on its chat API)
 * @param {string} params.text - Sent as given (no normalization: that changes tokens)
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.resolve] - DNS override for tests
 * @returns {Promise<{tokenizer: string, vllmVersion: string, latencyMs: number,
 *   checks: Array<{keyLabel: string, algorithm: string, parameters: Object, pValue: number,
 *   numScoredTokens: number}>}>} One uncorrected check per key file and algorithm
 * @throws {ServiceError} As {@link callDetector}
 */
export async function callModelDetector({ url, apiKey, text, timeoutMs, signal, resolve }) {
  const { data, status, latencyMs } = await postJson({
    url,
    bearerToken: apiKey,
    body: { text },
    schema: modelDetectorResponseSchema,
    timeoutMs,
    signal,
    resolve
  });
  logger.info('Watermark detector call', {
    component: COMPONENT,
    url: redactUrl(url),
    status,
    latencyMs,
    api: 'model',
    checks: data.results.length
  });
  return {
    tokenizer: data.tokenizer,
    vllmVersion: data.vllm_version,
    latencyMs,
    checks: data.results.map(result => ({
      keyLabel: result.key_label,
      algorithm: result.algorithm,
      parameters: result.parameters,
      pValue: result.p_value,
      numScoredTokens: result.num_scored_tokens
    }))
  };
}

/**
 * Call the detection endpoint of an iFinder Model Gateway
 * (`provenance.watermark.gatewayUrl`). No key leaves iHub.
 *
 * @param {Object} params
 * @param {string} params.url - `https://<gateway>/v1/gateway/detections/text`
 * @param {string} [params.credentialRef] - `bearer` or `oauth2` credential id
 * @param {string} params.text - Sent as given
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.resolve] - DNS override for tests
 * @returns {Promise<{verdict: string, alpha: number, textSha256: string, detectedAt: string,
 *   gatewayVersion: string, schemes: Array<{scheme: string, verdict: string, unclearReasons: string[],
 *   strongestResult?: {detector: string, keyLabel: string, reportedBy: Array<{detector: string,
 *   keyLabel: string}>, algorithm: string, pValue: number, numScoredTokens: number}}>,
 *   latencyMs: number}>} `detector` and `keyLabel` are those of the first reporter.
 * @throws {ServiceError} As {@link callDetector}; a gateway whose detectors all failed answers
 *   `503` (`http_error`).
 */
export async function callGatewayDetector({
  url,
  credentialRef,
  text,
  timeoutMs,
  signal,
  resolve
}) {
  const { data, status, latencyMs } = await postJson({
    url,
    credentialRef,
    body: { text },
    schema: gatewayResponseSchema,
    timeoutMs,
    signal,
    resolve
  });
  const detection = data.detection;
  logger.info('Watermark detector call', {
    component: COMPONENT,
    url: redactUrl(url),
    status,
    latencyMs,
    api: 'ifinder-model-gateway',
    verdict: detection.verdict
  });
  return {
    verdict: detection.verdict,
    alpha: detection.alpha,
    textSha256: detection.text_sha256,
    detectedAt: detection.detected_at,
    gatewayVersion: detection.gateway_version,
    latencyMs,
    schemes: detection.schemes.map(scheme => ({
      scheme: scheme.scheme,
      verdict: scheme.verdict,
      unclearReasons: scheme.unclear_reasons,
      ...(scheme.evaluation ? { tests: scheme.evaluation.tests } : {}),
      ...(scheme.strongest_result
        ? {
            strongestResult: {
              detector: scheme.strongest_result.reported_by[0].detector,
              keyLabel: scheme.strongest_result.reported_by[0].key_label,
              reportedBy: scheme.strongest_result.reported_by.map(reporter => ({
                detector: reporter.detector,
                keyLabel: reporter.key_label
              })),
              algorithm: scheme.strongest_result.algorithm,
              pValue: scheme.strongest_result.p_value,
              numScoredTokens: scheme.strongest_result.num_scored_tokens
            }
          }
        : {})
    }))
  };
}
