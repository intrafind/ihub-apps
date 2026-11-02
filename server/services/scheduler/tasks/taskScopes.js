// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The integration scopes of a scheduled task (#3057): where its iFinder
 * tools search and which iAssistant it asks, snapshotted when the task is
 * created.
 *
 * A task stores `integrationScopes` (`{ [integrationId]: scopeId }`, the
 * shape a chat stores in its settings) from the chat it was scheduled from,
 * or as picked in the task editor. Every run binds its tools to that
 * snapshot and never reads chat state, so moving the chat to another scope
 * later does not change the task. A task without a snapshot runs as before
 * scopes existed: its tools search the default, or where the model asks.
 *
 * Both the save and every run check the snapshot against what the
 * integrations offer the owner (`resolveChatScopes`, as a chat turn does): a
 * scope the owner may not use is refused when the task is saved, and fails
 * the run, naming the scope, rather than searching somewhere else.
 *
 * @module services/scheduler/tasks/taskScopes
 */
import configCache from '../../../configCache.js';
import { findByIdCaseInsensitive } from '../../../utils/resourceLookup.js';
import { normalizeChatSettings } from '../../chat/ChatRepository.js';
import { resolveChatScopes } from '../../integrations/scopes/index.js';

/** The model a task's turns run on: its own, else the app's preferred one. */
function taskModel(app, modelId) {
  const { data: models = [] } = configCache.getModels() || {};
  const id = modelId || app?.preferredModel;
  return id ? findByIdCaseInsensitive(models, id) : null;
}

/**
 * The scopes a request names, in the shape a chat stores them, or null.
 *
 * @param {unknown} raw
 * @returns {{ scopes: Object<string, string>|null, invalid: boolean }}
 */
function shapeOf(raw) {
  if (raw === null || raw === undefined) return { scopes: null, invalid: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { scopes: null, invalid: true };
  const scopes = normalizeChatSettings({ integrationScopes: raw })?.integrationScopes || null;
  // An entry the chat would not store is refused, not dropped: the task
  // must not run unscoped where the user asked for a scope.
  const invalid = Object.keys(raw).length !== Object.keys(scopes || {}).length;
  return { scopes, invalid };
}

/**
 * The integration scopes a task saves, checked as the owner.
 *
 * Integrations the app does not use are dropped, as in a chat; a scope the
 * app or the installation pins replaces the one asked for.
 *
 * @param {unknown} raw - `integrationScopes` from the request (or the task being edited)
 * @param {Object} params
 * @param {Object} params.user - Expanded owner principal.
 * @param {Object|null} params.app - The task's app; nothing is checked without one.
 * @param {string|null} [params.modelId] - The task's model override.
 * @param {string} [params.language]
 * @returns {Promise<{ scopes: Object<string, string>|null, error?: {code: string, message: string} }>}
 *   `scopes` is null when the task binds none
 */
export async function validateTaskScopes(raw, { user, app, modelId = null, language = 'en' }) {
  const { scopes, invalid } = shapeOf(raw);
  if (invalid) {
    return {
      scopes: null,
      error: {
        code: 'INVALID',
        message: 'Integration scopes must map an integration id to a scope id'
      }
    };
  }
  if (!scopes || !app) return { scopes: null };
  const resolution = await resolveChatScopes({
    requested: scopes,
    user,
    app,
    model: taskModel(app, modelId),
    language
  });
  if (!resolution.ok) {
    return { scopes: null, error: { code: resolution.code, message: resolution.message } };
  }
  return { scopes: Object.keys(resolution.scopes).length > 0 ? resolution.scopes : null };
}

/**
 * The scopes one run binds its tools to: the task's snapshot, checked again
 * as the owner, since access may have changed since the task was saved.
 *
 * @param {Object} task
 * @param {Object} params
 * @param {Object} params.user - The owner, resolved for this run.
 * @param {Object} params.app
 * @param {string} [params.language]
 * @returns {Promise<{ ok: true, scopes: Object<string, string>|null } |
 *   { ok: false, integrationId: string, code: string, message: string }>}
 *   `scopes` is null for a task without a snapshot, which runs unscoped as before
 */
export async function resolveRunScopes(task, { user, app, language = 'en' }) {
  const { scopes, invalid } = shapeOf(task?.integrationScopes);
  if (invalid) {
    return {
      ok: false,
      integrationId: '',
      code: 'INVALID_INTEGRATION_SCOPE',
      message: 'The task names its integration scopes in a form that cannot be used'
    };
  }
  if (!scopes) return { ok: true, scopes: null };
  const resolution = await resolveChatScopes({
    requested: scopes,
    user,
    app,
    model: taskModel(app, task.modelId),
    language
  });
  if (!resolution.ok) return resolution;
  return { ok: true, scopes: resolution.scopes };
}
