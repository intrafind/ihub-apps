// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the server and the client share about personal apps (feature
 * `userApps`): the shape of their IDs, the keys and limits of their content,
 * the verdict on every key of the app schema, and the fixed parts of the app
 * object a chat runs with.
 *
 * Pure; no function modifies its argument. This file imports nothing, so
 * `shared/appId.js` and the validators can import it without a cycle.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 4.2 and 4.4.
 *
 * @module shared/userAppContent
 */

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
export const USER_APP_CONTENT_KEYS = Object.freeze([
  'name',
  'description',
  'system',
  'icon',
  'color',
  'prompt',
  'messagePlaceholder',
  'variables',
  'starterPrompts',
  'preferredModel',
  'capabilities'
]);

/** The content keys that hold one text per language. */
export const USER_APP_LOCALIZED_KEYS = Object.freeze([
  'name',
  'description',
  'system',
  'prompt',
  'messagePlaceholder'
]);

/** The localized content keys an app cannot be saved without. */
export const USER_APP_REQUIRED_KEYS = Object.freeze(['name', 'description', 'system']);

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

/** The keys of `capabilities`: three switches and the list of bound installations. */
export const USER_APP_CAPABILITY_KEYS = Object.freeze([
  'upload',
  'webSearch',
  'skills',
  'integrations'
]);

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
  members: 100
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
  name: 'content',
  description: 'content',
  icon: 'content',
  color: 'content',
  system: 'content',
  prompt: 'content',
  messagePlaceholder: 'content',
  variables: 'content',
  starterPrompts: 'content',

  preferredModel: 'capability',
  upload: 'capability',
  websearch: 'capability',
  skills: 'capability',
  skillSettings: 'capability',
  integrations: 'capability',
  toolApproval: 'capability',

  id: 'fixed',
  type: 'fixed',
  enabled: 'fixed',
  sendChatHistory: 'fixed',
  allowEmptyContent: 'fixed',
  inputMode: 'fixed',
  features: 'fixed',

  redirectConfig: 'never',
  iframeConfig: 'never',
  preferredOutputFormat: 'never',
  preferredStyle: 'never',
  outputSchema: 'never',
  customResponseRenderer: 'never',
  rendererConfig: 'never',
  projects: 'never',
  apps: 'never',
  workflows: 'never',
  iassistant: 'never',
  toolChoice: 'never',
  toolSearch: 'never',
  thinking: 'never',
  imageGeneration: 'never',
  startForm: 'never',
  variablesPanel: 'never',
  greeting: 'never',
  aiDisclosure: 'never',
  usageGuide: 'never',
  allowedModels: 'never',
  disallowModelSelection: 'never',
  autoStart: 'never',
  ephemeral: 'never',
  documentTemplate: 'never',
  allowUserTemplateUploads: 'never',
  uploads: 'never',
  settings: 'never',
  category: 'never',
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
  disallowModelSelection: false,
  autoStart: false,
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
  return {
    upload: flag('upload', draft.upload),
    webSearch: flag('webSearch', draft.websearch),
    skills: flag('skills', draft.skillSettings),
    integrations: pickIntegrations(
      Object.hasOwn(own, 'integrations') ? own.integrations : draft.integrations
    )
  };
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
  if (typeof source.preferredModel === 'string' && source.preferredModel !== '') {
    content.preferredModel = source.preferredModel;
  }
  content.capabilities = pickCapabilities(source);

  return pickKeys(content, USER_APP_CONTENT_KEYS);
}
