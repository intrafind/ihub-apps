// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { DocumentGenerationError } from './renderService.js';
import { GeneratedFileError } from './generatedFiles.js';
import { DocumentTemplateError } from './templates/DocumentTemplateService.js';

/**
 * Helpers shared by the tools of the document system skills (`create_pdf`,
 * `create_docx`, `create_pptx`).
 */

/** Most content one tool call may send, as JSON. */
export const MAX_SPEC_CHARS = 4 * 1024 * 1024;

/**
 * A structured argument, given as a value or as its JSON (some providers'
 * schemas cannot declare free-form objects).
 *
 * @param {unknown} value
 * @param {string} name - Parameter name, for the message.
 * @param {string} what - What it must be, for the message.
 * @returns {unknown}
 */
export function parseStructured(value, name, what) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new DocumentGenerationError(`"${name}" must be ${what} (or its JSON).`, 'invalid');
    }
  }
  return value;
}

/**
 * Refuse a spec whose content is larger than a tool call may be.
 *
 * @param {Object} spec
 */
export function assertSpecSize(spec) {
  if (JSON.stringify(spec).length > MAX_SPEC_CHARS) {
    throw new DocumentGenerationError(
      'The document is too large (over 4 MB of content).',
      'invalid'
    );
  }
}

/**
 * The tool result for a failure: the message of an expected error, a
 * generic one otherwise.
 *
 * @param {Error} error
 * @param {string} fallback
 * @returns {{ success: false, error: string, code?: string }}
 */
export function toolFailure(error, fallback) {
  const known =
    error instanceof DocumentGenerationError ||
    error instanceof GeneratedFileError ||
    error instanceof DocumentTemplateError;
  return {
    success: false,
    error: known ? error.message : fallback,
    ...(known && error.code ? { code: error.code } : {})
  };
}

/** Optional string argument. */
export function optionalString(value, max = 500) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}
