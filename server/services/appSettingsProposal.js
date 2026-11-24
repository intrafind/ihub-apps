// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The settings a model may propose in a revision turn (`change.settings`).
 *
 * The registry of configurable keys (`shared/userAppFields.js`) says which
 * keys these are and how each is offered: `direct` keys are part of the patch
 * the author applies with the change, `confirm` keys are separate items the
 * author ticks. This module reads what a model proposed, checks every value
 * against the schema of its key, and splits the result:
 *
 * - `patch`: the `direct` keys whose checked value differs from the app's own;
 * - `suggestions`: the `confirm` keys (`{ key, value }`), never part of the
 *   patch;
 * - `warnings`: a `KEY_IGNORED` per key that is not offered in this turn or
 *   whose value the schema refuses.
 *
 * The value a model writes is not trusted: each is parsed with the same Zod
 * schema a save uses (`userAppFieldSchemas`), so a value that passes here is
 * one a save accepts, and the schema removes hidden characters and applies the
 * caps. Nothing is stored.
 *
 * Design: concepts/app-builder-rework-2026-11/07-configurable-personal-apps.md,
 * section 2.6.
 *
 * @module services/appSettingsProposal
 */
import { appSettingsKeys } from '../../shared/appRevision.js';
import { userAppField } from '../../shared/userAppFields.js';
import { userAppCapabilitySchemas, userAppFieldSchemas } from '../validators/userAppSchema.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a setting is "not set": the editor's form holds an unset one as an
 * empty object, an empty text or `false`, an app file as nothing at all.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUnsetSetting(value) {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    value === false ||
    (isPlainObject(value) && Object.keys(value).length === 0)
  );
}

function sameValue(a, b) {
  return (
    JSON.stringify(isUnsetSetting(a) ? null : a) === JSON.stringify(isUnsetSetting(b) ? null : b)
  );
}

/**
 * The schema of the value of one setting: the entry of `capabilities` for a
 * setting that lives there, else the entry of the content key.
 */
function schemaOf(key) {
  return userAppField(key)?.store === 'capabilities'
    ? userAppCapabilitySchemas[key]
    : userAppFieldSchemas[key];
}

/**
 * The value of a setting in an app as the editor holds it: inside `capabilities`
 * for a setting that lives there, else at the top.
 *
 * @param {Object} app
 * @param {string} key
 * @returns {unknown}
 */
export function settingOf(app, key) {
  if (!isPlainObject(app)) return undefined;
  return userAppField(key)?.store === 'capabilities' ? app.capabilities?.[key] : app[key];
}

/**
 * The settings the builder may propose in this turn, with the line the model
 * reads about each.
 *
 * A setting behind an administrator switch (`gate`) is offered for a personal
 * app only while that switch is on; web search settings also need a search
 * engine the caller may use.
 *
 * @param {Object} options
 * @param {'admin'|'personal'} options.target
 * @param {readonly string[]} [options.fields] - The request's `fields`; when it names
 *   keys, only those settings are offered.
 * @param {{ settings?: Object, searchAvailable?: boolean }|null} [options.personal] - For a
 *   personal app: the effective `platform.userApps` settings and whether the caller has web search.
 * @returns {Array<{ key: string, hint: string, proposal: 'direct'|'confirm' }>}
 */
export function settingsToPropose({ target, fields, personal = null } = {}) {
  const narrowed = Array.isArray(fields) && fields.length > 0;
  return appSettingsKeys(target)
    .filter(key => !narrowed || fields.includes(key))
    .filter(key => {
      const { gate } = userAppField(key);
      if (!gate || !personal) return true;
      if (personal.settings?.capabilities?.[gate] !== true) return false;
      return gate !== 'webSearch' || personal.searchAvailable === true;
    })
    .map(key => {
      const { hint, proposal } = userAppField(key);
      return { key, hint, proposal };
    });
}

/**
 * The value an admin app stores where a personal app stores nothing: a personal
 * app removes a key it does not use, an admin app writes the value out.
 */
function adminValue(key, parsed) {
  if (parsed !== undefined) return parsed;
  return key === 'autoStart' ? false : null;
}

/**
 * Read `change.settings` of a model's answer.
 *
 * @param {unknown} raw - `answer.change.settings`.
 * @param {Object} options
 * @param {'admin'|'personal'} options.target
 * @param {Array<{ key: string }>} options.offered - {@link settingsToPropose} for this turn.
 * @param {Object} options.current - The app's own values of the keys, hidden characters removed.
 * @param {(key: string, value: unknown) => boolean} [options.allow] - Whether the caller may have
 *   a `confirm` setting with this value; the ceiling of personal apps answers it. A setting it
 *   refuses is left out without a word, like a suggestion the caller may not use.
 * @returns {{ patch: Object, changed: string[], suggestions: Array<{ key: string, value: unknown }>,
 *   warnings: Array<{ code: string, field: string }> }}
 *
 * @example
 * readSettings({ autoStart: true }, { target: 'personal', offered, current: {} });
 * // → { patch: { autoStart: true }, changed: ['autoStart'], suggestions: [], warnings: [] }
 */
export function readSettings(raw, { target, offered, current, allow }) {
  const result = { patch: {}, changed: [], suggestions: [], warnings: [] };
  if (!isPlainObject(raw)) return result;
  const known = new Map(offered.map(entry => [entry.key, entry]));
  for (const [key, value] of Object.entries(raw)) {
    const entry = known.get(key);
    const schema = entry ? schemaOf(key) : undefined;
    if (!entry || !schema) {
      result.warnings.push({
        code: 'KEY_IGNORED',
        field: /^[A-Za-z0-9_.-]{1,40}$/.test(key) ? key : '?'
      });
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      result.warnings.push({ code: 'KEY_IGNORED', field: key });
      continue;
    }
    const checked = target === 'personal' ? (parsed.data ?? null) : adminValue(key, parsed.data);
    if (sameValue(checked, current?.[key])) continue;
    if (entry.proposal === 'confirm') {
      if (isUnsetSetting(checked) || allow?.(key, checked) === false) continue;
      result.suggestions.push({ key, value: checked });
    } else {
      result.patch[key] = checked;
      result.changed.push(key);
    }
  }
  return result;
}
