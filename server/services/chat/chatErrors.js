// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Map a failed chat turn onto the payload the chat client shows:
 * `{ message, code, details, isContextWindowError }`.
 *
 * Provider HTTP failures arrive as `LLMError`s whose message `ErrorHandler`
 * already localized; network faults and timeouts are translated here with the
 * same keys the chat UI has always used (`requestTimeout`,
 * `dnsResolutionFailed`, `connectionRefused`, `networkError`,
 * `responseStreamError`, `endpointUnreachable`).
 *
 * A failed model call also carries its cause (`chatFailureCause`), sent as
 * `failureCause` (not `cause`: on `run/ended` and a stored error, `cause` is
 * already who stopped an aborted turn): the
 * stable key the admin model test uses for the same failure
 * (`certificateUntrusted`, `serverError`, `apiKeyRequired`, …, see
 * `services/loop/llmFailureCause.js`) and the upstream HTTP status
 * (`upstreamStatus`). The chat client translates the key; the message stays the fallback for a client or a
 * cause it does not know.
 *
 * Who sees what: the cause key and the upstream status go to everyone, since
 * neither names anything internal. The host that was called and the socket or
 * certificate code (`host`, `errorCode`) go only to an administrator
 * (`isAdmin(user)`, decided by the caller as `revealEndpoint`), the one person
 * who can act on them; they are never stored with the message.
 *
 * @module services/chat/chatErrors
 */
import { isLLMError, LLM_ERROR_CODES } from '../loop/contracts/errors.js';
import { describeLlmFailure } from '../loop/llmFailureCause.js';
import { isDnsFailure } from '../../utils/dnsGuard.js';

/**
 * Failures that are not a fault of the model endpoint, or that the chat already
 * explains better than a connection cause could: what the user sent was too
 * long or refused, their usage limit is used up, the answer stopped midway.
 */
const CAUSELESS_CODES = Object.freeze(
  new Set([
    LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED,
    LLM_ERROR_CODES.QUOTA_EXCEEDED,
    LLM_ERROR_CODES.INVALID_REQUEST,
    LLM_ERROR_CODES.CONTENT_POLICY,
    LLM_ERROR_CODES.EMPTY_RESPONSE,
    LLM_ERROR_CODES.ABORTED
  ])
);

/** `LLMClient` provider codes the chat explains itself (a stalled stream is not a slow endpoint). */
const CAUSELESS_PROVIDER_CODES = Object.freeze(new Set(['STREAM_IDLE_TIMEOUT']));

/** The key `describeLlmFailure` returns when it recognized no cause. */
const UNKNOWN_CAUSE = 'testFailed';

/**
 * @typedef {Object} ChatFailureCause
 * @property {string} failureCause - Stable key, e.g. `certificateUntrusted`, `serverError`
 * @property {number} [upstreamStatus] - HTTP status the model endpoint answered with
 * @property {string} [host] - Host (and port) that was called; administrators only
 * @property {string} [errorCode] - Socket or certificate code; administrators only
 */

/**
 * The cause of a failed chat turn's model call, or null when the failure is not
 * one of the model endpoint (a tool error, a used-up quota, a too-long prompt)
 * or its cause is unknown.
 *
 * @param {unknown} err - What the turn failed with
 * @param {Object} [ctx]
 * @param {Object} [ctx.model] - The model of the turn; only the host of its `url` is used
 * @param {boolean} [ctx.keyless=false] - The model has no API key, so a 401/403
 *   means "the endpoint wants a key" (`apiKeyRequired`)
 * @param {boolean} [ctx.revealEndpoint=false] - Add `host` and `errorCode`; only
 *   for an administrator
 * @returns {ChatFailureCause|null}
 *
 * @example
 *   chatFailureCause(err, { model, revealEndpoint: isAdmin(user) })
 *   // → { failureCause: 'serverError', upstreamStatus: 502 } for a user,
 *   //   plus host: 'llm.example.com' for an admin
 */
export function chatFailureCause(err, { model, keyless = false, revealEndpoint = false } = {}) {
  if (!isLLMError(err)) return null;
  if (CAUSELESS_CODES.has(err.code) || CAUSELESS_PROVIDER_CODES.has(err.providerCode)) {
    return null;
  }
  const failure = describeLlmFailure(err, { url: model?.url, keyless });
  if (!failure.messageKey || failure.messageKey === UNKNOWN_CAUSE) return null;
  return {
    failureCause: failure.messageKey,
    ...(failure.upstreamStatus === null ? {} : { upstreamStatus: failure.upstreamStatus }),
    ...(revealEndpoint && failure.host ? { host: failure.host } : {}),
    ...(revealEndpoint && failure.errorCode ? { errorCode: failure.errorCode } : {})
  };
}

/** A number in the user's locale; plain digits for a locale Intl rejects. */
function formatNumber(value, language) {
  try {
    return Number(value).toLocaleString(language || 'en');
  } catch {
    return String(value);
  }
}

async function translate(getLocalizedError, key, params, language) {
  if (typeof getLocalizedError !== 'function') return null;
  try {
    const text = await getLocalizedError(key, params || {}, language);
    return text && !String(text).startsWith('Error:') ? text : null;
  } catch {
    return null;
  }
}

/**
 * @param {Error} err
 * @param {Object} ctx
 * @param {Object} [ctx.model]
 * @param {string} [ctx.language]
 * @param {Function} [ctx.getLocalizedError] - `(key, params, language) => Promise<string>`
 * @param {number} [ctx.timeoutMs]
 * @param {boolean} [ctx.keyless=false] - See {@link chatFailureCause}
 * @param {boolean} [ctx.revealEndpoint=false] - See {@link chatFailureCause}; only for an administrator
 * @returns {Promise<{message:string, code:string, details?:*, isContextWindowError:boolean,
 *   failure: ChatFailureCause|null}>}
 */
export async function describeChatError(
  err,
  { model, language, getLocalizedError, timeoutMs, keyless = false, revealEndpoint = false } = {}
) {
  const llm = isLLMError(err) ? err : null;
  const code = llm?.code || err?.code || 'UNKNOWN_ERROR';
  let message = err?.message || 'Unknown error';
  const details = llm?.details ?? err?.details ?? undefined;
  const isContextWindowError = !!llm?.isContextWindowError;
  const timeoutSeconds = Math.round((timeoutMs || 0) / 1000);
  const t = (key, params) => translate(getLocalizedError, key, params, language);

  if (llm?.code === LLM_ERROR_CODES.TIMEOUT && llm.providerCode === 'CONNECT_TIMEOUT') {
    // The endpoint never answered the connect: not "the model is slow".
    message =
      (await t('endpointUnreachable', { provider: model?.provider, model: model?.id })) || message;
  } else if (llm?.code === LLM_ERROR_CODES.TIMEOUT && llm.providerCode === 'STREAM_IDLE_TIMEOUT') {
    // The answer started arriving and then stopped: whatever was streamed is
    // already on screen, so say the answer is incomplete rather than blaming
    // the whole request on a timeout.
    message =
      (await t('streamStalled', { provider: model?.provider, model: model?.id })) || message;
  } else if (llm?.code === LLM_ERROR_CODES.TIMEOUT) {
    message = (await t('requestTimeout', { timeout: timeoutSeconds })) || message;
  } else if (llm?.code === LLM_ERROR_CODES.NETWORK) {
    const cause = err.cause || {};
    const causeCode = cause.code || cause.cause?.code;
    let key = 'networkError';
    let params = {
      provider: model?.provider,
      model: model?.id,
      error: cause.message || err.message
    };
    if (causeCode === 'UND_ERR_SOCKET' && model?.provider === 'iassistant-conversation') {
      key = 'responseStreamError';
      params = {
        error: 'iAssistant server closed connection. Check authentication and request format.'
      };
    } else if (llm.providerCode === 'DNS' || causeCode === 'ENOTFOUND' || isDnsFailure(cause)) {
      key = 'dnsResolutionFailed';
      params = {
        provider: model?.provider,
        model: model?.id,
        hostname: cause.hostname || cause.cause?.hostname || 'unknown'
      };
    } else if (causeCode === 'ECONNREFUSED') {
      key = 'connectionRefused';
      params = { provider: model?.provider, model: model?.id };
    } else if (causeCode === 'UND_ERR_CONNECT_TIMEOUT' || causeCode === 'ETIMEDOUT') {
      key = 'requestTimeout';
      params = { timeout: timeoutSeconds };
    }
    message = (await t(key, params)) || message;
  } else if (llm?.code === LLM_ERROR_CODES.QUOTA_EXCEEDED && details && details.scope !== 'check') {
    // A used-up usage limit: which budget, and when it resets, in the
    // user's language and the reset schedule's time zone.
    const windowKey =
      details.window === 'week'
        ? 'quotaWindowWeek'
        : details.window === 'month'
          ? 'quotaWindowMonth'
          : 'quotaWindowDay';
    let resetAt = details.resetAt;
    try {
      resetAt = new Date(details.resetAt).toLocaleString(language || 'en', {
        dateStyle: 'medium',
        timeStyle: 'short',
        ...(details.timezone ? { timeZone: details.timezone } : {})
      });
    } catch {
      /* keep the ISO time */
    }
    message =
      (await t(details.scope === 'model' ? 'quotaExceededModel' : 'quotaExceededAllModels', {
        window: (await t(windowKey, {})) || details.window,
        model: details.modelName || details.modelId,
        limit: formatNumber(details.limit, language),
        resetAt
      })) || message;
  } else if (!llm && err?.code) {
    // Tool-loop and preparation errors carry a translation key as their code.
    message = (await t(err.code, {})) || message;
  }

  const failure = chatFailureCause(err, { model, keyless, revealEndpoint });
  return { message, code, details, isContextWindowError, failure };
}
