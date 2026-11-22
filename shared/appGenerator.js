// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the server and the client share about the app draft generator
 * (`POST /api/admin/apps/_generate`, `server/services/appGenerator.js`): the
 * limits of the request, the values of the answer and the check that turns a
 * model's pick of integrations into bindings.
 *
 * Pure; no function modifies its argument.
 *
 * @module shared/appGenerator
 */

/** The longest description `_generate` accepts, counted after trimming. */
export const APP_GENERATOR_DESCRIPTION_MAX = 2000;

/** `details.limiter` of the 429 the draft limit answers with. */
export const APP_GENERATOR_LIMITER = 'appGenerator';

/** How many drafts one person may ask for per window of the draft limit. */
export const APP_GENERATOR_DRAFT_LIMIT = 30;

/** The window of the draft limit, in milliseconds (one hour). */
export const APP_GENERATOR_DRAFT_WINDOW_MS = 60 * 60 * 1000;

/**
 * `details.reason` of `APP_GENERATOR_INVALID_ANSWER`: the answer holds no JSON
 * object, it was cut off, or it lacks what an app needs.
 */
export const APP_GENERATOR_INVALID_REASONS = Object.freeze(['not-json', 'truncated', 'incomplete']);

/**
 * The codes of `warnings[]` in the answer, each with what happened to the
 * model's answer:
 *
 * - `dropped`: a part the author may miss was left out;
 * - `shortened`: a text was cut to its limit;
 * - `replaced`: a value was not accepted and the default stands in;
 * - `added`: the server added something the model forgot;
 * - `ignored`: a key a draft never sets was not read.
 *
 * A warning is `{ code, field }`; `field` names the place in the app.
 */
export const APP_GENERATOR_WARNINGS = Object.freeze({
  /** An input field with an unusable or repeated name, or one beyond the eighth. */
  FIELD_DROPPED: 'dropped',
  /** The default of an input field that does not fit its type or its options. */
  FIELD_DEFAULT_DROPPED: 'dropped',
  /** The instructions name the placeholder of an input field that was dropped. */
  PLACEHOLDER_WITHOUT_FIELD: 'dropped',
  /** A conversation starter without title or message, or one beyond the fourth. */
  STARTER_DROPPED: 'dropped',
  /** A text longer than its limit. */
  TEXT_SHORTENED: 'shortened',
  /** A category the installation does not have. */
  CATEGORY_REPLACED: 'replaced',
  /** A colour that is not `#RRGGBB`. */
  COLOR_REPLACED: 'replaced',
  /** An icon name outside lowercase letters, digits and hyphens. */
  ICON_REPLACED: 'replaced',
  /** An input field with a type the app schema does not know, or a dropdown without options. */
  FIELD_TYPE_REPLACED: 'replaced',
  /** The answer had no short description; the first sentence of the request stands in. */
  DESCRIPTION_ADDED: 'added',
  /** An input field no text used got its line in the message template. */
  FIELD_ADDED_TO_TEMPLATE: 'added',
  /** A key of the answer that a draft never sets (`type`, `upload`, `preferredModel`, …). */
  KEY_IGNORED: 'ignored'
});

/**
 * The values of the query parameter `origin` of `POST /api/admin/apps`: how
 * the app was started. It is audit metadata and changes nothing else.
 */
export const APP_CREATE_ORIGINS = Object.freeze([
  'blank',
  'template',
  'copy',
  'generated',
  'link',
  'upload'
]);

/**
 * The `integrations` object of an app from the generator's answer: only
 * installed integrations, each once. An integration's action list is kept only
 * where the integration declares its actions and the answer names some of
 * them; an unknown name is dropped (a made-up one would fail the binding's
 * name rule or offer no tool), and an integration without declared actions
 * (an MCP server) is bound whole.
 *
 * @param {unknown} picked - `[{ id, actions? }]`
 * @param {Array<{ id: string, actions?: string[] }>} installed - the integrations the brief listed
 * @returns {Object|undefined} undefined when nothing valid was picked
 */
export function integrationsFromAnswer(picked, installed) {
  if (!Array.isArray(picked) || !Array.isArray(installed)) return undefined;
  const declared = new Map(installed.map(entry => [entry.id, entry.actions || []]));
  const bindings = {};
  for (const entry of picked) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string' || !declared.has(id) || Object.hasOwn(bindings, id)) continue;
    const known = new Set(declared.get(id));
    const actions = Array.isArray(entry?.actions)
      ? [...new Set(entry.actions.filter(name => known.has(name)))]
      : [];
    bindings[id] = actions.length > 0 ? { actions } : {};
  }
  return Object.keys(bindings).length > 0 ? bindings : undefined;
}
