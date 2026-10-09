/**
 * Requiring a tool call: `policies.tools.choice`.
 *
 * A model with tools available decides for itself whether to use them, and
 * some answer from memory when the app wanted them to look something up. The
 * loop can ask the provider to make a call mandatory (`tool_choice: required`,
 * Anthropic `any`, Gemini `ANY`, Bedrock `any`) — but only for the first model
 * call of a turn. A mandatory call on every round could never end in an
 * answer: the model has to be free to write one once it has its tool results.
 * "The first call has to trigger the tool and the rest follows" is exactly the
 * shape of a turn with `choice: 'required'`.
 *
 * Not every model can be forced. Anthropic's newest models (Opus 5.5, Sonnet
 * 5.5, Fable 5.1) reject `any` outright, and so does extended thinking; a local
 * server may ignore or refuse the field. For those the loop says it in words
 * instead: a one-off instruction after the conversation on the first round. A
 * model is known not to take it unless its config says `supportsTools:
 * "required"`, or when the provider rejected the field during this process's
 * lifetime (remembered for a while, as for native web search).
 *
 * @module services/loop/toolChoice
 */

import { modelCanRequireToolUse } from '../../../shared/modelCapabilities.js';

/** Values of `policies.tools.choice` (and of an app's `toolChoice`). */
export const TOOL_CHOICES = Object.freeze(['auto', 'required']);

/** How long a model's refusal of a forced tool call is remembered. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const TOOL_CHOICE_PATTERN =
  /tool[\s_-]?choice|forced tool use|function[\s_-]?calling[\s_-]?config/i;
const REJECTION_STATUSES = new Set([400, 422]);

/**
 * What the model is told on the first round when the provider cannot be made
 * to call a tool. Shown to the model only for that call, not kept in the
 * transcript.
 */
export const REQUIRE_TOOL_NUDGE =
  'Before you answer, call one of the available tools to work on this request. Use the most suitable tool now, then answer from its result.';

/** No forcing and no instruction. */
const NO_PLAN = Object.freeze({ force: false, nudge: null });

/** @type {Map<string, {until: number, reason: string|null}>} */
const unavailable = new Map();

function errorText(err) {
  const parts = [err.message];
  const details = err.details;
  if (typeof details === 'string') parts.push(details);
  else if (details && typeof details === 'object') {
    try {
      parts.push(JSON.stringify(details));
    } catch {
      // unserializable details carry nothing to match on
    }
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * Whether an LLM error is the provider refusing a tool choice (a client error
 * whose message or body names it), as opposed to any other bad request.
 * @param {Error & {status?: number, details?: any}} err
 * @returns {boolean}
 */
export function isToolChoiceRejection(err) {
  if (!err || typeof err !== 'object') return false;
  if (!REJECTION_STATUSES.has(err.status)) return false;
  return TOOL_CHOICE_PATTERN.test(errorText(err));
}

/**
 * Remember that a model refused a forced tool call.
 * @param {string} modelId
 * @param {{reason?: string|null, ttlMs?: number, now?: number}} [options]
 */
export function markForcedToolUseUnavailable(
  modelId,
  { reason = null, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}
) {
  if (!modelId) return;
  unavailable.set(modelId, { until: now + ttlMs, reason });
}

/**
 * Whether a model recently refused a forced tool call (entries expire).
 * @param {string} modelId
 * @param {number} [now]
 * @returns {boolean}
 */
export function isForcedToolUseUnavailable(modelId, now = Date.now()) {
  const entry = unavailable.get(modelId);
  if (!entry) return false;
  if (entry.until <= now) {
    unavailable.delete(modelId);
    return false;
  }
  return true;
}

/** Forget every remembered refusal (tests, config reloads). */
export function clearToolChoiceMemo() {
  unavailable.clear();
}

/**
 * Whether the conversation already holds a tool call made after the last
 * message the person wrote — a turn that resumed after a pause (the model asked
 * a question, the person answered) has had its first call already. Loop-made
 * `_nudge` and `_steer` messages are not the person's.
 * @param {Object[]} messages - generic (OpenAI-shaped) transcript
 * @returns {boolean}
 */
export function turnHasToolCalls(messages) {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'user' && !message._nudge && !message._steer) return false;
    if (message.role === 'tool') return true;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (message.tool_calls.length > 0) return true;
    }
  }
  return false;
}

/**
 * Decide, for one model call, whether to force a tool call or say so in words.
 *
 * @param {Object} args
 * @param {string} [args.choice] - `policies.tools.choice`
 * @param {Object[]|undefined} args.offeredTools - tools offered on this call
 * @param {number} args.iteration - 1 for the first model call of the segment
 * @param {boolean} [args.priorToolUse] - the turn already holds a tool call (see {@link turnHasToolCalls})
 * @param {Object} [args.model] - resolved model config
 * @param {boolean} [args.forcedRejected] - the provider already refused a forced call during this run
 * @returns {{force: boolean, nudge: string|null}} `force`: send `toolChoice: 'required'`;
 *   `nudge`: append this instruction to the messages of this call only
 */
export function planToolChoice({
  choice,
  offeredTools,
  iteration,
  priorToolUse,
  model,
  forcedRejected
}) {
  if (choice !== 'required') return NO_PLAN;
  if (!Array.isArray(offeredTools) || offeredTools.length === 0) return NO_PLAN;
  if (iteration > 1 || priorToolUse) return NO_PLAN;
  if (forcedRejected || !modelCanRequireToolUse(model) || isForcedToolUseUnavailable(model?.id)) {
    return { force: false, nudge: REQUIRE_TOOL_NUDGE };
  }
  return { force: true, nudge: null };
}
