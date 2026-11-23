// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Assemble a run from an app: model, messages, tools and options, the way a
 * chat turn of the app is prepared (`ChatService.prepareChatRequest`).
 *
 * The app's prompt template and the call's variables are put on the last user
 * message (`withAppPrompt`), where the prompt service reads them: a headless
 * caller builds its messages itself, without the browser that puts them there.
 *
 * The integration scopes a caller hands over (the scopes the person picked
 * for the calling chat, #3050) are checked against what each integration
 * offers this principal in the called app (`resolveChatScopes`); a scope the
 * principal may not use there refuses the run, as it refuses a chat turn.
 * Only the scopes the caller named are kept: an app called without any runs
 * without a scope binding, as before.
 *
 * @module services/run/assemble/fromApp
 */

import configCache from '../../../configCache.js';
import { findByIdCaseInsensitive } from '../../../utils/resourceLookup.js';
import { withAppPrompt } from '../../chat/appPrompt.js';
import { resolveChatScopes } from '../../integrations/scopes/index.js';

const hasEntries = value =>
  Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);

/**
 * The caller's scopes as they hold in the called app, or the refusal.
 *
 * @param {Object} params
 * @returns {Promise<{ok: true, scopes: Object<string, string>} |
 *   {ok: false, code: string, message: string}>}
 */
async function calleeScopes({ requested, app, modelId, principal, language, signal }) {
  if (!hasEntries(requested)) return { ok: true, scopes: {} };
  const model = findByIdCaseInsensitive(
    configCache.getModels?.()?.data || [],
    modelId || app.preferredModel
  );
  const resolution = await resolveChatScopes({
    requested,
    user: principal,
    app,
    model,
    language,
    signal
  });
  if (!resolution.ok) return resolution;
  const scopes = {};
  for (const [integrationId, scopeId] of Object.entries(resolution.scopes)) {
    if (Object.hasOwn(requested, integrationId)) scopes[integrationId] = scopeId;
  }
  return { ok: true, scopes };
}

/**
 * Prepare the run of an app.
 *
 * @param {Object} params
 * @param {{prepareChatRequest: Function}} params.chatService - prepares the request
 * @param {string} params.appId
 * @param {Array<Object>} params.messages - the conversation; the last entry is the user's message
 * @param {Object} [params.variables] - app variables for the prompt template
 * @param {string} [params.modelId] - a model override (checked against the app and the principal)
 * @param {string} params.language
 * @param {Object} params.principal - the identity the run acts as
 * @param {string} params.chatId
 * @param {Object<string, string>} [params.integrationScopes] - the caller's scopes
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ok: true, data: Object, integrationScopes: Object<string, string>} |
 *   {ok: false, error: {code?: string, message: string}}>}
 */
export async function assembleFromApp({
  chatService,
  appId,
  messages,
  variables = {},
  modelId,
  language,
  principal,
  chatId,
  integrationScopes,
  signal
}) {
  const { data: knownApps = [] } = configCache.getApps();
  const app = findByIdCaseInsensitive(knownApps, appId);
  const scopes = await calleeScopes({
    requested: integrationScopes,
    app: app || { id: appId },
    modelId,
    principal,
    language,
    signal
  });
  if (!scopes.ok) {
    return { ok: false, error: { code: scopes.code, message: scopes.message } };
  }
  const prepared = await chatService.prepareChatRequest({
    appId,
    modelId,
    messages: withAppPrompt(messages, variables, app?.prompt || null),
    language,
    user: principal,
    chatId,
    ...(hasEntries(scopes.scopes) ? { integrationScopes: scopes.scopes } : {})
  });
  if (!prepared.success) return { ok: false, error: prepared.error };
  return { ok: true, data: prepared.data, integrationScopes: scopes.scopes };
}

export default assembleFromApp;
