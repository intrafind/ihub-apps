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
 * when they change. This module replays those headers and folds them, the tool
 * calls and their results into one record. A call's messages mirror the
 * journal: `{ from, append }`, the call whose list it continues plus what it
 * added. Every piece of content becomes an item (its canonical JSON, keyed by
 * SHA-256) that `ChatEvidenceRepository` stores once per chat; the record
 * names items as `sha256:<hex>`.
 *
 * Documents and pictures stored as chat files are already references in the
 * journal (`ledgerMessages.js`); they are listed on the message as `files`
 * and not copied.
 *
 * The record is written after the answer is stored, off the answer path: a
 * process that dies in between leaves the answer without a record (logged by
 * nobody — there is nobody left). A run whose journal has no model call (the
 * run ledger off) gets no record.
 *
 * @module services/chat/evidenceRecord
 */
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import configCache from '../../configCache.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { isAnonymousUser } from '../loop/runIdentity.js';
import { chatEvidenceSettings } from './chatPersistence.js';
import { GUEST_OWNER_PREFIX } from './chatOwner.js';
import {
  SHA256_PATTERN,
  contentItem,
  getChatEvidenceRepository,
  inBackground,
  sha256Hex
} from './ChatEvidenceRepository.js';

export { evidenceWritesSettled } from './ChatEvidenceRepository.js';

/** Version of the record shape. */
export const EVIDENCE_VERSION = 1;

/** A document reference tag as `ledgerMessages.js` writes it. */
const DOCUMENT_REF_TAG = /<content\b[^>]*\btext_sha256="[a-f0-9]{64}"[^>]*\/>/g;

/**
 * Collects items and hands out their references. One per build, so a message
 * object replayed into many calls is serialized and hashed once. An item
 * above `maxContentBytes` is hashed but not kept; it is listed in `truncated`.
 */
class ItemCollector {
  constructor(maxContentBytes) {
    /** @type {Map<string, string>} sha256 → canonical JSON */
    this.items = new Map();
    /** @type {Map<string, {sha256: string, bytes: number, truncated: true}>} */
    this.truncated = new Map();
    this._max =
      Number.isFinite(maxContentBytes) && maxContentBytes > 0 ? maxContentBytes : Infinity;
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
    // Serialized once; the size check reads the same text that is hashed.
    const { sha256, text } = contentItem(value);
    // UTF-8 is 1–3 bytes per UTF-16 unit: only a text near the cap is measured.
    const over =
      text.length > this._max ||
      (text.length * 3 > this._max && Buffer.byteLength(text, 'utf8') > this._max);
    if (over) {
      this.truncated.set(sha256, {
        sha256,
        bytes: Buffer.byteLength(text, 'utf8'),
        truncated: true
      });
    } else this.items.set(sha256, text);
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
 * The app configuration in force now — the record is built when the answer
 * is stored, which is the closest point to the run it can see.
 *
 * @param {string|null} appId
 * @returns {Object|null}
 */
function appConfigOf(appId) {
  if (!appId) return null;
  try {
    return (configCache.getApps?.(true)?.data || []).find(entry => entry?.id === appId) || null;
  } catch {
    return null;
  }
}

/** One message as a call lists it: role, reference, chat files. */
function messageEntry(collector, message) {
  const files = filesOfMessage(message);
  return compact({
    role: message?.role,
    message: collector.ref(message),
    files: files.length > 0 ? files : undefined
  });
}

/** The last tool message of `messages` answering `callId`. */
function toolMessageFor(messages, callId) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'tool' && message.tool_call_id === callId) return message;
  }
  return null;
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
 * @param {number} [params.maxContentBytes] - Cap of one item.
 * @returns {Promise<{record: Object, items: Map<string, string>}|null>} Null
 *   when the journal has no model call (the ledger was off).
 */
export async function buildEvidence({
  runLog,
  runId,
  summary = {},
  chatId,
  messageId,
  appId,
  artifacts = [],
  maxContentBytes
}) {
  const events = await runLog.readEvents(runId);
  const collector = new ItemCollector(maxContentBytes);
  const calls = [];
  const callsByRequest = new Map();
  const callsByStep = new Map();
  /** Tool calls by `<step>:<callId>`; a call id can repeat across steps. */
  const toolCalls = new Map();
  /** Tool calls whose result the next header may carry. */
  let awaitingHeader = [];
  const knowledge = [];
  const errors = [];
  let start = null;
  let end = null;
  let messages = [];
  let tools = null;
  let responseSchema = null;
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
        const previous = calls.length - 1;
        let from = null;
        let added = [];
        let incomplete = false;
        if (data.reason === 'append' || data.reason === 'same') {
          // Relative to the previous header of the run, which is the previous call here.
          if (previous < 0) incomplete = true;
          else from = previous;
          added =
            data.reason === 'append' && Array.isArray(data.messagesDelta) ? data.messagesDelta : [];
          messages = messages.concat(added);
        } else {
          messages = Array.isArray(data.messages) ? data.messages : [];
          added = messages;
        }
        if (Number.isInteger(data.messageCount) && data.messageCount !== messages.length) {
          incomplete = true;
        }
        if (Array.isArray(data.toolSchemas)) tools = data.toolSchemas;
        else if (data.toolSchemasHash === null) tools = null;
        const callConfig = data.callConfig || {};
        if (callConfig.responseSchema !== undefined) responseSchema = callConfig.responseSchema;
        else if (!callConfig.responseSchemaHash) responseSchema = null;
        if (data.modelSnapshot || data.optionsSnapshot) {
          configState = {
            modelSnapshot: data.modelSnapshot || configState.modelSnapshot,
            optionsSnapshot: data.optionsSnapshot || configState.optionsSnapshot
          };
        }
        // The tool calls since the previous header get the result the model read here.
        for (const entry of awaitingHeader) {
          const message = toolMessageFor(messages, entry.call.callId);
          if (message) entry.message = message;
        }
        awaitingHeader = [];
        // ponytail: the first call of each answer still lists the whole history
        // (O(history) references per answer); a cross-answer `from` would need
        // the previous answer's record.
        const call = compact({
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
          messages: { from, append: added.map(message => messageEntry(collector, message)) },
          incomplete: incomplete || undefined,
          tools: tools ? tools.map(tool => collector.ref(tool)) : undefined,
          config: collector.ref({
            callConfig: { ...callConfig, responseSchema: responseSchema ?? undefined },
            modelSnapshot: configState.modelSnapshot || {},
            optionsSnapshot: configState.optionsSnapshot || {}
          }),
          settings: modelSettings(callConfig, configState.optionsSnapshot),
          status: 'unknown'
        });
        calls.push(call);
        callsByRequest.set(data.requestId, call);
        callsByStep.set(data.step, call);
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
        const call = callsByRequest.get(data.requestId) || callsByStep.get(data.step);
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
        // A model call that failed has no answer; an error of a step whose
        // call did answer (a tool, the loop) belongs to the run only.
        const call = callsByRequest.get(data.requestId) || callsByStep.get(data.step);
        if (call && call.status !== 'ok') {
          call.status = 'error';
          call.error = error;
        }
        break;
      }
      case RUN_LOG_EVENTS.TOOL_CALL: {
        const entry = { call: data, startedAt: event.ts };
        toolCalls.set(`${data.step}:${data.callId}`, entry);
        awaitingHeader.push(entry);
        break;
      }
      case RUN_LOG_EVENTS.TOOL_RESULT: {
        const key = `${data.step}:${data.callId}`;
        const entry = toolCalls.get(key) || { call: { step: data.step, callId: data.callId } };
        entry.result = data;
        entry.endedAt = event.ts;
        if (!toolCalls.has(key)) {
          toolCalls.set(key, entry);
          awaitingHeader.push(entry);
        }
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

  if (calls.length === 0) return null;

  const toolCallRecords = [];
  for (const { call, result, message, startedAt, endedAt } of toolCalls.values()) {
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
    if (!resultRef && message) {
      resultRef = collector.ref(message.content);
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
  const first = calls[0];
  const resolvedAppId = appId || startData.refs?.appId || null;
  const appConfig = appConfigOf(resolvedAppId);
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
    // The app configuration in force when the answer was stored.
    app: resolvedAppId
      ? compact({ id: resolvedAppId, config: appConfig ? collector.ref(appConfig) : undefined })
      : undefined,
    model: compact({
      id: first.model,
      provider: first.provider,
      modelId: first.modelId,
      settings: first.settings
    }),
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
    truncated: collector.truncated.size > 0 ? [...collector.truncated.values()] : undefined
  });
  return { record, items: collector.items };
}

/** Whether a chat owner is a guest or the anonymous principal. */
function isGuestOwner(ownerId) {
  return !ownerId || ownerId === 'anonymous' || String(ownerId).startsWith(GUEST_OWNER_PREFIX);
}

/**
 * Store the evidence record of a stored chat answer, in the background
 * (#3687). Called after the answer is appended and the run released; the
 * record is named by the chat and the answer's message id.
 *
 * Nothing is written while the switch is off, for a guest's or the anonymous
 * principal's chat, for a run without a model call in its journal, or once the
 * chat is gone (checked under the evidence lock).
 *
 * @param {Object} params
 * @param {import('./ChatRepository.js').default} params.repository
 * @param {string} params.chatId
 * @param {string} params.runId
 * @param {string} params.messageId - The stored answer's id.
 * @param {Object} params.summary - The turn outcome.
 * @param {Array<Object>} [params.artifacts] - Stored artifact descriptors.
 * @param {Object} [params.runLog] - The run journal; the shared RunLog by default.
 * @returns {Promise<{id: string, sha256: string}|null>}
 */
export function recordChatEvidence({
  repository,
  chatId,
  runId,
  messageId,
  summary,
  artifacts,
  runLog
}) {
  return inBackground(
    async () => {
      const settings = chatEvidenceSettings(configCache.getPlatform?.() || {});
      if (!settings.enabled) return null;
      const store = repository.evidenceStore?.();
      if (!store?.isAvailable()) return null;
      const chat = await repository.getChat(chatId);
      if (!chat || isGuestOwner(chat.ownerId)) return null;
      const journal = runLog || (await import('../loop/RunLog.js')).default;
      const built = await buildEvidence({
        runLog: journal,
        runId,
        summary,
        chatId,
        messageId,
        artifacts,
        maxContentBytes: settings.maxContentBytes
      });
      if (!built) return null;
      return store.writeRecord('chat', chatId, built.record, built.items, {
        ownerId: chat.ownerId,
        // Under the evidence lock: the chat and the answer must both still be
        // stored, or the record would name something deleted meanwhile.
        onlyIf: async () =>
          Boolean(await repository.getChat(chatId)) &&
          (await repository.getMessages(chatId)).messages.some(message => message.id === messageId)
      });
    },
    { component: 'evidenceRecord', operation: 'chat record', chatId, runId }
  );
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
export function recordRunEvidence({ runId, user, summary = {}, runLog }) {
  return inBackground(
    async () => {
      if (!runId || !user?.id || isAnonymousUser(user)) return null;
      const settings = chatEvidenceSettings(configCache.getPlatform?.() || {});
      if (!settings.enabled) return null;
      const store = getChatEvidenceRepository();
      if (!store.isAvailable()) return null;
      const journal = runLog || (await import('../loop/RunLog.js')).default;
      const built = await buildEvidence({
        runLog: journal,
        runId,
        summary,
        maxContentBytes: settings.maxContentBytes
      });
      if (!built) return null;
      return store.writeRecord('run', runId, built.record, built.items, {
        ownerId: user.id,
        // Under the evidence lock: a run deleted meanwhile (`DELETE
        // /api/runs/{runId}` removes its journal) gets no record. The journal,
        // not the summary: the summary is written from a queue and may still
        // be on its way.
        onlyIf: async () => (await journal.readEvents(runId, { limit: 1 })).length > 0
      });
    },
    { component: 'evidenceRecord', operation: 'run record', runId }
  );
}

/** The 404 of a record that was not kept (switched off, stored before the release, not ours). */
function notRecorded() {
  return new ServiceError('EVIDENCE_NOT_RECORDED', 'No evidence record was kept for this answer');
}

/**
 * Read a stored evidence record for an endpoint. The caller has authorized
 * the chat (or the run's owner is checked here via `ownerId`).
 *
 * @param {Object} params
 * @param {'chat'|'run'} params.kind
 * @param {string} params.id - Chat id or run id.
 * @param {string} [params.messageId] - For a chat record.
 * @param {string} [params.ownerId] - Required owner of a run record.
 * @returns {Promise<Object>} The stored document (`data`, `etag`, `ownerId`).
 * @throws {ServiceError} `EVIDENCE_NOT_RECORDED` (404) while the switch is off
 *   or when there is no such record.
 */
export async function readEvidenceRecord({ kind, id, messageId, ownerId }) {
  if (!chatEvidenceSettings(configCache.getPlatform?.() || {}).enabled) throw notRecorded();
  const doc = await getChatEvidenceRepository().getRecord(kind, id, messageId);
  if (!doc || (ownerId !== undefined && (!ownerId || doc.ownerId !== ownerId))) {
    throw notRecorded();
  }
  return doc;
}

/**
 * Read one content blob of a chat or run for an endpoint.
 *
 * @param {Object} params
 * @param {'chat'|'run'} params.kind
 * @param {string} params.id - Chat id or run id.
 * @param {string} params.sha256 - Content hash.
 * @param {string} [params.ownerId] - Required owner of the run record.
 * @returns {Promise<{content: Buffer, sha256: string}>} The canonical JSON of the item.
 * @throws {ServiceError} `BAD_REQUEST` for a malformed hash, `EVIDENCE_NOT_RECORDED` otherwise.
 */
export async function readEvidenceContent({ kind, id, sha256, ownerId }) {
  if (!SHA256_PATTERN.test(String(sha256))) {
    throw new ServiceError('BAD_REQUEST', 'Expected a lower-case hex SHA-256');
  }
  if (!chatEvidenceSettings(configCache.getPlatform?.() || {}).enabled) throw notRecorded();
  if (ownerId !== undefined) await readEvidenceRecord({ kind, id, ownerId });
  const content = await getChatEvidenceRepository().getContent(kind, id, sha256);
  if (!content) throw notRecorded();
  return { content, sha256 };
}

/**
 * Send a record or a content blob with its ETag. `no-cache`: a record or a
 * blob can be deleted (a removed message, a deleted chat), so a cache must
 * revalidate rather than keep serving it.
 *
 * @param {import('express').Response} res
 * @param {{data?: Object, etag?: string}|{content: Buffer, sha256: string}} payload
 * @returns {void}
 */
export function sendEvidence(res, payload) {
  res.setHeader('Cache-Control', 'private, no-cache');
  if (Buffer.isBuffer(payload.content)) {
    res.setHeader('ETag', `"${payload.sha256}"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(payload.content);
    return;
  }
  res.setHeader('ETag', `"${payload.etag}"`);
  res.json(payload.data);
}

export default buildEvidence;
