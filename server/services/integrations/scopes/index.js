// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Integration scopes (#3050): where an integration searches or whom it asks,
 * picked by the user per chat.
 *
 * An integration that offers a scope registers a provider here, keyed by its
 * integration id. The chat input, the scope route and the chat route only talk
 * to this registry, so none of them knows which store or AI is behind a
 * scope. When the unified integrations framework lands (#2913), a provider
 * becomes the adapter's `scopes(instance, ctx)`.
 *
 * A provider is an object with:
 *
 *   - `id` — the integration id (`ifinder`, `iassistant`);
 *   - `appliesTo({ app, model, user })` — whether the app (with the chat's
 *     model) uses the integration at all, for this user;
 *   - `listScopes({ user, app, model, language, signal })` — resolves to
 *     `{ scopes, defaultScope, fixed, source, hint? }`, where `scopes` is
 *     `[{ id, name, isDefault, description?, kind? }]`. It never resolves to
 *     an empty list: when the integration cannot be asked, it offers the
 *     configured default;
 *   - `validateScope({ scopeId, user, app, model, language, signal })` —
 *     resolves to `{ ok: true, scopeId, fixed }` with the scope to use (`null`
 *     for "none picked") or `{ ok: false, code, message }`.
 *
 * Per-app settings live under `app.integrations.<id>` (see
 * `validators/appConfigSchema.js`): `scopePicker` (`menu | hidden`),
 * `defaultScope` and `pinnedScope`.
 */
import { isScopeIdShape } from './common.js';

export {
  SCOPE_PICKER_PLACEMENTS,
  MAX_SCOPE_ID_LENGTH,
  appScopeSettings,
  isScopeIdShape,
  pickDefaultScope
} from './common.js';

/** @type {Map<string, Object>} */
const providers = new Map();

/**
 * Register a scope provider, replacing one registered under the same id.
 * @param {Object} provider - see the module comment
 */
export function registerScopeProvider(provider) {
  if (!provider?.id) throw new Error('A scope provider needs an id');
  providers.set(provider.id, provider);
}

/**
 * Remove a provider (an installed integration that was disabled or removed).
 * @param {string} integrationId
 */
export function unregisterScopeProvider(integrationId) {
  providers.delete(integrationId);
}

/**
 * The provider registered for an integration id, or null.
 * @param {string} integrationId
 * @returns {Object|null}
 */
export function getScopeProvider(integrationId) {
  return (typeof integrationId === 'string' && providers.get(integrationId)) || null;
}

/** Every registered provider, in registration order. */
export function listScopeProviders() {
  return [...providers.values()];
}

/**
 * The providers whose integration the app uses with this model, for this user.
 * @param {Object} params
 * @param {Object} params.app
 * @param {Object} [params.model]
 * @param {Object} [params.user]
 * @returns {Array<Object>}
 */
export function applicableScopeProviders({ app, model, user }) {
  return listScopeProviders().filter(provider => {
    try {
      return provider.appliesTo({ app, model, user });
    } catch {
      return false;
    }
  });
}

/**
 * The scopes a chat turn runs with, checked against what each integration
 * offers the user.
 *
 * Only integrations the app uses are looked at; a scope named for any other
 * is dropped. A pinned scope (by the app or the installation) replaces what
 * the request asked for. A scope the user may not use refuses the turn.
 *
 * @param {Object} params
 * @param {unknown} params.requested - `{ [integrationId]: scopeId }` from the
 *   request body, or the chat's stored settings
 * @param {Object} params.user
 * @param {Object} params.app
 * @param {Object} [params.model]
 * @param {string} [params.language]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ ok: true, scopes: Object<string, string> } |
 *   { ok: false, integrationId: string, code: string, message: string }>}
 */
export async function resolveChatScopes({ requested, user, app, model, language, signal }) {
  const asked =
    requested && typeof requested === 'object' && !Array.isArray(requested) ? requested : {};
  const scopes = {};
  for (const provider of applicableScopeProviders({ app, model, user })) {
    const scopeId = Object.hasOwn(asked, provider.id) ? asked[provider.id] : null;
    if (scopeId !== null && scopeId !== undefined && !isScopeIdShape(scopeId)) {
      return {
        ok: false,
        integrationId: provider.id,
        code: 'INVALID_INTEGRATION_SCOPE',
        message: `Invalid scope for ${provider.id}`
      };
    }
    const result = await provider.validateScope({
      scopeId: scopeId || null,
      user,
      app,
      model,
      language,
      signal
    });
    if (!result.ok) return { ...result, integrationId: provider.id };
    if (result.scopeId) scopes[provider.id] = result.scopeId;
  }
  return { ok: true, scopes };
}

// The built-in iFinder and iAssistant providers are registered with their
// installations by `integrationTools.syncIntegrationScopeProviders`.
