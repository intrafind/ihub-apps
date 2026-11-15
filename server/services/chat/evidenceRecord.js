// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Build the evidence record of a turn from its run journal (#3687,
 * `docs/chat-evidence.md`).
 *
 * The journal (`RunLog.readEvents`) already holds what every model call was
 * sent: each `request/header` carries the messages in full (`initial`,
 * `change`), as the messages added since the previous header (`append`) or
 * not at all (`same`), plus the tool definitions and the call configuration
 * when they change. This module replays those headers into the exact message
 * list of every call and folds them, the tool calls and their results into one
 * record. Every piece of content becomes an item (its canonical JSON, keyed by
 * SHA-256) that `ChatEvidenceRepository` stores once per chat; the record
 * names items as `sha256:<hex>`.
 *
 * Documents and pictures stored as chat files are already references in the
 * journal (`ledgerMessages.js`); they are listed on the message as `files`
 * and not copied.
 *
 * The record is built for a normal end and for crash recovery alike, so
 * `run/end` may be missing: status, finish reason and usage come from the
 * turn's summary, and `journalEnded` says whether the journal had its end.
 *
 * @module services/chat/evidenceRecord
 */
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import configCache from '../../configCache.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import logger from '../../utils/logger.js';
import { isAnonymousUser } from '../loop/runIdentity.js';
import { chatEvidenceSettings } from './chatPersistence.js';
import { contentItem, getChatEvidenceRepository, sha256Hex } from './ChatEvidenceRepository.js';

/** Version of the record shape. */
export const EVIDENCE_VERSION = 1;

/** A document reference tag as `ledgerMessages.js` writes it. */
const DOCUMENT_REF_TAG = /<content\b[^>]*\btext_sha256="[a-f0-9]{64}"[^>]*\/>/g;

/**
 * Collects items and hands out their references. One per build, so a message
 * object replayed into many calls is serialized and hashed once.
 */
class ItemCollector {
  constructor() {
    /** @type {Map<string, string>} sha256 → canonical JSON */
    this.items = new Map();
    this._refs = new WeakMap();
  }

  /**
   * Store a value as an item.
   *
   * @param {any} value
   * @returns {string} `sha256:<hex>`
   */
  ref(value) {
    const cacheable = value !== null && typeof value === 'object';
    if (cacheable && this._refs.has(value)) return this._refs.get(value);
    const { sha256, text } = contentItem(value);
    this.items.set(sha256, text);
    const ref = `sha256:${sha256}`;
    if (cacheable) this._refs.set(value, ref);
    return ref;
  }
}

/**
 * The chat files a ledger message refers to: pictures and pages
 * (`imageData` entries with a `fileId`) and documents (reference tags).
 *
 * @param {Object} message - Ledger copy of a message.
 * @returns {Array<Object>}
 */
export function filesOfMessage(message) {
  const files = [];
  const images = Array.isArray(message?.imageData)
    ? message.imageData
    : message?.imageData
      ? [message.imageData]
      : [];
  for (const image of images) {
    if (!image?.fileId || typeof image.sha256 !== 'string') continue;
    files.push({
      fileId: image.fileId,
      sha256: image.sha256,
      bytes: image.bytes,
      ...(image.page !== undefined ? { page: image.page } : {})
    });
  }
  const texts =
    typeof message?.content === 'string'
      ? [message.content]
      : Array.isArray(message?.content)
        ? message.content.map(part => part?.text).filter(text => typeof text === 'string')
        : [];
  for (const text of texts) {
    for (const tag of text.match(DOCUMENT_REF_TAG) || []) {
      const fileId = /\bid="([^"]*)"/.exec(tag)?.[1];
      const sha256 = /\btext_sha256="([a-f0-9]{64})"/.exec(tag)[1];
      const chars = Number(/\bchars="(\d+)"/.exec(tag)?.[1]);
      if (!fileId) continue;
      files.push({ fileId, textSha256: sha256, ...(Number.isFinite(chars) ? { chars } : {}) });
    }
  }
  return files;
}

/** Drop undefined and null members. */
function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== null)
  );
}

/**
 * The model settings a call ran with, from its call configuration and the
 * adapter options snapshot.
 */
function modelSettings(callConfig = {}, optionsSnapshot = {}) {
  return compact({
    temperature: optionsSnapshot.temperature,
    maxTokens: callConfig.maxTokens ?? optionsSnapshot.maxTokens,
    thinking: callConfig.thinking,
    responseFormat: callConfig.responseFormat,
    toolChoice: callConfig.toolChoice
  });
}

/**
 * The SHA-256 of the app configuration as it is in force now — the record is
 * built when the answer is stored, which is the closest point to the run.
 *
 * @param {string|null} appId
 * @returns {string|null}
 */
function appConfigSha256(appId) {
  if (!appId) return null;
  try {
    const app = (configCache.getApps?.(true)?.data || []).find(entry => entry?.id === appId);
    return app ? contentItem(app).sha256 : null;
  } catch {
    return null;
  }
}

/**
 * Build a turn's evidence record from its journal.
 *
 * @param {Object} params
 * @param {Object} params.runLog - The RunLog (`readEvents`, `readSpill`).
 * @param {string} params.runId - The turn's run.
 * @param {Object} [params.summary] - The turn outcome (`status`, `content`,
 *   `finishReason`, `usage`, `provenance`).
 * @param {string} [params.chatId] - The chat, for a chat record.
 * @param {string} [params.messageId] - The stored answer's id, for a chat record.
 * @param {string} [params.appId] - The app; defaults to the run's `refs.appId`.
 * @param {Array<Object>} [params.artifacts] - Stored artifact descriptors of the answer.
 * @returns {Promise<{record: Object, items: Map<string, string>}>}
 */
export async function buildEvidence({
  runLog,
  runId,
  summary = {},
  chatId,
  messageId,
  appId,
  artifacts = []
}) {
  const events = await runLog.readEvents(runId);
  const collector = new ItemCollector();
  const calls = [];
  const callsByRequest = new Map();
  const toolCalls = new Map();
  const toolMessages = new Map();
  const knowledge = [];
  const errors = [];
  let start = null;
  let end = null;
  let current = null;
  let messages = [];
  let tools = null;
  let configState = {};

  for (const event of events) {
    const data = event?.data || {};
    switch (event?.type) {
      case RUN_LOG_EVENTS.RUN_START:
        start = start || event;
        break;
      case RUN_LOG_EVENTS.RUN_END:
        end = event;
        break;
      case RUN_LOG_EVENTS.REQUEST_HEADER: {
        if (data.reason === 'initial' || data.reason === 'change') {
          messages = Array.isArray(data.messages) ? data.messages : [];
        } else if (data.reason === 'append') {
          messages = messages.concat(Array.isArray(data.messagesDelta) ? data.messagesDelta : []);
        }
        if (Array.isArray(data.toolSchemas)) tools = data.toolSchemas;
        else if (data.toolSchemasHash === null) tools = null;
        if (data.modelSnapshot || data.optionsSnapshot) {
          configState = {
            modelSnapshot: data.modelSnapshot || configState.modelSnapshot,
            optionsSnapshot: data.optionsSnapshot || configState.optionsSnapshot
          };
        }
        for (const message of messages) {
          if (message?.role === 'tool' && message.tool_call_id) {
            if (!toolMessages.has(message.tool_call_id)) {
              toolMessages.set(message.tool_call_id, message.content);
            }
          }
        }
        let systemCount = 0;
        while (messages[systemCount]?.role === 'system') systemCount += 1;
        current = compact({
          step: data.step,
          segment: data.segment,
          purpose: data.purpose,
          requestId: data.requestId,
          startedAt: event.ts,
          attempt: 1,
          model: data.model,
          provider: data.provider,
          modelId: data.modelId,
          messagesHash: data.messagesHash,
          messageCount: data.messageCount,
          system: messages.slice(0, systemCount).map(message => collector.ref(message)),
          messages: messages.slice(systemCount).map(message => {
            const files = filesOfMessage(message);
            return compact({
              role: message?.role,
              message: collector.ref(message),
              files: files.length > 0 ? files : undefined
            });
          }),
          tools: tools ? tools.map(tool => collector.ref(tool)) : undefined,
          config: collector.ref({
            callConfig: data.callConfig || {},
            modelSnapshot: configState.modelSnapshot || {},
            optionsSnapshot: configState.optionsSnapshot || {}
          }),
          settings: modelSettings(data.callConfig, configState.optionsSnapshot),
          status: 'unknown'
        });
        calls.push(current);
        callsByRequest.set(data.requestId, current);
        break;
      }
      case RUN_LOG_EVENTS.REQUEST_RETRY: {
        const call = callsByRequest.get(data.requestId);
        if (!call) break;
        call.attempt = Math.max(call.attempt, (data.attempt || 1) + 1);
        (call.retries ||= []).push(
          compact({ attempt: data.attempt, code: data.code, status: data.status })
        );
        break;
      }
      case RUN_LOG_EVENTS.MESSAGE_ASSISTANT: {
        const call = callsByRequest.get(data.requestId) || current;
        if (!call) break;
        call.status = 'ok';
        call.endedAt = event.ts;
        call.output = collector.ref(
          compact({
            content: data.content,
            contentSpill: data.contentSpill,
            toolCalls: data.toolCalls,
            finishReason: data.finishReason,
            usage: data.usage
          })
        );
        if (data.contentSpill) {
          try {
            call.outputContent = collector.ref(await runLog.readSpill(runId, data.contentSpill));
          } catch {
            /* the preview in `output` stays */
          }
        }
        break;
      }
      case RUN_LOG_EVENTS.ERROR: {
        const error = compact({
          step: data.step,
          code: data.code,
          message: data.message,
          providerCode: data.providerCode,
          status: data.status,
          at: event.ts
        });
        errors.push(error);
        // A failed model call has no answer; an error after one (a tool, the
        // loop) belongs to the run, not to the call.
        if (current && current.status !== 'ok') {
          current.status = 'error';
          current.error = error;
        }
        break;
      }
      case RUN_LOG_EVENTS.TOOL_CALL:
        toolCalls.set(data.callId, {
          call: data,
          startedAt: event.ts
        });
        break;
      case RUN_LOG_EVENTS.TOOL_RESULT: {
        const entry = toolCalls.get(data.callId) || { call: { callId: data.callId } };
        entry.result = data;
        entry.endedAt = event.ts;
        toolCalls.set(data.callId, entry);
        break;
      }
      case RUN_LOG_EVENTS.KNOWLEDGE_SCOPE:
        for (const project of Array.isArray(data.projects) ? data.projects : []) {
          knowledge.push(
            compact({ projectId: project.id, mode: project.mode, documents: project.documents })
          );
        }
        break;
      default:
        break;
    }
  }

  const toolCallRecords = [];
  for (const { call, result, startedAt, endedAt } of toolCalls.values()) {
    let resultRef;
    let resultSource;
    if (result?.spillRef) {
      try {
        resultRef = collector.ref(await runLog.readSpill(runId, result.spillRef));
        resultSource = 'spill';
      } catch {
        /* fall through to what the model saw */
      }
    }
    if (!resultRef && toolMessages.has(call.callId)) {
      resultRef = collector.ref(toolMessages.get(call.callId));
      resultSource = 'message';
    }
    if (!resultRef && result && result.resultPreview !== undefined) {
      resultRef = collector.ref(result.resultPreview);
      resultSource = 'preview';
    }
    toolCallRecords.push(
      compact({
        step: call.step ?? result?.step,
        callId: call.callId,
        toolId: call.toolId ?? result?.toolId,
        name: call.name ?? result?.name,
        title: call.title,
        integration: call.integration,
        activityKind: call.activityKind,
        activityScope: call.activityScope,
        activityOrigin: call.activityOrigin ?? result?.activityOrigin,
        execution: call.execution,
        args: 'args' in call ? collector.ref(call.args) : undefined,
        argsRepaired: call.argsRepaired,
        result: resultRef,
        resultSource,
        partial: resultSource === 'preview' ? true : undefined,
        resultBytes: result?.resultBytes,
        error: result?.error,
        durationMs: result?.durationMs,
        startedAt,
        endedAt
      })
    );
  }

  const startData = start?.data || {};
  const endData = end?.data || {};
  const first = calls[0] || {};
  const resolvedAppId = appId || startData.refs?.appId || null;
  const content = typeof summary?.content === 'string' ? summary.content : '';
  const record = compact({
    v: EVIDENCE_VERSION,
    chatId,
    messageId,
    runId,
    userId: startData.principal?.id,
    startedAt: start?.ts,
    endedAt: end?.ts || new Date().toISOString(),
    journalEnded: Boolean(end),
    ihubVersion: getAppVersion(),
    app: resolvedAppId
      ? compact({ id: resolvedAppId, configSha256: appConfigSha256(resolvedAppId) })
      : undefined,
    model: first.model
      ? compact({
          id: first.model,
          provider: first.provider,
          modelId: first.modelId,
          settings: first.settings
        })
      : undefined,
    status: summary?.status ?? endData.status,
    output: compact({
      provenanceId: summary?.provenance?.output_id ?? endData.provenance?.output_id,
      contentSha256: sha256Hex(content),
      finishReason: summary?.finishReason ?? endData.finishReason,
      usage: summary?.usage ?? endData.usage,
      files: (Array.isArray(artifacts) ? artifacts : [])
        .filter(artifact => artifact?.id)
        .map(artifact => compact({ artifactId: artifact.id, sha256: artifact.sha256 }))
    }),
    calls: calls.map(({ settings: _settings, ...call }) => call),
    toolCalls: toolCallRecords,
    errors: errors.length > 0 ? errors : undefined,
    knowledge,
    children: []
  });
  return { record, items: collector.items };
}

/**
 * Store the evidence record of a run that is not a turn of a stored chat
 * (`/v1/chat/completions`, the Responses API without a conversation) in
 * `run-evidence`, owned by the caller. Call it after the run ended, without
 * awaiting it: it never throws and never delays the response.
 *
 * Anonymous callers get no record — there is nobody it could be shown to or
 * deleted with.
 *
 * @param {Object} params
 * @param {string} params.runId - The run.
 * @param {Object} params.user - The caller (`req.user`).
 * @param {Object} [params.summary] - The outcome: `status`, `content`,
 *   `finishReason`, `usage`, `provenance`.
 * @param {Object} [params.runLog] - The run journal; the shared RunLog by default.
 * @returns {Promise<{id: string, sha256: string}|null>}
 */
export async function recordRunEvidence({ runId, user, summary = {}, runLog }) {
  try {
    if (!runId || !user?.id || isAnonymousUser(user)) return null;
    const settings = chatEvidenceSettings(configCache.getPlatform?.() || {});
    if (!settings.enabled) return null;
    const store = getChatEvidenceRepository();
    if (!store.isAvailable()) return null;
    const journal = runLog || (await import('../loop/RunLog.js')).default;
    const { record, items } = await buildEvidence({ runLog: journal, runId, summary });
    return await store.writeRecord('run', runId, record, items, {
      ownerId: user.id,
      maxContentBytes: settings.maxContentBytes
    });
  } catch (error) {
    logger.error('Run evidence record not stored', {
      component: 'evidenceRecord',
      runId,
      error: error.message
    });
    return null;
  }
}

export default buildEvidence;
