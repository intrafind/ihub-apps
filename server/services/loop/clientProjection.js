// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the browser is sent of a run, and of a stored answer: what the chat
 * renders, not what the model wrote.
 *
 * A run's frames carry the call arguments as the model wrote them, the
 * preview of each result and the notes a compaction left for the model. A
 * document tool's arguments are the document — the markdown of a PDF, the
 * slides of a deck — and reached the browser up to three times per call
 * (`tool/started.args`, `step/completed.toolCalls[].arguments`, the stored
 * activity) for a row that shows 160 characters of it.
 *
 * Applied where frames leave for the browser — live delivery
 * (`RunStream`), ledger re-sync (`GET /api/runs/:runId/events?view=sse`,
 * chat resume) — and to stored messages a browser reads (`GET
 * /api/chats/:chatId`, a shared chat). Not applied for in-process sinks (the
 * `/v1` APIs) and the run log, which keep the full data.
 *
 * @module services/loop/clientProjection
 */

import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { displayDigest } from './findingsDigest.js';
import { previewToolArgs } from '../../../shared/run/toolActivity.js';
import { referenceRowSources } from '../../../shared/run/activitySourceRefs.js';

/**
 * A tool result as the chat uses it (`shared/run/toolActivity.js`): whether
 * a page read hit the per-turn cap. Nothing else of the preview is read.
 */
function clientResultPreview(preview) {
  return preview && typeof preview === 'object' && preview.limitReached === true
    ? { limitReached: true }
    : null;
}

/** A call record of `step/completed` without its arguments; the chat reads them from `tool/started`. */
function clientToolCall(call) {
  if (!call || typeof call !== 'object') return call;
  const { arguments: _args, metadata: _meta, ...rest } = call;
  return rest;
}

function withDisplayDigest(holder) {
  const shown = displayDigest(holder.digest);
  if (!shown) return holder;
  return {
    ...holder,
    digest: shown.digest,
    ...(shown.truncated || holder.digestTruncated === true ? { digestTruncated: true } : {})
  };
}

/**
 * An SSE v2 envelope as the browser is sent it; the input itself when
 * nothing of it is cut.
 *
 * @param {Object} envelope - `{ v, seq, runId, ts, type, data }`
 * @returns {Object}
 */
export function clientEnvelope(envelope) {
  const data = envelope?.data;
  if (!data || typeof data !== 'object') return envelope;
  switch (envelope.type) {
    case SSE_V2_EVENTS.TOOL_STARTED:
      // An MCP App view is handed the call's input (`ui/notifications/tool-input`).
      if (data.mcpApp) return envelope;
      return { ...envelope, data: { ...data, args: previewToolArgs(data.args) } };
    case SSE_V2_EVENTS.TOOL_COMPLETED:
      if (!('resultPreview' in data)) return envelope;
      return {
        ...envelope,
        data: { ...data, resultPreview: clientResultPreview(data.resultPreview) }
      };
    case SSE_V2_EVENTS.STEP_COMPLETED:
      if (!Array.isArray(data.toolCalls) || data.toolCalls.length === 0) return envelope;
      return { ...envelope, data: { ...data, toolCalls: data.toolCalls.map(clientToolCall) } };
    case SSE_V2_EVENTS.CONTEXT_COMPACTED:
      if (typeof data.digest !== 'string') return envelope;
      return { ...envelope, data: withDisplayDigest(data) };
    default:
      return envelope;
  }
}

function clientDetail(detail) {
  if (!detail || !Array.isArray(detail.values)) return detail;
  return {
    ...detail,
    values: detail.values.map(value => {
      if (!value || typeof value !== 'object' || !('full' in value)) return value;
      const { full: _full, ...rest } = value;
      return rest;
    })
  };
}

function clientToolItem(item) {
  if (!item || typeof item !== 'object') return item;
  let out = item;
  if (Array.isArray(item.details) && item.details.length > 0) {
    out = { ...out, details: item.details.map(clientDetail) };
  }
  if (typeof item.digest === 'string') out = withDisplayDigest(out);
  return out;
}

/**
 * A stored message as the browser is sent it: the activity rows without the
 * uncut argument values answers stored before they were dropped, the
 * compaction notes reduced to what a person reads, and each row source the
 * answer's sources already hold sent as a reference (the client fills it back
 * in, `shared/run/activitySourceRefs.js`).
 *
 * @param {Object} message - a stored message
 * @returns {Object}
 */
export function clientMessage(message) {
  const activity = message?.activity;
  const items = activity?.toolActivity?.items;
  if (!Array.isArray(items) || items.length === 0) return message;
  const projected = {
    ...activity,
    toolActivity: { ...activity.toolActivity, items: items.map(clientToolItem) }
  };
  return { ...message, activity: referenceRowSources(projected, message.sources) };
}

/**
 * @param {Array<Object>} messages - stored messages
 * @returns {Array<Object>}
 */
export function clientMessages(messages) {
  return Array.isArray(messages) ? messages.map(clientMessage) : messages;
}
