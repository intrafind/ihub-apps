// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The registry of API error codes.
 *
 * Every error response of the server carries one of these in `code`; the client
 * turns it into a message with the i18n key `apiErrors.<CODE>` and the response's
 * `details` as interpolation parameters, so no localized text travels over the
 * wire. The server keeps an English fallback in `error` for other callers.
 *
 * The value is the HTTP status a code answers with when the thrower names none.
 * Generic codes come first; a specific code is added where the client shows a
 * specific message for it today.
 *
 * @module shared/apiErrors
 */

/** Generic codes: what went wrong, not where. */
export const GENERIC_ERROR_CODES = Object.freeze({
  INTERNAL_ERROR: 500,
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  NOT_IMPLEMENTED: 501,
  UPSTREAM_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
  TIMEOUT: 504
});

/** The failure codes of the storage layer (`server/storage/errors.js`). */
export const STORAGE_ERROR_CODES = Object.freeze({
  ETAG_MISMATCH: 409,
  LOCK_TIMEOUT: 503,
  INVALID_KEY: 400,
  INVALID_CURSOR: 400,
  INVALID_SEQ: 400,
  INVALID_DATA: 400,
  INVALID_ETAG: 400,
  INVALID_LOCK_OPTIONS: 400,
  NOT_SUPPORTED: 501,
  STORAGE_SHUT_DOWN: 503,
  STORAGE_UNAVAILABLE: 503,
  UNKNOWN_PROVIDER: 500,
  UNKNOWN_NAMESPACE: 400,
  CORRUPT_DOCUMENT: 500,
  STORAGE_ERROR: 500
});

/**
 * The failure codes of a model call (`LLM_ERROR_CODES`). `RATE_LIMITED` and
 * `TIMEOUT` are the generic codes of the same name.
 */
export const LLM_API_ERROR_CODES = Object.freeze({
  CONTEXT_WINDOW_EXCEEDED: 400,
  CONTENT_POLICY: 422,
  EMPTY_RESPONSE: 502,
  NETWORK: 502,
  PROVIDER_ERROR: 502,
  AUTH_FAILED: 502,
  MODEL_NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  ABORTED: 499,
  QUOTA_EXCEEDED: 429
});

/**
 * Codes of one feature that the client already tells apart today (a specific
 * message, or a branch on the code). Everything else uses a generic code.
 */
export const FEATURE_ERROR_CODES = Object.freeze({
  CHAT_SHARING_UNAVAILABLE: 503,
  ARTIFACT_SHARING_DISABLED: 403,
  SHARE_MODE_DISABLED: 403,
  EMBED_DISABLED: 403,
  CHAT_TEMPORARY: 409,
  FILES_NOT_SHARED: 403,
  ORIGINAL_NOT_SHARED: 403,
  ORIGINAL_DISCARDED: 410
});

/** Codes of the scheduled-task routes and tools (`server/services/scheduler/tasks`). */
export const SCHEDULED_TASK_ERROR_CODES = Object.freeze({
  SCHEDULED_TASKS_UNAVAILABLE: 503,
  INTERACTIVE_USER_REQUIRED: 403,
  PERMISSION_DENIED: 403,
  TASK_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  TASK_LIMIT_REACHED: 409,
  TASK_DISABLED: 409,
  RUN_IN_PROGRESS: 409,
  RUN_NOT_ACTIVE: 409,
  NO_PENDING_APPROVAL: 409,
  APPROVAL_FAILED: 409,
  PROPOSAL_ALREADY_SAVED: 409,
  VERSION_CONFLICT: 409,
  MEMORY_TOO_LONG: 400,
  MEMORY_UNAVAILABLE: 503,
  INVALID_TASK: 400,
  INVALID_BODY: 400,
  INVALID_RUNS: 400,
  INVALID_DECISION: 400,
  INVALID_STATUS: 400,
  UPLOADS_DISABLED: 503
});

/** Codes of the personal prompt library (`server/routes/promptRoutes.js`). */
export const PROMPT_ERROR_CODES = Object.freeze({
  USER_PROMPTS_NOT_ALLOWED: 403,
  USER_PROMPTS_DISABLED: 403,
  USER_PROMPTS_UNAVAILABLE: 503,
  PROMPT_LIMIT_REACHED: 409,
  SHARE_TARGET_NOT_ALLOWED: 403,
  PROMPT_FORBIDDEN: 403,
  GLOBAL_PROMPT_READ_ONLY: 403,
  PROMPT_ACCESS_CHANGED: 403,
  REVISION_CONFLICT: 409
});

/** Codes of the personal skill library and its marketplace (`server/routes/userSkillRoutes.js`). */
export const USER_SKILL_ERROR_CODES = Object.freeze({
  USER_SKILLS_NOT_ALLOWED: 403,
  USER_SKILLS_DISABLED: 403,
  USER_SKILLS_UNAVAILABLE: 503,
  SKILL_LIMIT_REACHED: 409,
  SKILL_TOO_LARGE: 400,
  SKILL_FORBIDDEN: 403,
  GLOBAL_SKILL_READ_ONLY: 403,
  SKILL_ACCESS_CHANGED: 403,
  MARKETPLACE_SKILLS_DISABLED: 403,
  MARKETPLACE_SKILL_NOT_FOUND: 404,
  MARKETPLACE_SKILL_INVALID: 422,
  MARKETPLACE_FETCH_FAILED: 502,
  MARKETPLACE_SKILL_ERROR: 400,
  SKILL_NAME_TAKEN: 409,
  SKILL_NAME_RESERVED: 409
});

/** Codes of the integration administration (`InstalledIntegrationService`, migrations, action tests). */
export const INTEGRATION_ERROR_CODES = Object.freeze({
  INTEGRATION_ERROR: 400,
  ADOPT_INVALID: 422,
  ADOPT_NOT_APPLICABLE: 409,
  ALLOWED_GROUPS_REMOVED: 400,
  ALWAYS_INSTALLED: 400,
  BACKUP_INVALID: 422,
  BACKUP_NOT_FOUND: 404,
  BACKUP_REQUIRED: 400,
  DEFINITION_MISSING: 422,
  DUPLICATE_ID: 409,
  ID_CHANGE: 400,
  INCOMPATIBLE_DEFINITION: 422,
  INVALID_APPROVAL: 400,
  INVALID_AUTH_MODE: 400,
  INVALID_CONFIG: 500,
  INVALID_ID: 400,
  INVALID_INSTANCE: 400,
  INVALID_INSTRUCTIONS: 400,
  INVALID_OVERRIDE: 400,
  INVALID_VALUES: 400,
  MIGRATION_CONFLICT: 409,
  MIGRATION_FAILED: 422,
  MIGRATION_LOCKED: 409,
  MIGRATION_LOCK_LOST: 409,
  MIGRATION_NOT_APPLICABLE: 409,
  MIGRATION_PENDING: 409,
  NEEDS_REVIEW: 409,
  RESTORE_NOT_APPLICABLE: 409,
  REVERT_DEFINITION_MISSING: 422,
  SINGLETON_ID: 400,
  UNKNOWN_ACTION: 400,
  UNKNOWN_DEFINITION: 404,
  UNSUPPORTED_AUTH_MODE: 400,
  UNSUPPORTED_PROTOCOL: 400,
  APPROVAL_REQUIRED_FIELD: 400,
  NOT_RUNNABLE: 409,
  ACTION_NOT_FOUND: 404,
  ACTION_UNAVAILABLE: 409,
  INVALID_CONNECTION: 400,
  CONFIRMATION_REQUIRED: 409,
  INVALID_ARGUMENTS: 400,
  INVALID_DRAFT: 400,
  NOT_CUSTOM: 400,
  DUPLICATE_DEFINITION: 409,
  INVALID_DEFINITION: 400,
  NOT_PUBLISHABLE: 409,
  UNSUPPORTED_AUTH_KIND: 400,
  NOT_BUILDABLE: 400,
  REQUEST_CONFLICT: 409,
  REQUEST_EXISTS: 409,
  REQUEST_NOT_FOUND: 404,
  REQUEST_CLOSED: 409,
  INVALID_NOTE: 400,
  NOTE_TOO_LONG: 400,
  INVALID_HIDE: 400,
  NOT_HIDDEN: 404,
  DEFINITION_NOT_FOUND: 404,
  INTERACTIVE_SESSION_REQUIRED: 403,
  JSON_REQUIRED: 415,
  INVALID_REASON: 400,
  REASON_TOO_LONG: 400,
  INTEGRATION_NOT_FOUND: 404
});

/** Workflow executions (`server/routes/workflow/workflowRoutes.js`). */
export const WORKFLOW_ERROR_CODES = Object.freeze({
  EXECUTION_NOT_FINISHED: 409,
  EXECUTION_ACTIVE: 409
});

/** Configuration backup and import (`server/routes/admin/backup.js`). */
export const BACKUP_ERROR_CODES = Object.freeze({
  IMPORT_IN_PROGRESS: 409,
  IMPORT_FAILED: 500
});

/** Marketplace install, update and uninstall (`server/routes/admin/marketplace.js`). */
export const MARKETPLACE_ERROR_CODES = Object.freeze({
  CONTENT_VALIDATION_FAILED: 422,
  UNSUPPORTED_DEFINITION_SCHEMA: 422,
  INVALID_VERSION: 400,
  LOCAL_CONTENT_EXISTS: 409,
  INTEGRATION_IN_USE: 409,
  VERSION_NOT_LISTED: 409,
  VERSION_NOT_OFFERED: 409,
  NO_VERSION_OFFERED: 409,
  VERSION_NOT_NEWER: 409,
  VERSION_DESCRIPTOR_INVALID: 409,
  INCOMPATIBLE_IHUB_VERSION: 409,
  CODE_NOT_TRUSTED: 403,
  CODE_INTEGRITY_REQUIRED: 422,
  INTEGRITY_MISMATCH: 422
});

/** Model administration: discovery, text-to-speech voices (`server/routes/admin/models.js`). */
export const MODEL_ERROR_CODES = Object.freeze({
  DISCOVERY_FAILED: 502,
  NOT_TTS_MODEL: 400,
  VOICES_UNSUPPORTED: 501,
  INVALID_AUDIO: 400,
  UNSUPPORTED_TTS_PROVIDER: 400,
  NO_AUDIO: 502
});

/** Every code, with its default HTTP status. */
export const API_ERROR_CODES = Object.freeze({
  ...GENERIC_ERROR_CODES,
  ...STORAGE_ERROR_CODES,
  ...LLM_API_ERROR_CODES,
  ...FEATURE_ERROR_CODES,
  ...SCHEDULED_TASK_ERROR_CODES,
  ...PROMPT_ERROR_CODES,
  ...USER_SKILL_ERROR_CODES,
  ...INTEGRATION_ERROR_CODES,
  ...WORKFLOW_ERROR_CODES,
  ...BACKUP_ERROR_CODES,
  ...MARKETPLACE_ERROR_CODES,
  ...MODEL_ERROR_CODES
});

/**
 * Whether `code` is in the registry.
 *
 * @param {unknown} code
 * @returns {boolean}
 */
export function isApiErrorCode(code) {
  return typeof code === 'string' && Object.hasOwn(API_ERROR_CODES, code);
}

/**
 * The i18n key of a code's message.
 *
 * @param {string} code
 * @returns {string}
 */
export function apiErrorI18nKey(code) {
  return `apiErrors.${code}`;
}
