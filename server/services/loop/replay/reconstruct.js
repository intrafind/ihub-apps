/**
 * T5 — request reconstruction check (report-only).
 *
 * The ledger records, per LLM call, the model-visible messages (on `initial`
 * and `change`), the tool schemas, the call configuration and a hash of the
 * exact provider request body that was sent. This module rebuilds the request
 * from the ledger through the same adapter and compares hashes, proving the
 * ledger is complete enough to reproduce what the model saw.
 *
 * It never sends anything and never throws for a mismatch — it returns a
 * report the caller (a test, an admin diagnostic, CI) decides about.
 *
 * @module services/loop/replay/reconstruct
 */
import { createCompletionRequest } from '../../../adapters/index.js';
import { hashPayload } from '../RunLog.js';
import { RUN_LOG_EVENTS } from '../../../../shared/runEvents.js';

const REDACTED_KEY = 'REDACTED';

/**
 * Rebuild the adapter options from a recorded `callConfig`.
 * @param {Object} callConfig
 * @param {Object} [extra] - { tools, responseSchema }
 * @returns {Object}
 */
export function optionsFromCallConfig(callConfig = {}, { tools, responseSchema } = {}) {
  const options = {};
  if (typeof callConfig.temperature === 'number') options.temperature = callConfig.temperature;
  if (Number.isInteger(callConfig.maxTokens)) options.maxTokens = callConfig.maxTokens;
  if (callConfig.responseFormat) options.responseFormat = callConfig.responseFormat;
  if (responseSchema) options.responseSchema = responseSchema;
  if (callConfig.toolChoice !== undefined) options.toolChoice = callConfig.toolChoice;
  if (callConfig.nativeWebSearch) options.nativeWebSearch = callConfig.nativeWebSearch;
  if (callConfig.thinking) Object.assign(options, callConfig.thinking);
  options.stream = callConfig.stream !== false;
  if (tools) options.tools = tools;
  return options;
}

/**
 * Verify every `request/header` event of a run can be reconstructed.
 *
 * @param {Array} events - ledger events of one run (ordered by seq)
 * @param {Object} opts
 * @param {(modelId: string) => Object|null} opts.findModel - model catalog lookup
 * @param {Function} [opts.createRequest] - adapter request builder (default: registry)
 * @param {(model: Object) => Promise<string>|string} [opts.resolveApiKey] - key used for the
 *   rebuild; defaults to a redacted constant (keys never enter request bodies)
 * @returns {Promise<{runId: string|null, checked: number, matched: number,
 *   mismatched: Array, skipped: Array, ok: boolean}>}
 */
export async function verifyRequestReconstruction(
  events,
  { findModel, createRequest = createCompletionRequest, resolveApiKey } = {}
) {
  const report = {
    runId: events[0]?.runId ?? null,
    checked: 0,
    matched: 0,
    mismatched: [],
    skipped: [],
    ok: true
  };
  let lastMessages = null;
  let lastTools = null;
  let lastSchema = null;
  let lastModelSnapshot = null;
  let lastOptionsSnapshot = null;

  for (const event of events) {
    if (event.type !== RUN_LOG_EVENTS.REQUEST_HEADER) continue;
    const data = event.data || {};
    if (Array.isArray(data.messages)) lastMessages = data.messages;
    else if (Array.isArray(data.messagesDelta)) {
      lastMessages = [...(lastMessages || []), ...data.messagesDelta];
    }
    if (Array.isArray(data.toolSchemas)) lastTools = data.toolSchemas;
    else if (data.toolSchemasHash === null) lastTools = null;
    // Everything recorded "on change" is tracked before any verdict on this
    // header, so a header that fails does not hide what later ones rely on.
    const callConfig = data.callConfig || {};
    if (callConfig.responseSchema) lastSchema = callConfig.responseSchema;
    if (data.modelSnapshot) lastModelSnapshot = data.modelSnapshot;
    if (data.optionsSnapshot) lastOptionsSnapshot = data.optionsSnapshot;

    const skip = reason => {
      report.skipped.push({ seq: event.seq, requestId: data.requestId, reason });
    };
    if (!lastMessages) {
      skip('no messages recorded before this request');
      continue;
    }
    if (data.messagesHash) {
      const replayed = hashPayload(lastMessages);
      if (replayed !== data.messagesHash) {
        // The replayed context is not what the model saw: a tampered or
        // truncated ledger, reported like any other mismatch.
        report.checked += 1;
        report.mismatched.push({
          seq: event.seq,
          requestId: data.requestId,
          expected: data.messagesHash,
          actual: replayed,
          reason: data.reason,
          field: 'messages'
        });
        continue;
      }
    }
    if (data.configHash && !lastModelSnapshot) {
      skip('model / options snapshot not recorded before this request');
      continue;
    }
    let responseSchema;
    if (callConfig.responseSchemaHash) {
      if (!lastSchema || hashPayload(lastSchema) !== callConfig.responseSchemaHash) {
        skip('response schema changed without being recorded');
        continue;
      }
      responseSchema = lastSchema;
    }
    if (lastTools && data.toolSchemasHash && hashPayload(lastTools) !== data.toolSchemasHash) {
      skip('tool schemas changed without being recorded');
      continue;
    }
    // The recorded snapshot is authoritative: the request is rebuilt from the
    // model as it was, not from the current catalog. Older ledgers without a
    // snapshot fall back to the catalog lookup.
    const model = lastModelSnapshot || (findModel ? findModel(data.model) : null);
    if (!model) {
      skip(`model ${data.model} not in catalog`);
      continue;
    }

    report.checked += 1;
    try {
      const apiKey = resolveApiKey ? await resolveApiKey(model) : REDACTED_KEY;
      const options = lastOptionsSnapshot
        ? {
            ...lastOptionsSnapshot,
            ...(lastTools ? { tools: lastTools } : {}),
            ...(responseSchema ? { responseSchema } : {})
          }
        : optionsFromCallConfig(callConfig, { tools: lastTools || undefined, responseSchema });
      const rebuilt = await createRequest(model, lastMessages, apiKey, options);
      const actual = hashPayload(rebuilt?.body ?? {});
      if (actual === data.requestHash) {
        report.matched += 1;
      } else {
        report.mismatched.push({
          seq: event.seq,
          requestId: data.requestId,
          expected: data.requestHash,
          actual,
          reason: data.reason
        });
      }
    } catch (err) {
      report.mismatched.push({
        seq: event.seq,
        requestId: data.requestId,
        expected: data.requestHash,
        actual: null,
        error: err.message
      });
    }
  }
  report.ok = report.mismatched.length === 0;
  return report;
}

/**
 * Convenience: read a run from the ledger and verify it.
 * @param {import('../RunLog.js').RunLog} runLog
 * @param {string} runId
 * @param {Object} opts - see verifyRequestReconstruction
 */
export async function verifyRunReconstruction(runLog, runId, opts) {
  const events = await runLog.readEvents(runId);
  return verifyRequestReconstruction(events, opts);
}

export default verifyRequestReconstruction;
