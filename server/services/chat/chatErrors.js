/**
 * Map a failed chat turn onto the payload the chat client shows:
 * `{ message, code, details, isContextWindowError }`.
 *
 * Provider HTTP failures arrive as `LLMError`s whose message `ErrorHandler`
 * already localized; network faults and timeouts are translated here with the
 * same keys the chat UI has always used (`requestTimeout`,
 * `dnsResolutionFailed`, `connectionRefused`, `networkError`,
 * `responseStreamError`).
 *
 * @module services/chat/chatErrors
 */
import { isLLMError, LLM_ERROR_CODES } from '../loop/contracts/errors.js';

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
 * @returns {Promise<{message:string, code:string, details?:*, isContextWindowError:boolean}>}
 */
export async function describeChatError(
  err,
  { model, language, getLocalizedError, timeoutMs } = {}
) {
  const llm = isLLMError(err) ? err : null;
  const code = llm?.code || err?.code || 'UNKNOWN_ERROR';
  let message = err?.message || 'Unknown error';
  const details = llm?.details ?? err?.details ?? undefined;
  const isContextWindowError = !!llm?.isContextWindowError;
  const timeoutSeconds = Math.round((timeoutMs || 0) / 1000);
  const t = (key, params) => translate(getLocalizedError, key, params, language);

  if (llm?.code === LLM_ERROR_CODES.TIMEOUT) {
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
    } else if (causeCode === 'ENOTFOUND') {
      key = 'dnsResolutionFailed';
      params = {
        provider: model?.provider,
        model: model?.id,
        hostname: cause.hostname || 'unknown'
      };
    } else if (causeCode === 'ECONNREFUSED') {
      key = 'connectionRefused';
      params = { provider: model?.provider, model: model?.id };
    } else if (causeCode === 'UND_ERR_CONNECT_TIMEOUT' || causeCode === 'ETIMEDOUT') {
      key = 'requestTimeout';
      params = { timeout: timeoutSeconds };
    }
    message = (await t(key, params)) || message;
  } else if (!llm && err?.code) {
    // Tool-loop and preparation errors carry a translation key as their code.
    message = (await t(err.code, {})) || message;
  }

  return { message, code, details, isContextWindowError };
}
