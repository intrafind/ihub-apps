// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The defaults of an app, in one place: what a new app starts with, what the
 * editor adds to a loaded app, and what is sent to `POST` and
 * `PUT /api/admin/apps`. Pure; imported by the create page, the editor and
 * the server's draft generator. No function modifies its argument.
 *
 * @module shared/appDefaults
 */

export const DEFAULT_APP_COLOR = '#4F46E5';
export const DEFAULT_APP_ICON = 'chat-bubbles';
export const DEFAULT_APP_CATEGORY = 'utility';

/** false: apps created in the UI start not published. See README 6.3 before changing it. */
export const UI_CREATES_PUBLISHED = false;

/** The language of last resort, where neither the UI nor the platform names one. */
const FALLBACK_LANGUAGE = 'en';

const IMAGE_UPLOAD_FORMATS = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

const FILE_UPLOAD_FORMATS = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/vtt',
  'application/json',
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'text/xml',
  'message/rfc822',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-outlook',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation'
];

/** Localized texts the schema requires. Empty languages are dropped while one has text. */
const REQUIRED_LOCALIZED_FIELDS = ['name', 'description'];

/** Localized texts the schema does not require. Dropped when no language has text. */
const OPTIONAL_LOCALIZED_FIELDS = ['system', 'messagePlaceholder', 'prompt'];

function defaultGreeting() {
  return {
    en: { title: '👋 Hello!', subtitle: 'How can I help you today?' },
    de: { title: '👋 Hallo!', subtitle: 'Wie kann ich Ihnen heute helfen?' }
  };
}

function defaultInputMode() {
  return {
    type: 'singleline',
    rows: 5,
    microphone: { enabled: true, mode: 'manual', showTranscript: true }
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** The languages of a localized value that hold text. */
function filledLanguages(value) {
  return Object.fromEntries(Object.entries(value).filter(([, text]) => hasText(text)));
}

/** `de` for `de-DE`; empty for anything that is not a language tag. */
function baseLanguage(tag) {
  const base = String(tag ?? '')
    .split(/[-_]/)[0]
    .trim()
    .toLowerCase();
  return /^[a-z]{2}$/.test(base) ? base : '';
}

/**
 * A complete new chat app without ID and texts. Apps store their texts under
 * base languages, so `de-DE` gives `de`.
 *
 * @param {string} [language='en'] - The language the texts are written in.
 * @returns {object} A new object on every call.
 *
 * @example
 * newAppDefaults('de').name; // → { de: '' }
 */
export function newAppDefaults(language = FALLBACK_LANGUAGE) {
  const lang = baseLanguage(language) || FALLBACK_LANGUAGE;
  return {
    id: '',
    type: 'chat',
    order: 0,
    name: { [lang]: '' },
    description: { [lang]: '' },
    color: DEFAULT_APP_COLOR,
    icon: DEFAULT_APP_ICON,
    system: { [lang]: '' },
    preferredOutputFormat: 'markdown',
    preferredStyle: 'keep',
    enabled: UI_CREATES_PUBLISHED,
    variables: [],
    starterPrompts: [],
    greeting: defaultGreeting(),
    allowEmptyContent: false,
    sendChatHistory: true,
    ephemeral: false,
    category: DEFAULT_APP_CATEGORY,
    inputMode: defaultInputMode(),
    upload: {
      enabled: false,
      imageUpload: {
        enabled: false,
        resizeImages: true,
        maxFileSizeMB: 10,
        supportedFormats: [...IMAGE_UPLOAD_FORMATS]
      },
      fileUpload: {
        enabled: false,
        maxFileSizeMB: 20,
        supportedFormats: [...FILE_UPLOAD_FORMATS]
      }
    }
  };
}

/**
 * A loaded app with the sections the editor's form reads: greeting, the three
 * chat switches, input mode and the upload block. Values the app carries win.
 *
 * @param {object} app - An app as `GET /api/admin/apps/{id}` returns it.
 * @returns {object} A new object; `app` is not modified.
 */
export function padLoadedApp(app) {
  const upload = app?.upload;
  return {
    ...app,
    greeting: app?.greeting || defaultGreeting(),
    allowEmptyContent: app?.allowEmptyContent ?? false,
    sendChatHistory: app?.sendChatHistory ?? true,
    ephemeral: app?.ephemeral ?? false,
    inputMode: { ...defaultInputMode(), ...app?.inputMode },
    upload: {
      enabled: upload?.enabled || false,
      imageUpload: {
        enabled: upload?.imageUpload?.enabled || false,
        resizeImages: upload?.imageUpload?.resizeImages ?? true,
        maxFileSizeMB: upload?.imageUpload?.maxFileSizeMB || 10,
        supportedFormats: upload?.imageUpload?.supportedFormats || [...IMAGE_UPLOAD_FORMATS]
      },
      fileUpload: {
        enabled: upload?.fileUpload?.enabled || false,
        maxFileSizeMB: upload?.fileUpload?.maxFileSizeMB || 20,
        supportedFormats: upload?.fileUpload?.supportedFormats || [...FILE_UPLOAD_FORMATS]
      },
      ...upload
    }
  };
}

/**
 * The app as it is sent to `POST` and `PUT /api/admin/apps`:
 *
 * - an input field loses a default value that is empty in every language and
 *   an empty list of options;
 * - a switched-off image or file upload block is removed, and the whole
 *   upload block when uploads are off;
 * - a switched-off magic prompt is removed, and `features` when nothing is left;
 * - `name` and `description` lose their empty languages as long as one
 *   language has text (with none, the field stays, so the server names it);
 * - `system`, `messagePlaceholder` and `prompt` lose their empty languages
 *   and are removed when no language has text. The schema requires none of
 *   them and refuses an empty text.
 *
 * @param {object} app - The editor's or the create page's working state.
 * @returns {object} A new object; `app` is not modified.
 *
 * @example
 * cleanAppForSave({ id: 'x', name: { en: '', de: 'Helfer' }, prompt: { en: ' ' }, upload: { enabled: false } });
 * // → { id: 'x', name: { de: 'Helfer' } }
 */
export function cleanAppForSave(app) {
  const cleaned = { ...app };

  if (Array.isArray(cleaned.variables)) {
    cleaned.variables = cleaned.variables.map(variable => {
      if (!isPlainObject(variable)) return variable;
      const next = { ...variable };
      if (next.defaultValue && !Object.values(next.defaultValue).some(value => value)) {
        delete next.defaultValue;
      }
      if (Array.isArray(next.predefinedValues) && next.predefinedValues.length === 0) {
        delete next.predefinedValues;
      }
      return next;
    });
  }

  if (cleaned.upload) {
    const upload = { ...cleaned.upload };
    if (upload.imageUpload && upload.imageUpload.enabled === false) delete upload.imageUpload;
    if (upload.fileUpload && upload.fileUpload.enabled === false) delete upload.fileUpload;
    if (upload.enabled === false) {
      delete cleaned.upload;
    } else {
      cleaned.upload = upload;
    }
  }

  if (cleaned.features) {
    const features = { ...cleaned.features };
    if (features.magicPrompt && features.magicPrompt.enabled === false) delete features.magicPrompt;
    if (Object.keys(features).length === 0) {
      delete cleaned.features;
    } else {
      cleaned.features = features;
    }
  }

  for (const field of REQUIRED_LOCALIZED_FIELDS) {
    if (!isPlainObject(cleaned[field])) continue;
    const filled = filledLanguages(cleaned[field]);
    if (Object.keys(filled).length > 0) cleaned[field] = filled;
  }

  for (const field of OPTIONAL_LOCALIZED_FIELDS) {
    if (!isPlainObject(cleaned[field])) continue;
    const filled = filledLanguages(cleaned[field]);
    if (Object.keys(filled).length > 0) {
      cleaned[field] = filled;
    } else {
      delete cleaned[field];
    }
  }

  return cleaned;
}

/**
 * The language of an app that the UI edits first: the first of these that
 * has text in `app.name`: the base language of the UI, the platform's default
 * language, `en`, the first language of the name. A German-only app is
 * therefore edited in German by an admin with an English UI.
 *
 * For an app without a name it is the base language of the UI, and where the
 * UI language is not a language tag, the platform's default language.
 *
 * @param {object|null|undefined} app
 * @param {string} [uiLanguage] - A language tag such as `i18n.language`.
 * @param {string} [platformDefault] - `platform.defaultLanguage`.
 * @returns {string} A base language such as `de`.
 *
 * @example
 * primaryLanguageOf({ name: { de: 'Helfer' } }, 'en-US'); // → 'de'
 * primaryLanguageOf({ name: { en: 'Helper', de: 'Helfer' } }, 'de-DE'); // → 'de'
 * primaryLanguageOf({ name: { en: '' } }, 'de'); // → 'de'
 */
export function primaryLanguageOf(app, uiLanguage, platformDefault) {
  const ui = baseLanguage(uiLanguage);
  const platform = baseLanguage(platformDefault);
  const name = typeof app?.name === 'string' ? {} : app?.name;
  const filled = isPlainObject(name) ? Object.keys(filledLanguages(name)) : [];

  const candidates = [ui, platform, FALLBACK_LANGUAGE].filter(Boolean);
  return candidates.find(language => filled.includes(language)) || filled[0] || candidates[0];
}
