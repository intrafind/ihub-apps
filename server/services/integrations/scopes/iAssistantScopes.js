// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * iAssistant scopes: whom a chat asks ("ask …").
 *
 * A chat whose model is an iAssistant (`iassistant-conversation`) can ask:
 *
 *   - `assistant:<id>` — one of the iFinder iAssistants the user can see
 *     (`iFinderAssistants`), which brings its own conversation and search
 *     profile;
 *   - `configured` — the conversation and search profile the app or model
 *     configures (`iassistant.profileId` / `searchProfile`), offered when the
 *     app names no iAssistant itself;
 *   - `all` — every search profile the user has (`allSearchProfiles`), when
 *     the app allows it (`integrations.iassistant.allowAllSearchProfiles`, or
 *     the app searches all profiles already).
 *
 * The ids are prefixed, so an iAssistant id can never collide with the two
 * fixed ones. Users cannot override an iAssistant's own search profile; that
 * stays an admin setting.
 *
 * {@link scopeToConversationConfig} maps a scope onto the settings the
 * adapter and the conversation routes resolve the profiles from.
 */
import iAssistantService from '../iAssistantService.js';
import iFinderAssistants from '../iFinderAssistants.js';
import logger from '../../../utils/logger.js';
import { appScopeSettings, pickDefaultScope } from './common.js';

export const INTEGRATION_ID = 'iassistant';

export const CONFIGURED_SCOPE = 'configured';
export const ALL_SEARCH_PROFILES_SCOPE = 'all';
const ASSISTANT_PREFIX = 'assistant:';
const ALL_PROFILES_NAME = Object.freeze({
  en: 'All my search profiles',
  de: 'Alle meine Suchprofile'
});

/** The scope id of an iFinder iAssistant. */
export function assistantScopeId(assistantId) {
  return `${ASSISTANT_PREFIX}${assistantId}`;
}

/**
 * The adapter settings a scope stands for, or null for an id that is no
 * iAssistant scope.
 * @param {string} scopeId
 * @returns {{ assistantId: string|undefined, allSearchProfiles: boolean }|null}
 */
export function scopeToConversationConfig(scopeId) {
  if (scopeId === ALL_SEARCH_PROFILES_SCOPE) {
    return { assistantId: undefined, allSearchProfiles: true };
  }
  if (scopeId === CONFIGURED_SCOPE) return { assistantId: undefined, allSearchProfiles: false };
  if (typeof scopeId === 'string' && scopeId.startsWith(ASSISTANT_PREFIX)) {
    const assistantId = scopeId.slice(ASSISTANT_PREFIX.length);
    return assistantId ? { assistantId, allSearchProfiles: false } : null;
  }
  return null;
}

/**
 * The scope a stored conversation was created with, so a changed scope can be
 * told apart from the one the conversation already runs in.
 * @param {Object} state - conversation state (`ConversationStateManager`)
 * @returns {string}
 */
export function conversationScopeOf(state) {
  if (typeof state?.scopeId === 'string' && state.scopeId) return state.scopeId;
  if (state?.assistantId) return assistantScopeId(state.assistantId);
  return state?.searchScope === 'all' ? ALL_SEARCH_PROFILES_SCOPE : CONFIGURED_SCOPE;
}

/** The app/model iAssistant settings, as the adapter resolves them. */
function configuredSetup(app, model) {
  const appConfig = app?.iassistant || {};
  const modelConfig = model?.config || {};
  const serviceConfig = iAssistantService.getConfig();
  return {
    baseUrl: appConfig.baseUrl || modelConfig.baseUrl || serviceConfig.baseUrl,
    assistantId: appConfig.assistantId || modelConfig.assistantId || null,
    allSearchProfiles: appConfig.allSearchProfiles ?? modelConfig.allSearchProfiles ?? false,
    searchProfile:
      appConfig.searchProfile || modelConfig.searchProfile || serviceConfig.defaultSearchProfile,
    cacheTtlMs: serviceConfig.searchProfileCacheTtlMs
  };
}

const iAssistantScopes = {
  id: INTEGRATION_ID,
  name: { en: 'iAssistant', de: 'iAssistant' },
  // A scope is whom the integration asks ("ask …").
  action: 'ask',

  appliesTo({ model }) {
    return model?.provider === 'iassistant-conversation';
  },

  async listScopes({ user, app, model, language, signal }) {
    const setup = configuredSetup(app, model);
    const settings = appScopeSettings(app, INTEGRATION_ID);
    const offerAll = settings.allowAllSearchProfiles ?? setup.allSearchProfiles === true;

    const scopes = [];
    if (!setup.assistantId) {
      const profile = setup.searchProfile ? ` (${setup.searchProfile})` : '';
      scopes.push({
        id: CONFIGURED_SCOPE,
        kind: 'configured',
        name: { en: `App default${profile}`, de: `App-Standard${profile}` }
      });
    }

    let source = 'ifinder';
    let hint;
    let assistants = null;
    if (user?.id && user.id !== 'anonymous' && setup.baseUrl) {
      try {
        assistants = await iFinderAssistants.listAssistants({
          user,
          baseUrl: setup.baseUrl,
          language,
          ttlMs: setup.cacheTtlMs,
          signal
        });
      } catch (error) {
        hint = /\(403\)/.test(error?.message || '') ? 'forbidden' : 'unavailable';
        logger.debug('Could not list the iAssistants of the user; offering the configured one', {
          component: 'IAssistantScopes',
          error: error?.message
        });
      }
    } else {
      hint = 'unavailable';
    }

    if (assistants) {
      for (const assistant of assistants) {
        scopes.push({
          id: assistantScopeId(assistant.id),
          kind: 'assistant',
          name: assistant.name,
          ...(assistant.description ? { description: assistant.description } : {})
        });
      }
    } else {
      source = 'configured-default';
      if (setup.assistantId) {
        scopes.push({
          id: assistantScopeId(setup.assistantId),
          kind: 'assistant',
          name: setup.assistantId
        });
      }
    }
    if (offerAll) {
      scopes.push({ id: ALL_SEARCH_PROFILES_SCOPE, kind: 'all', name: ALL_PROFILES_NAME });
    }
    if (scopes.length === 0 && setup.assistantId) {
      // iFinder answered, but does not offer the app's own iAssistant to the
      // user. It stays the only entry: the conversation then reports that.
      scopes.push({
        id: assistantScopeId(setup.assistantId),
        kind: 'assistant',
        name: setup.assistantId
      });
      hint = hint || 'no-profiles';
    }

    const configuredDefault = setup.assistantId
      ? assistantScopeId(setup.assistantId)
      : setup.allSearchProfiles
        ? ALL_SEARCH_PROFILES_SCOPE
        : CONFIGURED_SCOPE;

    let listed = scopes;
    if (settings.pinnedScope) {
      const known = scopes.find(scope => scope.id === settings.pinnedScope);
      listed = [
        known || {
          id: settings.pinnedScope,
          kind: scopeToConversationConfig(settings.pinnedScope)?.allSearchProfiles
            ? 'all'
            : 'assistant',
          name:
            settings.pinnedScope === ALL_SEARCH_PROFILES_SCOPE
              ? ALL_PROFILES_NAME
              : settings.pinnedScope
        }
      ];
    }
    const defaultScope = pickDefaultScope(
      listed,
      settings.pinnedScope || settings.defaultScope || configuredDefault
    );
    return {
      scopes: listed.map(scope => ({ ...scope, isDefault: scope.id === defaultScope })),
      defaultScope,
      fixed: Boolean(settings.pinnedScope),
      verified: source === 'ifinder',
      source,
      ...(hint ? { hint } : {})
    };
  },

  async validateScope({ scopeId, user, app, model, language, signal }) {
    const listing = await this.listScopes({ user, app, model, language, signal });
    if (listing.fixed) return { ok: true, scopeId: listing.defaultScope, fixed: true };
    if (!scopeId) return { ok: true, scopeId: null, fixed: false };
    const mapped = scopeToConversationConfig(scopeId);
    if (mapped && listing.scopes.some(scope => scope.id === scopeId)) {
      return { ok: true, scopeId, fixed: false };
    }
    // The list could not be read: an iAssistant is still checked when the
    // conversation is created, since iFinder answers 404 for one the user
    // cannot see (`AssistantNotAvailableError`).
    if (mapped?.assistantId && !listing.verified) return { ok: true, scopeId, fixed: false };
    return {
      ok: false,
      code: 'INTEGRATION_SCOPE_NOT_ALLOWED',
      message: `The iAssistant scope "${scopeId}" is not available to you`
    };
  }
};

export default iAssistantScopes;
