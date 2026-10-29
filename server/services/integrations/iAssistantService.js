// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';

/**
 * iAssistant Service
 * Provides configuration for the iAssistant Conversation (Workspace) API integration.
 */

class IAssistantService {
  constructor() {
    this.platform = null;
    this.config = null;
  }

  /**
   * Reset cached config so it will be reloaded on next access
   */
  resetConfig() {
    this.config = null;
    this.platform = null;
  }

  /**
   * Get iAssistant API configuration
   * @returns {Object} iAssistant API configuration
   */
  getConfig() {
    if (!this.config) {
      this.platform = configCache.getPlatform() || {};
      const iAssistantConfig = this.platform.iAssistant || {};

      this.config = {
        baseUrl: this.platform.iFinder?.baseUrl,
        defaultProfileId:
          iAssistantConfig.defaultProfileId || process.env.IASSISTANT_PROFILE_ID || '',
        defaultFilter: iAssistantConfig.defaultFilter || [],
        // The search profile used when neither the app nor the model names
        // one. It is the single place that decides what "unconfigured" means,
        // so an installation can move it without editing every app.
        defaultSearchProfile: iAssistantConfig.defaultSearchProfile || 'searchprofile-standard',
        // Whether iHub checks the configured search profile against the ones
        // the user has in iFinder before creating a conversation, and uses the
        // user's default profile when they lack it. Off sends the configured
        // profile as is.
        verifySearchProfileAccess: iAssistantConfig.verifySearchProfileAccess !== false,
        // How long a user's search profile list stays cached. Profiles are
        // assigned by administrators, not per request, so minutes are the
        // right scale.
        searchProfileCacheTtlMs: Number.isFinite(iAssistantConfig.searchProfileCacheTtlMs)
          ? iAssistantConfig.searchProfileCacheTtlMs
          : 300000,
        // Installation-wide default for grounded-only answering. An app's own
        // `iassistant.groundedOnly` wins over it in either direction.
        groundedOnly: iAssistantConfig.groundedOnly === true
      };
    }
    return this.config;
  }
}

// Export singleton instance
export default new IAssistantService();
