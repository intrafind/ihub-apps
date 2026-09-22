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
        // The fallback used when neither the app, the model, nor the
        // iAssistant profile names a search profile. It is the single place
        // that decides what "unconfigured" means, so an installation can move
        // it without editing every app.
        defaultSearchProfile: iAssistantConfig.defaultSearchProfile || 'searchprofile-standard',
        // Whether iHub asks the iAssistant profile for its search profile
        // before falling back to the configured one. Off only turns off the
        // extra lookup; it never changes which profile is used when the
        // profile does not name one.
        resolveSearchProfileFromProfile: iAssistantConfig.resolveSearchProfileFromProfile !== false,
        // How long a resolved profile stays cached. Profiles are edited by
        // administrators, not per request, so minutes are the right scale.
        profileCacheTtlMs: Number.isFinite(iAssistantConfig.profileCacheTtlMs)
          ? iAssistantConfig.profileCacheTtlMs
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
