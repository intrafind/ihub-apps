// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getIAssistantConfig, hasConfigOverride } from './ifinderConfig.js';

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
    if (hasConfigOverride()) return getIAssistantConfig();
    if (!this.config) this.config = getIAssistantConfig();
    return this.config;
  }
}

// Export singleton instance
export default new IAssistantService();
