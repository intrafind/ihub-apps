// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers for the document template editor (Admin → Document templates).
 */

export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Ids the built-in PDF designs and the editor's "new" route use. */
export const RESERVED_TEMPLATE_IDS = ['default', 'professional', 'minimal', 'new'];
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export const FONT_FACES = ['normal', 'bold', 'italics', 'bolditalics'];
export const SLIDE_KINDS = ['title', 'section', 'content', 'twoColumn', 'titleOnly', 'blank'];
export const BUILT_IN_FONTS = ['sans', 'serif', 'mono'];
/** The id of a text slot of a slide layout (as the server checks it). */
export const SLOT_ID_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}$/;
/** What the server accepts of the text slots of a template. */
export const MAX_SLOTS = 12;
export const MAX_SLOT_PLACEHOLDER_CHARS = 200;

/** A new, empty template. */
export function emptyTemplate() {
  return {
    id: '',
    name: { en: '' },
    description: {},
    enabled: true,
    default: false,
    brand: {},
    fonts: [],
    document: {},
    pdf: {},
    docx: {},
    pptx: {}
  };
}

/** A template from the server, with every section present. */
export function normalizeTemplate(template) {
  const base = emptyTemplate();
  return {
    ...base,
    ...template,
    brand: { ...template?.brand },
    fonts: Array.isArray(template?.fonts) ? template.fonts : [],
    document: { ...template?.document },
    pdf: { ...template?.pdf },
    docx: { ...template?.docx },
    pptx: { ...template?.pptx }
  };
}

function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim() && key !== 'header' && key !== 'footer') {
      continue;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = compact(value);
      if (Object.keys(inner).length) out[key] = inner;
      continue;
    }
    out[key] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

/**
 * The template as the server stores it: empty fields left out (a header or
 * footer may be empty on purpose, meaning "none"), localized texts without
 * empty languages, margins only when all four are numbers.
 *
 * @param {Object} draft
 * @returns {Object}
 */
export function cleanTemplate(draft) {
  const localized = value =>
    Object.fromEntries(
      Object.entries(value || {}).filter(([, text]) => typeof text === 'string' && text.trim())
    );
  const document = { ...draft.document };
  if (
    !Array.isArray(document.margins) ||
    document.margins.length !== 4 ||
    document.margins.some(m => !Number.isFinite(m))
  ) {
    delete document.margins;
  }
  return {
    id: draft.id,
    name: localized(draft.name),
    description: localized(draft.description),
    enabled: draft.enabled !== false,
    default: Boolean(draft.default),
    brand: compact(draft.brand),
    fonts: draft.fonts || [],
    document: compact(document),
    pdf: compact(draft.pdf),
    docx: compact(draft.docx),
    pptx: compact(draft.pptx)
  };
}

/**
 * Problems that keep a draft from being saved, by field.
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
  const slots = Object.entries(draft.pptx?.slots || {});
  if (slots.length > MAX_SLOTS) {
    errors.slots = t('admin.documentTemplates.errors.slotCount', 'At most {{max}} slots.', {
      max: MAX_SLOTS
    });
  }
  const seen = new Set();
  for (const [id, slot] of slots) {
    const placeholder = String(slot?.placeholder || '').trim();
    if (!placeholder) {
      errors[`slot:${id}`] = t(
        'admin.documentTemplates.errors.slotPlaceholder',
        'Name the placeholder for the slot "{{id}}".',
        { id }
      );
    } else if (placeholder.length > MAX_SLOT_PLACEHOLDER_CHARS) {
      errors[`slot:${id}`] = t(
        'admin.documentTemplates.errors.slotPlaceholderLength',
        'The placeholder name is too long (at most {{max}} characters).',
        { max: MAX_SLOT_PLACEHOLDER_CHARS }
      );
    } else if (seen.has(placeholder.toLowerCase())) {
      errors[`slot:${id}`] = t(
        'admin.documentTemplates.errors.slotDuplicate',
        'Another slot already uses this placeholder.'
      );
    }
    seen.add(placeholder.toLowerCase());
  }
  return errors;
}

/** Font family names a template can use: built-in plus uploaded. */
export function fontChoices(template) {
  return [...BUILT_IN_FONTS, ...(template.fonts || []).map(font => font.family)];
}
