// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat & scheduled-task file upload policy — storage modes, retention, and
 * three-tier quotas (`per-chat`/`per-task`, `per-user`, `server-total`).
 *
 * Kept separate from `ChatFileRepository` so routes, prompt assembly, retention
 * sweeps and `/api/configs/platform` evaluate the exact same rules.
 *
 * @module services/chatFiles/chatFilePolicy
 */
import configCache from '../../configCache.js';

/**
 * Supported upload storage modes (`platform.uploads.storageMode` and per-app
 * override `app.uploads.storageMode`):
 *
 * - `original_and_text` (default): Server extracts text and stores both the
 *   extracted text blob and the original binary blob (subject to
 *   `originalRetentionDays`).
 * - `server_text_only`: Server extracts text and stores only the extracted
 *   text blob; the original binary is discarded immediately after extraction.
 * - `client_text_only`: Browser extracts text and uploads only the extracted
 *   text; no original file binary ever crosses the network.
 */
export const STORAGE_MODES = Object.freeze([
  'original_and_text',
  'server_text_only',
  'client_text_only'
]);

export const DEFAULT_STORAGE_MODE = 'original_and_text';

/**
 * Days an uploaded chat file's original binary is retained before the TTL sweep
 * discards the `.bin` blob and keeps only the extracted text blob (`<= 0`
 * keeps originals until the chat itself is deleted).
 */
export const DEFAULT_ORIGINAL_RETENTION_DAYS = 14;

/** Largest single uploaded file (25 MB). */
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Most bytes stored in a single chat or scheduled task (100 MB). */
export const DEFAULT_MAX_CHAT_BYTES = 100 * 1024 * 1024;

/** Most uploaded files attached to a single chat or scheduled task. */
export const DEFAULT_MAX_CHAT_FILES = 25;

/** Most bytes stored across all chats and tasks of a single owner (1 GB). */
export const DEFAULT_MAX_USER_BYTES = 1024 * 1024 * 1024;

/** Most bytes stored across the entire server (`0` or negative disables cap). */
export const DEFAULT_MAX_SERVER_BYTES = 50 * 1024 * 1024 * 1024;

/**
 * MIME types whose retained original binary can be used as a template or
 * source file in system skill tools (`create_docx`, `create_pptx`,
 * `create_pdf`, `create_xlsx`).
 */
export const TEMPLATE_CAPABLE_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf'
]);

/**
 * Normalize a configured storage mode.
 *
 * @param {unknown} mode
 * @param {string} [fallback=DEFAULT_STORAGE_MODE]
 * @returns {'original_and_text'|'server_text_only'|'client_text_only'}
 */
export function resolveStorageMode(mode, fallback = DEFAULT_STORAGE_MODE) {
  if (typeof mode === 'string' && STORAGE_MODES.includes(mode)) return mode;
  return STORAGE_MODES.includes(fallback) ? fallback : DEFAULT_STORAGE_MODE;
}

/**
 * Whether an uploaded file with this media type and original binary state can
 * be referenced as `templateFileId` / `sourceFileId` by document skills.
 *
 * @param {string} mimeType
 * @param {boolean} hasOriginal
 * @returns {boolean}
 */
export function canUseFileAsTemplate(mimeTypeOrObj, hasOriginalArg) {
  const mimeType =
    mimeTypeOrObj && typeof mimeTypeOrObj === 'object'
      ? mimeTypeOrObj.mimeType || mimeTypeOrObj.type
      : mimeTypeOrObj;
  const hasOriginal =
    mimeTypeOrObj && typeof mimeTypeOrObj === 'object'
      ? mimeTypeOrObj.hasOriginal === true
      : hasOriginalArg === true;
  if (!hasOriginal || typeof mimeType !== 'string') return false;
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  return TEMPLATE_CAPABLE_MIME_TYPES.has(normalized);
}

/**
 * Read a numeric setting, keeping zero and negative values ("disable this rule").
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve upload settings from platform configuration and optional app override.
 *
 * @param {Object} [platformConfig] - `platform.json` configuration.
 * @param {Object} [appConfig] - Optional app configuration (`app.uploads.storageMode`).
 * @returns {{
 *   enabled: boolean,
 *   storageMode: 'original_and_text'|'server_text_only'|'client_text_only',
 *   originalRetentionDays: number,
 *   evictOldestOriginalsOnQuota: boolean,
 *   quotas: {
 *     maxFileBytes: number,
 *     maxChatBytes: number,
 *     maxChatFiles: number,
 *     maxUserBytes: number,
 *     maxServerBytes: number
 *   }
 * }}
 */
export function chatFileSettings(platformConfig = {}, appConfig = null) {
  const uploads = platformConfig?.uploads || {};
  const quotas = uploads.quotas || {};
  const platformMode = resolveStorageMode(uploads.storageMode, DEFAULT_STORAGE_MODE);
  const storageMode = resolveStorageMode(appConfig?.uploads?.storageMode, platformMode);

  const resolvedQuotas = {
    maxFileBytes: readNumber(quotas.maxFileBytes ?? uploads.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
    maxChatBytes: readNumber(quotas.maxChatBytes ?? uploads.maxChatBytes, DEFAULT_MAX_CHAT_BYTES),
    maxChatFiles: readNumber(quotas.maxChatFiles ?? uploads.maxChatFiles, DEFAULT_MAX_CHAT_FILES),
    maxUserBytes: readNumber(quotas.maxUserBytes ?? uploads.maxUserBytes, DEFAULT_MAX_USER_BYTES),
    maxServerBytes: readNumber(
      quotas.maxServerBytes ?? uploads.maxServerBytes,
      DEFAULT_MAX_SERVER_BYTES
    )
  };

  return {
    enabled: uploads.enabled !== false,
    storageMode,
    originalRetentionDays: readNumber(
      uploads.originalRetentionDays,
      DEFAULT_ORIGINAL_RETENTION_DAYS
    ),
    evictOldestOriginalsOnQuota: uploads.evictOldestOriginalsOnQuota !== false,
    ...resolvedQuotas,
    quotas: resolvedQuotas
  };
}

/**
 * Normalize a caller-provided policy object so top-level quota overrides
 * (`{ ...chatFilePolicy(), maxFileBytes: 100 }`) and nested `quotas` agree.
 *
 * @param {Object} [policy]
 * @param {Object} [appConfig]
 * @returns {ReturnType<typeof chatFileSettings>}
 */
export function normalizeChatFilePolicy(policy = null, appConfig = null) {
  const base = chatFilePolicy(appConfig);
  if (!policy || typeof policy !== 'object') return base;
  const q = policy.quotas || {};
  const quotas = {
    maxFileBytes: readNumber(policy.maxFileBytes ?? q.maxFileBytes, base.quotas.maxFileBytes),
    maxChatBytes: readNumber(policy.maxChatBytes ?? q.maxChatBytes, base.quotas.maxChatBytes),
    maxChatFiles: readNumber(policy.maxChatFiles ?? q.maxChatFiles, base.quotas.maxChatFiles),
    maxUserBytes: readNumber(policy.maxUserBytes ?? q.maxUserBytes, base.quotas.maxUserBytes),
    maxServerBytes: readNumber(
      policy.maxServerBytes ?? q.maxServerBytes,
      base.quotas.maxServerBytes
    )
  };
  return {
    ...base,
    ...policy,
    ...quotas,
    quotas
  };
}

/**
 * Live upload policy resolved against `configCache.getPlatform()`.
 *
 * @param {Object} [appConfig]
 * @returns {ReturnType<typeof chatFileSettings>}
 */
export function chatFilePolicy(appConfig = null) {
  return chatFileSettings(configCache.getPlatform?.() || {}, appConfig);
}

/**
 * Public client-facing upload configuration included on `/api/configs/platform`.
 *
 * @param {Object} [platformConfig]
 * @param {Object} [options]
 * @param {boolean} [options.storageAvailable=true]
 * @returns {Object}
 */
export function uploadsClientConfig(platformConfig = {}, { storageAvailable = true } = {}) {
  const settings = chatFileSettings(platformConfig);
  return {
    enabled: settings.enabled && storageAvailable,
    storageMode: settings.storageMode,
    originalRetentionDays: settings.originalRetentionDays,
    quotas: settings.quotas
  };
}
