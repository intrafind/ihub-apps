// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField
} from 'pdf-lib';
import { DocumentGenerationError } from '../renderService.js';

/**
 * Fill the interactive form fields (AcroForm) of an uploaded PDF in place.
 *
 * The page content, the form's layout and all other fields stay as they are:
 * only the values of the named fields change. Text fields take text; check
 * boxes take `true`/`false` (or "yes"/"no", "x", "1"/"0"); radio groups,
 * drop-downs and lists take one of their option names (case-insensitive).
 */

/** Most fields one call may fill. */
export const MAX_FILLED_FIELDS = 500;

const TRUE_WORDS = new Set(['true', 'yes', 'ja', 'y', 'x', '1', 'on', 'checked', 'ankreuzen']);
const FALSE_WORDS = new Set(['false', 'no', 'nein', 'n', '0', 'off', '', 'unchecked']);

function kindOf(field) {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'list';
  return 'other';
}

function describeField(field) {
  const kind = kindOf(field);
  const info = { name: field.getName(), type: kind };
  if (kind === 'radio' || kind === 'dropdown' || kind === 'list') {
    try {
      info.options = field.getOptions();
    } catch {
      // Options are optional detail.
    }
  }
  return info;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  const word = String(value ?? '')
    .trim()
    .toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  throw new Error(`"${value}" is not a yes/no value`);
}

function pickOption(field, value) {
  const wanted = String(value ?? '').trim();
  const options = field.getOptions();
  const exact = options.find(option => option === wanted);
  if (exact !== undefined) return exact;
  const loose = options.find(option => option.toLowerCase() === wanted.toLowerCase());
  if (loose !== undefined) return loose;
  throw new Error(`"${wanted}" is not one of: ${options.join(', ')}`);
}

function setFieldValue(field, value) {
  const kind = kindOf(field);
  if (kind === 'text') {
    field.setText(value === null || value === undefined ? '' : String(value));
  } else if (kind === 'checkbox') {
    if (toBoolean(value)) field.check();
    else field.uncheck();
  } else if (kind === 'radio' || kind === 'dropdown') {
    field.select(pickOption(field, value));
  } else if (kind === 'list') {
    const values = Array.isArray(value) ? value : [value];
    field.select(values.map(entry => pickOption(field, entry)));
  } else {
    throw new Error('this field type cannot be filled');
  }
}

/**
 * List the form fields of a PDF.
 *
 * @param {Uint8Array|Buffer} bytes
 * @returns {Promise<Array<{ name: string, type: string, options?: string[] }>>}
 */
export async function listPdfFormFields(bytes) {
  const doc = await loadPdf(bytes);
  return doc
    .getForm()
    .getFields()
    .map(field => describeField(field));
}

async function loadPdf(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    const encrypted = /encrypted/i.test(error?.message || '');
    throw new DocumentGenerationError(
      encrypted
        ? 'The PDF is password protected, so its form cannot be filled.'
        : 'The uploaded file could not be read as a PDF.',
      'invalid'
    );
  }
}

/**
 * Fill form fields in a PDF.
 *
 * @param {Uint8Array|Buffer} bytes - The uploaded PDF.
 * @param {Object<string, string|number|boolean|string[]>} values - Field name → value.
 * @param {Object} [options]
 * @param {boolean} [options.flatten=false] - Turn the filled form into plain
 *   page content (the fields can no longer be edited).
 * @returns {Promise<{ buffer: Buffer, filled: string[], unknown: string[], failed: Array<{name: string, reason: string}>, fields: Array<Object> }>}
 * @throws {DocumentGenerationError} `invalid` when the PDF has no form fields,
 *   or none of the named fields exists.
 */
export async function fillPdfFormFields(bytes, values, { flatten = false } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new DocumentGenerationError(
      '"fillFormFields" must be an object of field names and values (or its JSON).',
      'invalid'
    );
  }
  const entries = Object.entries(values);
  if (entries.length === 0) {
    throw new DocumentGenerationError('"fillFormFields" has no fields to fill.', 'invalid');
  }
  if (entries.length > MAX_FILLED_FIELDS) {
    throw new DocumentGenerationError(
      `Too many form fields (at most ${MAX_FILLED_FIELDS} per call).`,
      'invalid'
    );
  }

  const doc = await loadPdf(bytes);
  const form = doc.getForm();
  const fields = form.getFields();
  if (fields.length === 0) {
    throw new DocumentGenerationError(
      'The uploaded PDF has no fillable form fields. Use it as a letterhead instead (omit "fillFormFields" and give "markdown").',
      'invalid'
    );
  }
  const byName = new Map(fields.map(field => [field.getName(), field]));
  const byLowerName = new Map(fields.map(field => [field.getName().toLowerCase(), field]));

  const filled = [];
  const unknown = [];
  const failed = [];
  for (const [name, value] of entries) {
    const field = byName.get(name) || byLowerName.get(String(name).toLowerCase());
    if (!field) {
      unknown.push(name);
      continue;
    }
    try {
      setFieldValue(field, value);
      filled.push(field.getName());
    } catch (error) {
      failed.push({ name: field.getName(), reason: error?.message || 'could not be set' });
    }
  }

  const available = fields.map(field => describeField(field));
  if (filled.length === 0) {
    const names = available.map(field => field.name).join(', ');
    throw new DocumentGenerationError(
      `None of the named fields could be filled. The form has these fields: ${names}.`,
      'invalid'
    );
  }

  if (flatten) form.flatten();
  const buffer = Buffer.from(await doc.save({ updateFieldAppearances: true }));
  return { buffer, filled, unknown, failed, fields: available };
}
