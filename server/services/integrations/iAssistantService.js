import config from '../../config.js';
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
        defaultSearchProfile: iAssistantConfig.defaultSearchProfile || 'searchprofile-standard',
        timeout: iAssistantConfig.timeout || config.IASSISTANT_TIMEOUT || 60000
      };
    }
    return this.config;
  }
}

// Export singleton instance
export default new IAssistantService();
