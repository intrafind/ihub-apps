// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Usage call records (event schema v2): one record per model call, written by
 * `LLMClient` for every surface. Pure functions only — the identity and I/O
 * live in usageRecorder.js.
 *
 * Keys: `v` schema version, `ts` end time, `type` (`llm_call` | `feedback`),
 * `surf` surface, `uid` user (by tracking mode), `grp` groups at call time,
 * `app`, `model`, `prov`, `cid` conversation / run, `rid` request id,
 * `pt`/`ct` prompt/completion tokens (`pt` includes cached tokens),
 * `cr`/`cw` cache read/write, `rt` reasoning, `ws` provider web searches,
 * `src` provider|estimate, `st` outcome, `err` normalized error code,
 * `lat`/`ttft` total ms and time to first token, `tc` tool calls.
 *
 * @module services/usage/callRecord
 */

export const USAGE_SCHEMA_VERSION = 2;

/** Where a call came from. */
export const SURFACES = Object.freeze([
  'chat',
  'agent',
  'workflow',
  'task',
  'api',
  'magic',
  'system'
]);

/** How a call ended. */
export const OUTCOMES = Object.freeze(['ok', 'error', 'aborted', 'quota', 'rate_limited']);

/** Groups every signed-in (or every) user has; they say nothing about a department. */
const IMPLICIT_GROUPS = new Set(['authenticated', 'anonymous']);

/** Run-ledger kind → surface. */
const KIND_SURFACE = {
  chat: 'chat',
  subagent: 'chat',
  agent: 'agent',
  workflow: 'workflow',
  inference: 'api'
};

/**
 * The surface of a call: what the caller said, otherwise what its run on the
 * ledger is (a scheduled run is a task whatever ran it), otherwise `system`.
 *
 * @param {Object} [telemetry] - the call's telemetry (`surface`, `purpose`, `kind`)
 * @param {Object|null} [runMeta] - `runLog.getRunMeta(runId)`
 * @returns {string}
 */
export function resolveSurface(telemetry = {}, runMeta = null) {
  if (SURFACES.includes(telemetry.surface)) return telemetry.surface;
  if (telemetry.purpose === 'magic-prompt') return 'magic';
  const trigger = runMeta?.trigger || telemetry.trigger;
  if (trigger?.type === 'schedule') return 'task';
  const kind = runMeta?.kind || telemetry.kind;
  return KIND_SURFACE[kind] || 'system';
}

/**
 * The outcome of a call from the error it ended with (none: `ok`).
 * @param {Error|null} err - an LLMError (or anything with a `code`)
 * @param {{aborted?: boolean}} [opts]
 * @returns {string}
 */
export function outcomeOf(err, { aborted = false } = {}) {
  if (!err) return aborted ? 'aborted' : 'ok';
  switch (err.code) {
    case 'QUOTA_EXCEEDED':
      return 'quota';
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'ABORTED':
      return 'aborted';
    default:
      return err.name === 'AbortError' ? 'aborted' : 'error';
  }
}

/**
 * A normalized error code: the LLMError code, never a message.
 * @param {Error|null} err
 * @returns {string|null}
 */
export function errorCodeOf(err) {
  if (!err) return null;
  const code = typeof err.code === 'string' ? err.code : null;
  if (code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  return err.name === 'AbortError' ? 'ABORTED' : 'UNKNOWN';
}

/**
 * The groups a call is reported under: the user's groups as they are now,
 * without the implicit ones.
 * @param {Object|null} user
 * @returns {string[]}
 */
export function reportGroupsOf(user) {
  const groups = Array.isArray(user?.groups) ? user.groups : [];
  return [...new Set(groups.filter(g => typeof g === 'string' && g && !IMPLICIT_GROUPS.has(g)))];
}

function count(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/**
 * Build one `llm_call` record. `uid` and `cid` are passed in already resolved
 * for the tracking mode.
 *
 * @param {Object} call
 * @param {string} [call.ts]
 * @param {string} call.surface
 * @param {string|null} call.uid
 * @param {string[]} [call.groups]
 * @param {string|null} call.appId
 * @param {string} call.modelId
 * @param {string|null} call.provider
 * @param {string|null} [call.conversationId]
 * @param {string|null} [call.requestId]
 * @param {Object|null} call.usage - normalized usage (`source` provider|estimate)
 * @param {string} call.outcome
 * @param {string|null} [call.errorCode]
 * @param {number} [call.latencyMs]
 * @param {number|null} [call.ttftMs]
 * @param {number} [call.toolCalls]
 * @returns {Object}
 */
export function buildCallRecord(call) {
  const usage = call.usage || {};
  const record = {
    v: USAGE_SCHEMA_VERSION,
    ts: call.ts || new Date().toISOString(),
    type: 'llm_call',
    surf: SURFACES.includes(call.surface) ? call.surface : 'system',
    st: OUTCOMES.includes(call.outcome) ? call.outcome : 'error',
    pt: count(usage.promptTokens) || 0,
    ct: count(usage.completionTokens) || 0,
    src: usage.source === 'estimate' || !call.usage ? 'estimate' : 'provider'
  };
  if (call.uid) record.uid = String(call.uid);
  const groups = (call.groups || []).filter(Boolean);
  if (groups.length) record.grp = groups;
  if (call.appId) record.app = String(call.appId);
  if (call.modelId) record.model = String(call.modelId);
  if (call.provider) record.prov = String(call.provider);
  if (call.conversationId) record.cid = String(call.conversationId);
  if (call.requestId) record.rid = String(call.requestId);
  for (const [key, field] of [
    ['cr', 'cacheReadTokens'],
    ['cw', 'cacheWriteTokens'],
    ['rt', 'reasoningTokens'],
    ['ws', 'webSearchRequests']
  ]) {
    const value = count(usage[field]);
    if (value !== undefined) record[key] = value;
  }
  if (call.errorCode) record.err = call.errorCode;
  const lat = count(call.latencyMs);
  if (lat !== undefined) record.lat = lat;
  const ttft = count(call.ttftMs);
  if (ttft !== undefined) record.ttft = ttft;
  record.tc = count(call.toolCalls) || 0;
  return record;
}

/**
 * Build one `feedback` record.
 * @param {{uid: string|null, groups?: string[], appId?: string, modelId?: string,
 *   conversationId?: string, rating: number|string}} fb
 * @returns {Object}
 */
export function buildFeedbackRecord(fb) {
  const record = {
    v: USAGE_SCHEMA_VERSION,
    ts: fb.ts || new Date().toISOString(),
    type: 'feedback'
  };
  if (fb.uid) record.uid = String(fb.uid);
  const groups = (fb.groups || []).filter(Boolean);
  if (groups.length) record.grp = groups;
  if (fb.appId) record.app = String(fb.appId);
  if (fb.modelId) record.model = String(fb.modelId);
  if (fb.conversationId) record.cid = String(fb.conversationId);
  record.rating = fb.rating;
  return record;
}
