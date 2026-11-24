// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the server and the client share about personal apps (feature
 * `userApps`): the shape of their IDs, the keys and limits of their content,
 * the verdict on every key of the app schema, and the fixed parts of the app
 * object a chat runs with.
 *
 * Pure; no function modifies its argument. This file imports only
 * `shared/userAppFields.js` and `shared/appDefaults.js`, which import nothing,
 * so `shared/appId.js` and the validators can import it without a cycle.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 4.2 and 4.4.
 *
 * @module shared/userAppContent
 */

import { newAppDefaults } from './appDefaults.js';
import {
  USER_APP_STORED_CONTENT_KEYS,
  USER_APP_STORED_LOCALIZED_KEYS,
  USER_APP_STORED_REQUIRED_KEYS,
  appKeyVerdicts
} from './userAppFields.js';

/** The prefix of every personal app ID. An admin app may start with it too (`uap_helper`). */
export const USER_APP_ID_PREFIX = 'uap_';

/** The prefix and 16 random bytes in lower-case hex: 36 characters. */
const USER_APP_ID_PATTERN = /^uap_[a-f0-9]{32}$/;

/**
 * Whether an ID has the personal shape: `uap_` and 32 lower-case hex
 * characters, as the server mints it. Nothing else has it, so `uap_helper`
 * and an upper-case spelling are ordinary app IDs.
 *
 * @param {unknown} id
 * @returns {boolean}
 *
 * @example
 * isUserAppId('uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8'); // → true
 * isUserAppId('uap_helper'); // → false
 */
export function isUserAppId(id) {
  return typeof id === 'string' && USER_APP_ID_PATTERN.test(id);
}

/**
 * The top-level keys of the content of a personal app. They are the keys of
 * the create and update bodies (`POST /api/apps`, `PATCH /api/apps/{appId}`)
 * and of `content` in the stored record. There is no `category`: a personal
 * app has none.
 */
export const USER_APP_CONTENT_KEYS = USER_APP_STORED_CONTENT_KEYS;

/** The content keys that hold one text per language. */
export const USER_APP_LOCALIZED_KEYS = USER_APP_STORED_LOCALIZED_KEYS;

/** The localized content keys an app cannot be saved without. */
export const USER_APP_REQUIRED_KEYS = USER_APP_STORED_REQUIRED_KEYS;

/** The keys of an input field a personal app may store. */
export const USER_APP_VARIABLE_KEYS = Object.freeze([
  'name',
  'label',
  'type',
  'required',
  'defaultValue',
  'predefinedValues'
]);

/** The keys of a conversation starter a personal app may store. */
export const USER_APP_STARTER_PROMPT_KEYS = Object.freeze(['title', 'message']);

/** The keys of the greeting of one language a personal app may store. */
export const USER_APP_GREETING_KEYS = Object.freeze(['title', 'subtitle']);

/** The keys of the input line a personal app may set; the microphone stays fixed. */
export const USER_APP_INPUT_MODE_KEYS = Object.freeze(['type', 'rows']);

/** The values of `inputMode.type`. */
export const USER_APP_INPUT_MODE_TYPES = Object.freeze(['singleline', 'multiline']);

/** The values of the output format a personal app may choose. */
export const USER_APP_OUTPUT_FORMATS = Object.freeze(['markdown', 'text']);

/** The keys of the start form a personal app may set. */
export const USER_APP_START_FORM_KEYS = Object.freeze(['enabled', 'submitLabel']);

/** The keys of the input panel a personal app may set. */
export const USER_APP_VARIABLES_PANEL_KEYS = Object.freeze(['pinned']);

/**
 * The keys of `capabilities`: three switches, the list of bound installations,
 * the choice of models and the settings of web search.
 */
export const USER_APP_CAPABILITY_KEYS = Object.freeze([
  'upload',
  'webSearch',
  'skills',
  'integrations',
  'models',
  'webSearchSettings',
  'projects'
]);

/** The keys of one entry of `capabilities.projects`. */
export const USER_APP_PROJECT_KEYS = Object.freeze(['id']);

/** The keys of `capabilities.models`: the models the app may use, and whether the choice is locked. */
export const USER_APP_MODELS_KEYS = Object.freeze(['allowed', 'lock']);

/** The keys of `capabilities.webSearchSettings`. */
export const USER_APP_WEB_SEARCH_SETTINGS_KEYS = Object.freeze([
  'maxPageReads',
  'researchGuidance'
]);

/**
 * The one entry the ceiling writes to `allowedModels` when an app restricts its
 * models and the owner or the person chatting may use none of them. No model
 * has this ID, so the chat does not start (`noCompatibleModels` of
 * `RequestBuilder`); dropping the restriction instead would give the person a
 * model the author excluded.
 */
export const NO_MODEL_AVAILABLE_ID = ':no-model-available';

/** The keys of one entry of `capabilities.integrations`. `actions` is required and not empty. */
export const USER_APP_INTEGRATION_KEYS = Object.freeze(['id', 'actions']);

/** An icon name: what the icon set uses, and nothing that could be a path. */
export const USER_APP_ICON_PATTERN = /^[a-z0-9-]{1,40}$/;

/** A colour as `#RRGGBB`. */
export const USER_APP_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/**
 * The caps of a personal app. Text limits count characters per language. The
 * names from `name` to `starterMessage` are those of the generator's draft
 * limits, so one object serves both.
 */
export const USER_APP_LIMITS = Object.freeze({
  /** Languages per localized text. */
  languages: 5,
  name: 100,
  description: 500,
  system: 8000,
  prompt: 4000,
  messagePlaceholder: 200,
  /** Input fields per app. */
  variables: 8,
  variableLabel: 80,
  variableDefault: 200,
  /** Options of one dropdown field. */
  options: 20,
  optionValue: 200,
  optionLabel: 100,
  /** Conversation starters per app. */
  starterPrompts: 4,
  starterTitle: 80,
  starterMessage: 500,
  /** Bound installations per app. */
  integrations: 5,
  /** Named actions per bound installation. */
  integrationActions: 30,
  /** Member entries per app. */
  members: 100,
  /** The title and the subtitle of the greeting on an empty chat. */
  greetingTitle: 80,
  greetingSubtitle: 200,
  /** The label of the send button of the start form. */
  submitLabel: 60,
  /** The most rows the input line may have. */
  inputRows: 20,
  /** Models an app may list in `capabilities.models.allowed`. */
  models: 10,
  /** The most pages the page reader may open for one answer. */
  pageReads: 50,
  /** The research guidance of web search. */
  researchGuidance: 1000,
  /** Projects an app may link: the documents it answers from. */
  projects: 3
});

/** The values of `origin`: how the app was started. `chat` is added with the chat-based builder. */
export const USER_APP_ORIGINS = Object.freeze(['blank', 'template', 'generated', 'copy']);

/** The roles a member can hold. The owner is not a member. */
export const USER_APP_MEMBER_ROLES = Object.freeze(['editor', 'user']);

/** What a member entry can name. */
export const USER_APP_MEMBER_TYPES = Object.freeze(['user', 'group', 'everyone']);

/** The stored states. A response can also say `retired`, which is computed per caller. */
export const USER_APP_STATES = Object.freeze(['active', 'promoted']);

/**
 * The verdict on every top-level key of `appConfigSchema`
 * (`server/validators/appConfigSchema.js`, `knownAppKeys`):
 *
 * - `content`: copied from the record after validation;
 * - `capability`: written by the ceiling, never copied from input;
 * - `fixed`: set by {@link personalAppBase};
 * - `never`: cannot be stored; the app object of a run has no such key.
 *
 * A key of the schema without a verdict fails a test. Decide the verdict
 * before adding the key here: `fixed` and `content` reach every chat of every
 * personal app.
 */
export const USER_APP_FIELD_POLICY = Object.freeze({
  // `content`, `capability` and the `never` of `category`: decided by the
  // registry (`shared/userAppFields.js`).
  ...appKeyVerdicts(),

  id: 'fixed',
  type: 'fixed',
  enabled: 'fixed',
  sendChatHistory: 'fixed',
  allowEmptyContent: 'fixed',
  features: 'fixed',

  redirectConfig: 'never',
  iframeConfig: 'never',
  preferredStyle: 'never',
  outputSchema: 'never',
  customResponseRenderer: 'never',
  rendererConfig: 'never',
  apps: 'never',
  workflows: 'never',
  iassistant: 'never',
  toolChoice: 'never',
  toolSearch: 'never',
  thinking: 'never',
  imageGeneration: 'never',
  aiDisclosure: 'never',
  usageGuide: 'never',
  ephemeral: 'never',
  documentTemplate: 'never',
  allowUserTemplateUploads: 'never',
  uploads: 'never',
  settings: 'never',
  order: 'never',
  requiredFeatures: 'never',
  requiredIntegrations: 'never',
  allowInheritance: 'never',
  parentId: 'never',
  inheritanceLevel: 'never',
  overriddenFields: 'never',
  sourceUserAppId: 'never'
});

/** The keys of {@link USER_APP_FIELD_POLICY} with one verdict, in the order of the policy. */
function keysWithVerdict(verdict) {
  return Object.keys(USER_APP_FIELD_POLICY).filter(key => USER_APP_FIELD_POLICY[key] === verdict);
}

/**
 * Every key the app object of a run can have: the seven of
 * {@link personalAppBase}, the nine content keys and the seven the ceiling
 * writes. The ceiling sets a content or capability key only when it has a
 * value, so a run object has a subset of these and never another key.
 */
export const USER_APP_RUN_KEYS = Object.freeze([
  ...keysWithVerdict('fixed'),
  ...keysWithVerdict('content'),
  ...keysWithVerdict('capability')
]);

/**
 * The keys `appConfigSchema` adds when it parses a run object, with the value
 * it adds. They are `never` keys; a parsed run object may carry exactly these
 * values and no other key outside {@link USER_APP_RUN_KEYS}.
 */
export const USER_APP_SCHEMA_DEFAULTS = Object.freeze({
  ephemeral: false,
  allowInheritance: false
});

/**
 * The start of the app object a chat runs with: every `fixed` key, written
 * out one by one. The ceiling adds the content and what it grants; nothing is
 * spread from a record or a request body.
 *
 * `allowEmptyContent` starts `false`; the server then derives it from the
 * message template. `features` keeps the person chatting from attaching a
 * project to a chat that follows another person's instructions.
 *
 * @param {string} id - The ID of the personal app.
 * @returns {object} A new object on every call.
 */
export function personalAppBase(id) {
  return {
    id,
    type: 'chat',
    enabled: true,
    sendChatHistory: true,
    allowEmptyContent: false,
    inputMode: {
      type: 'singleline',
      rows: 5,
      microphone: { enabled: true, mode: 'manual', showTranscript: true }
    },
    features: { projects: false, userProjects: false }
  };
}

/**
 * Freeze an object with everything in it. The upload objects below are shared
 * by every personal app of the process, so nothing may change them.
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * The `upload` block of a personal app with "Users can attach files" on. The
 * sizes and the two format lists are the values `newAppDefaults()` of
 * `shared/appDefaults.js` uses; a test compares them, so a change there is
 * noticed and decided, not inherited.
 *
 * Deeply frozen. A caller that has to change it copies it first
 * (`structuredClone`).
 */
export const PERSONAL_UPLOAD_ON = deepFreeze({
  enabled: true,
  imageUpload: {
    enabled: true,
    resizeImages: true,
    maxFileSizeMB: 10,
    supportedFormats: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
  },
  fileUpload: {
    enabled: true,
    maxFileSizeMB: 20,
    supportedFormats: [
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
    ]
  }
});

/** The `upload` block of a personal app with "Users can attach files" off. Frozen. */
export const PERSONAL_UPLOAD_OFF = deepFreeze({ enabled: false });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A copy of `source` with only the listed keys that are set. */
function pickKeys(source, keys) {
  const picked = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

/** Whether a key of an app's `integrations` object names one installation. */
function isInstallationKey(key) {
  return key !== '*' && !key.includes(':');
}

/** The action names of a binding: strings, each once. */
function namedActions(actions) {
  if (!Array.isArray(actions)) return [];
  return [...new Set(actions.filter(name => typeof name === 'string' && name !== ''))];
}

/**
 * `capabilities.integrations` from either form: the personal list
 * `[{ id, actions }]` or the object of an app config
 * `{ [installationId]: { actions } }`.
 *
 * A personal app binds named actions of named installations. A binding of
 * everything (`*`), of a definition (`type:…`) or without named actions has
 * no personal form and is left out.
 */
function pickIntegrations(value) {
  const entries = Array.isArray(value)
    ? value.filter(isPlainObject).map(entry => [entry.id, entry.actions])
    : isPlainObject(value)
      ? Object.entries(value).map(([id, binding]) => [id, binding?.actions])
      : [];

  const bindings = [];
  const seen = new Set();
  for (const [id, actions] of entries) {
    if (typeof id !== 'string' || id === '' || !isInstallationKey(id) || seen.has(id)) continue;
    const names = namedActions(actions);
    if (names.length === 0) continue;
    seen.add(id);
    bindings.push({ id, actions: names });
  }
  return bindings;
}

/**
 * `capabilities.models` from either form: the personal object `{ allowed, lock }`,
 * or an app config (`allowedModels`, `disallowModelSelection`). Only strings
 * that can be a model ID and a boolean `lock` are kept.
 */
function pickModels(value) {
  if (!isPlainObject(value)) return undefined;
  const list = Array.isArray(value.allowed) ? value.allowed : value.allowedModels;
  const lock = typeof value.lock === 'boolean' ? value.lock : value.disallowModelSelection;
  const allowed = Array.isArray(list)
    ? [...new Set(list.filter(id => typeof id === 'string' && id !== '' && id !== '*'))]
    : [];
  const models = {};
  if (allowed.length > 0) models.allowed = allowed;
  if (lock === true) models.lock = true;
  return Object.keys(models).length > 0 ? models : undefined;
}

/**
 * `capabilities.projects` from either form: the personal list `[{ id }]` or the
 * `projects` of an app config (a bare ID or `{ id, mode, write }`). Only the ID
 * is kept: a personal app links a project and the project's own knowledge mode
 * applies; it never writes into one.
 */
function pickProjects(value) {
  if (!Array.isArray(value)) return undefined;
  const ids = [];
  for (const entry of value) {
    const id = typeof entry === 'string' ? entry : isPlainObject(entry) ? entry.id : undefined;
    if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids.map(id => ({ id })) : undefined;
}

/** `capabilities.webSearchSettings` from the personal object or from `websearch` of an app config. */
function pickWebSearchSettings(value) {
  if (!isPlainObject(value)) return undefined;
  const settings = {};
  if (Number.isInteger(value.maxPageReads)) settings.maxPageReads = value.maxPageReads;
  if (typeof value.researchGuidance === 'string' && value.researchGuidance.trim() !== '') {
    settings.researchGuidance = value.researchGuidance;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * The `capabilities` object of a personal app. A draft that carries
 * `capabilities` already (a personal body, the editor's state) is read from
 * there, key by key; what it does not say is read from the keys of an app
 * config: `upload.enabled`, `websearch.enabled`, `skillSettings.enabled`,
 * `integrations`.
 */
function pickCapabilities(draft) {
  const own = isPlainObject(draft.capabilities) ? draft.capabilities : {};
  const flag = (key, fromConfig) =>
    typeof own[key] === 'boolean' ? own[key] : fromConfig?.enabled === true;
  const capabilities = {
    upload: flag('upload', draft.upload),
    webSearch: flag('webSearch', draft.websearch),
    skills: flag('skills', draft.skillSettings),
    integrations: pickIntegrations(
      Object.hasOwn(own, 'integrations') ? own.integrations : draft.integrations
    )
  };
  const models = pickModels(Object.hasOwn(own, 'models') ? own.models : draft);
  if (models) capabilities.models = models;
  const projects = pickProjects(Object.hasOwn(own, 'projects') ? own.projects : draft.projects);
  if (projects) capabilities.projects = projects;
  const search = pickWebSearchSettings(
    Object.hasOwn(own, 'webSearchSettings') ? own.webSearchSettings : draft.websearch
  );
  if (search) capabilities.webSearchSettings = search;
  return capabilities;
}

/**
 * The greeting: one `{ title, subtitle }` per language that has both texts and
 * is not the platform's default text of that language.
 */
function pickGreeting(value, defaults) {
  if (!isPlainObject(value)) return undefined;
  const greeting = {};
  for (const [language, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue;
    const picked = pickKeys(entry, USER_APP_GREETING_KEYS);
    if (typeof picked.title !== 'string' || typeof picked.subtitle !== 'string') continue;
    const standard = defaults?.[language];
    if (standard?.title === picked.title && standard?.subtitle === picked.subtitle) continue;
    greeting[language] = picked;
  }
  return Object.keys(greeting).length > 0 ? greeting : undefined;
}

/**
 * The keys that change how the chat looks and starts: greeting, input line,
 * output format, start form, input panel and `autoStart`. Each is picked only
 * when it is set, has a value a personal app may store, and is not what a new
 * app starts with anyway (`newAppDefaults()`): a default is not a choice of the
 * author, and an app from a draft or from the run object of a chat would
 * otherwise store the platform's defaults as its own.
 */
function pickLooks(source) {
  const defaults = newAppDefaults('en');
  const looks = {};
  const greeting = pickGreeting(source.greeting, defaults.greeting);
  if (greeting) looks.greeting = greeting;
  if (isPlainObject(source.inputMode)) {
    const inputMode = pickKeys(source.inputMode, USER_APP_INPUT_MODE_KEYS);
    for (const key of Object.keys(inputMode)) {
      if (inputMode[key] === defaults.inputMode[key]) delete inputMode[key];
    }
    if (Object.keys(inputMode).length > 0) looks.inputMode = inputMode;
  }
  if (
    USER_APP_OUTPUT_FORMATS.includes(source.preferredOutputFormat) &&
    source.preferredOutputFormat !== defaults.preferredOutputFormat
  ) {
    looks.preferredOutputFormat = source.preferredOutputFormat;
  }
  if (isPlainObject(source.startForm)) {
    const startForm = structuredClone(pickKeys(source.startForm, USER_APP_START_FORM_KEYS));
    if (Object.keys(startForm).length > 0) looks.startForm = startForm;
  }
  if (isPlainObject(source.variablesPanel)) {
    const panel = pickKeys(source.variablesPanel, USER_APP_VARIABLES_PANEL_KEYS);
    if (Object.keys(panel).length > 0) looks.variablesPanel = panel;
  }
  if (source.autoStart === true) looks.autoStart = true;
  return looks;
}

/**
 * The content of a personal app from a draft: the body of `POST /api/apps`
 * without `language` and `origin`. The draft is an app config (a template, a
 * generated draft, `newAppDefaults()`) or a personal body; the result has
 * only the keys of {@link USER_APP_CONTENT_KEYS}, input fields and
 * conversation starters have only their allowed keys, and `capabilities` is
 * always complete.
 *
 * It selects and does not validate: a text over its limit or an eleventh
 * input field stays, and the server names it.
 *
 * @param {object} draft
 * @returns {object} A new object; `draft` is not modified.
 *
 * @example
 * pickUserAppContent({ id: 'x', category: 'utility', name: { de: 'Helfer' }, websearch: { enabled: true } });
 * // → { name: { de: 'Helfer' },
 * //     capabilities: { upload: false, webSearch: true, skills: false, integrations: [] } }
 */
export function pickUserAppContent(draft) {
  const source = isPlainObject(draft) ? draft : {};
  const content = {};

  for (const key of USER_APP_LOCALIZED_KEYS) {
    if (isPlainObject(source[key])) content[key] = { ...source[key] };
  }
  for (const key of ['icon', 'color']) {
    if (typeof source[key] === 'string' && source[key] !== '') content[key] = source[key];
  }
  if (Array.isArray(source.variables)) {
    content.variables = source.variables
      .filter(isPlainObject)
      .map(variable => structuredClone(pickKeys(variable, USER_APP_VARIABLE_KEYS)));
  }
  if (Array.isArray(source.starterPrompts)) {
    content.starterPrompts = source.starterPrompts
      .filter(isPlainObject)
      .map(starter => structuredClone(pickKeys(starter, USER_APP_STARTER_PROMPT_KEYS)));
  }
  Object.assign(content, pickLooks(source));
  if (typeof source.preferredModel === 'string' && source.preferredModel !== '') {
    content.preferredModel = source.preferredModel;
  }
  content.capabilities = pickCapabilities(source);

  return pickKeys(content, USER_APP_CONTENT_KEYS);
}
