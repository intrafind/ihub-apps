// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The errors of the projects API (spec 1 §5.4): a code the routes map to an
 * HTTP status, and the client to a message. Kept apart from the service so
 * the kinds and the ingest pipeline can throw them without a module cycle.
 *
 * @module services/projects/projectErrors
 */

/** HTTP status per error code. */
export const STATUS_BY_CODE = Object.freeze({
  FEATURE_DISABLED: 403,
  USER_PROJECTS_DISABLED: 403,
  PROJECTS_NOT_ALLOWED: 403,
  PERMISSION_DENIED: 403,
  PROJECT_NOT_FOUND: 404,
  PROJECT_ACCESS_CHANGED: 403,
  PROJECT_EXISTS: 409,
  PROJECT_IN_USE: 400,
  CASCADE_INCOMPLETE: 500,
  PROJECT_MISMATCH: 409,
  QUOTA_PROJECTS: 409,
  QUOTA_FILES: 413,
  QUOTA_FILE_BYTES: 413,
  QUOTA_PROJECT_BYTES: 413,
  KIND_DISABLED: 400,
  KIND_UNKNOWN: 400,
  INVALID_REF: 400,
  UNSUPPORTED_TYPE: 415,
  EXTRACTION_FAILED: 422,
  NO_TEXT: 422,
  SCAN_REJECTED: 422,
  SOURCE_FORBIDDEN: 403,
  SOURCE_GONE: 404,
  SOURCE_TIMEOUT: 504,
  SHARE_TARGET_INVALID: 400,
  ITEM_NOT_FOUND: 404,
  ITEM_NOT_READY: 409,
  INGEST_UNAVAILABLE: 501,
  STORAGE_UNAVAILABLE: 503,
  INTERRUPTED: 422
});

/**
 * An error the routes know how to answer.
 */
export class ProjectError extends Error {
  /**
   * @param {string} code - One of the codes of spec 1 §5.4.
   * @param {string} message
   * @param {Object} [details]
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
    this.status = STATUS_BY_CODE[code] || 400;
    if (details) this.details = details;
  }
}

export default ProjectError;
