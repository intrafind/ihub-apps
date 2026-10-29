// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Resolves the iFinder *search* profile an iAssistant conversation is created
 * with, for the user who creates it.
 *
 * The search profile (`retrieval_scope.ifinder_search_profile`) selects which
 * documents retrieval may see. It is configured on the app, the model or the
 * platform (`iAssistant.defaultSearchProfile`), and that one value applies to
 * every user — but search profiles are assigned per user in iFinder, and a
 * user who lacks the configured one gets nothing useful out of the
 * conversation.
 *
 * So iHub asks iFinder which search profiles the user has (the internal API
 * the searchbar reads them from, see `iFinderSearchProfiles.js`) and:
 *
 *   - keeps the configured profile when the user has it;
 *   - otherwise uses the user's default profile, which is what iFinder's own
 *     searchbar falls back to for a profile the user does not have;
 *   - keeps the configured profile when the list cannot be read or is empty,
 *     so the check never turns a working setup into a broken one.
 *
 * Earlier versions read the *conversation* profile (`GET /v0/profiles/{id}`)
 * looking for a search profile. The Conversation API never published one
 * there: a conversation profile selects a workflow and its tuning, nothing
 * about the corpus. iFinder's own pairing of the two is the iAssistant
 * (`/public-api/v0/assistants`), which is a separate entity.
 *
 * Every failure here is soft. A conversation that cannot be created is a
 * broken chat; a profile list that could not be read is just the configured
 * value.
 */
import iAssistantService from './iAssistantService.js';
import iFinderSearchProfiles from './iFinderSearchProfiles.js';
import logger from '../../utils/logger.js';

class IAssistantProfileResolver {
  /** Drop every cached profile list. Called from the config reload hooks. */
  reset() {
    iFinderSearchProfiles.reset();
  }

  /**
   * The search profile a conversation should be created with.
   *
   * @param {Object} params
   * @param {string} [params.configuredSearchProfile] - app/model/platform value
   * @param {Object} params.user - authenticated user (the lookup is made as them)
   * @param {string} params.baseUrl - iFinder base URL
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<{ searchProfile: string|undefined, source: string }>} where
   *   `source` is `configured` (the user has it), `user-default` (the user does
   *   not have it, their default is used), `unverified` (the check is off or
   *   the list could not be read) or `none` (nothing configured, nothing found)
   */
  async resolveSearchProfile({ configuredSearchProfile, user, baseUrl, signal }) {
    const configured = configuredSearchProfile || undefined;
    const unverified = { searchProfile: configured, source: configured ? 'unverified' : 'none' };

    const { verifySearchProfileAccess, searchProfileCacheTtlMs } = iAssistantService.getConfig();
    if (!verifySearchProfileAccess || !baseUrl) return unverified;

    let profiles;
    try {
      profiles = await iFinderSearchProfiles.getUserSearchProfiles({
        user,
        baseUrl,
        ttlMs: searchProfileCacheTtlMs,
        signal
      });
    } catch (error) {
      logger.debug('Could not read the search profiles of the user', {
        component: 'IAssistantProfileResolver',
        error: error?.message
      });
      return unverified;
    }

    if (configured && profiles.some(profile => profile.id === configured)) {
      return { searchProfile: configured, source: 'configured' };
    }

    const userDefault = profiles.find(profile => profile.isDefault) || profiles[0];
    if (!userDefault) {
      // A user with no search profile at all cannot retrieve anything under
      // any profile; iFinder reports that on the conversation itself.
      logger.warn('The user has no iFinder search profile', {
        component: 'IAssistantProfileResolver',
        configuredSearchProfile: configured || '(none)'
      });
      return unverified;
    }

    logger.info('Configured search profile is not available to the user; using their default', {
      component: 'IAssistantProfileResolver',
      configuredSearchProfile: configured || '(none)',
      searchProfile: userDefault.id
    });
    return { searchProfile: userDefault.id, source: 'user-default' };
  }
}

export default new IAssistantProfileResolver();
