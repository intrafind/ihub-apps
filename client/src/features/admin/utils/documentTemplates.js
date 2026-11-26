// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers for the document template editor (Admin → Document templates).
 *
 * A template keeps a name, the company name, the brand colours, the margins
 * of PDFs and its fields; the design lives in its Word and PowerPoint files.
 */

export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Ids the editor's "new" route and the built-in export designs use. */
export const RESERVED_TEMPLATE_IDS = ['default', 'professional', 'minimal', 'new'];
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** The kinds of slide a PowerPoint template is described by. */
export const SLIDE_KINDS = ['title', 'section', 'content', 'twoColumn', 'titleOnly', 'blank'];
/** Names of custom fields, as the server checks them. */
export const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_FIELDS = 50;
/** `{{name}}` placeholders with a meaning of their own: they cannot be custom fields. */
export const BUILT_IN_PLACEHOLDERS = [
  'content',
  'toc',
  'title',
  'subtitle',
  'author',
  'date',
  'year',
  'company',
  'page',
  'pages'
];
/** The limits of PDF margins, in points. */
export const MARGIN_RANGE = { min: 18, max: 200 };
/** What the PDF engine uses when nothing else is set: left, top, right, bottom. */
export const DEFAULT_MARGINS = [50, 62, 50, 62];

/** A new, empty template. */
export function emptyTemplate() {
  return {
    id: '',
    name: { en: '' },
    description: {},
    enabled: true,
    default: false,
    brand: {},
    pdf: {},
    docx: {},
    pptx: {},
    fields: {}
  };
}

/** A template from the server, with every section present. */
export function normalizeTemplate(template) {
  const base = emptyTemplate();
  return {
    ...base,
    ...template,
    brand: { ...template?.brand },
    pdf: { ...template?.pdf },
    docx: { ...template?.docx },
    pptx: { ...template?.pptx },
    fields: { ...template?.fields }
  };
}

function localized(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, text]) => typeof text === 'string' && text.trim())
  );
}

function compactText(object) {
  const out = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

/** Whether margins are four numbers: the only form the server stores. */
export function isCompleteMargins(margins) {
  return Array.isArray(margins) && margins.length === 4 && margins.every(Number.isFinite);
}

/** A field as the server stores it: empty settings left out. */
function cleanField(field) {
  const out = {};
  const label = localized(field?.label);
  const description = localized(field?.description);
  if (Object.keys(label).length) out.label = label;
  if (Object.keys(description).length) out.description = description;
  if (field?.required) out.required = true;
  const options = (field?.options || []).map(option => String(option).trim()).filter(Boolean);
  if (options.length) out.options = options;
  const fallback = typeof field?.default === 'string' ? field.default.trim() : '';
  if (fallback) out.default = fallback;
  return out;
}

/**
 * The template as the server stores it: empty settings left out, localized
 * texts without empty languages, margins only when all four are numbers.
 *
 * @param {Object} draft
 * @returns {Object}
 */
export function cleanTemplate(draft) {
  const pdf = isCompleteMargins(draft.pdf?.margins) ? { margins: draft.pdf.margins } : {};
  return {
    id: draft.id,
    name: localized(draft.name),
    description: localized(draft.description),
    enabled: draft.enabled !== false,
    default: Boolean(draft.default),
    brand: compactText(draft.brand),
    pdf,
    docx: compactText(draft.docx),
    pptx: compactText(draft.pptx),
    fields: Object.fromEntries(
      Object.entries(draft.fields || {}).map(([name, field]) => [name, cleanField(field)])
    )
  };
}

/**
 * Problems that keep a draft from being saved, by field. Problems of a custom
 * field are under `field:<name>`.
 *
 * @param {Object} draft
 * @param {Function} t
 * @returns {Object<string, string>}
 */
export function validateTemplate(draft, t) {
  const errors = {};
  if (!TEMPLATE_ID_PATTERN.test(draft.id || '')) {
    errors.id = t(
      'admin.documentTemplates.errors.id',
      'Use 1–64 lower-case letters, digits and "-", starting with a letter or digit.'
    );
  } else if (RESERVED_TEMPLATE_IDS.includes(draft.id)) {
    errors.id = t(
      'admin.documentTemplates.errors.reservedId',
      'This id is reserved; choose another one.'
    );
  }
  if (!Object.values(draft.name || {}).some(name => typeof name === 'string' && name.trim())) {
    errors.name = t('admin.documentTemplates.errors.name', 'Give the template a name.');
  }
  for (const key of ['primaryColor', 'accentColor', 'textColor']) {
    const value = draft.brand?.[key];
    if (value && !HEX_COLOR.test(value)) {
      errors[key] = t('admin.documentTemplates.errors.color', 'Use a hex colour like #e30613.');
    }
  }
  const margins = draft.pdf?.margins;
  if (
    margins !== undefined &&
    (!isCompleteMargins(margins) ||
      margins.some(value => value < MARGIN_RANGE.min || value > MARGIN_RANGE.max))
  ) {
    errors.margins = t(
      'admin.documentTemplates.errors.margins',
      'Give all four margins, between {{min}} and {{max}} points.',
      MARGIN_RANGE
    );
  }
  Object.assign(errors, validateFields(draft.fields, t));
  return errors;
}

/** Problems of the custom fields, by `field:<name>`. */
function validateFields(fields, t) {
  const errors = {};
  const entries = Object.entries(fields || {});
  if (entries.length > MAX_FIELDS) {
    errors.fields = t('admin.documentTemplates.errors.fieldCount', 'At most {{max}} fields.', {
      max: MAX_FIELDS
    });
  }
  for (const [name, field] of entries) {
    const options = (field?.options || []).map(option => String(option).trim()).filter(Boolean);
    const fallback = typeof field?.default === 'string' ? field.default.trim() : '';
    if (new Set(options).size !== options.length) {
      errors[`field:${name}`] = t(
        'admin.documentTemplates.errors.fieldOptionTwice',
        'An allowed value is listed twice.'
      );
    } else if (options.length && fallback && !options.includes(fallback)) {
      errors[`field:${name}`] = t(
        'admin.documentTemplates.errors.fieldDefault',
        'The default value must be one of the allowed values.'
      );
    }
  }
  return errors;
}

/**
 * A new field name from what the admin typed: lower case, `_` for anything
 * that is no letter or digit, a letter first.
 *
 * @param {string} text
 * @returns {string}
 */
export function fieldNameFrom(text) {
  // Runs of anything but letters and digits become one "_"; none stays at the ends.
  const parts = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const name = parts.join('_').slice(0, 32).replace(/_$/, '');
  return /^[a-z]/.test(name) ? name : '';
}

/**
 * Why a field name cannot be added, or null when it can.
 *
 * @param {string} name - From {@link fieldNameFrom}.
 * @param {Object} fields - The template's fields.
 * @param {Function} t
 * @returns {string|null}
 */
export function fieldNameProblem(name, fields, t) {
  if (!FIELD_NAME_PATTERN.test(name)) {
    return t(
      'admin.documentTemplates.fields.nameInvalid',
      'Use a letter first, then letters, digits or "_" (up to 32 characters).'
    );
  }
  if (BUILT_IN_PLACEHOLDERS.includes(name)) {
    return t(
      'admin.documentTemplates.fields.nameBuiltIn',
      '"{{name}}" is a built-in placeholder and cannot be a field.',
      { name }
    );
  }
  if (Object.hasOwn(fields || {}, name)) {
    return t('admin.documentTemplates.fields.nameTaken', 'This field exists already.');
  }
  if (Object.keys(fields || {}).length >= MAX_FIELDS) {
    return t('admin.documentTemplates.errors.fieldCount', 'At most {{max}} fields.', {
      max: MAX_FIELDS
    });
  }
  return null;
}
