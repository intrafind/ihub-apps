/**
 * Tool Usage Tracker
 * Tracks tool enable/disable patterns and provides usage-based suggestions
 */

const STORAGE_KEY = 'toolUsageStats';
const SUGGESTION_THRESHOLD_DAYS = 7; // Min days before suggesting changes
const MIN_USAGE_COUNT = 5; // Min times a pattern must occur

/**
 * Get tool usage stats from localStorage
 * @returns {Object} Tool usage statistics
 */
export const getToolUsageStats = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch (error) {
    console.error('Failed to load tool usage stats:', error);
    return {};
  }
};

/**
 * Save tool usage stats to localStorage
 * @param {Object} stats - Tool usage statistics
 */
const saveToolUsageStats = stats => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch (error) {
    console.error('Failed to save tool usage stats:', error);
  }
};

/**
 * Track tool state change
 * @param {string} appId - App identifier
 * @param {string} toolId - Tool identifier
 * @param {boolean} enabled - Whether the tool was enabled
 */
export const trackToolUsage = (appId, toolId, enabled) => {
  const stats = getToolUsageStats();

  // Initialize app stats if needed
  if (!stats[appId]) {
    stats[appId] = {
      tools: {},
      firstTracked: Date.now()
    };
  }

  // Initialize tool stats if needed
  if (!stats[appId].tools[toolId]) {
    stats[appId].tools[toolId] = {
      enableCount: 0,
      disableCount: 0,
      lastEnabled: null,
      lastDisabled: null,
      firstSeen: Date.now()
    };
  }

  const toolStats = stats[appId].tools[toolId];

  if (enabled) {
    toolStats.enableCount++;
    toolStats.lastEnabled = Date.now();
  } else {
    toolStats.disableCount++;
    toolStats.lastDisabled = Date.now();
  }

  toolStats.lastModified = Date.now();

  saveToolUsageStats(stats);
};

/**
 * Get suggested tool configuration based on usage history
 * @param {string} appId - App identifier
 * @param {Array<string>} availableTools - List of available tool IDs
 * @returns {Object} Suggested configuration with reasoning
 */
export const getSuggestedToolConfig = (appId, availableTools) => {
  const stats = getToolUsageStats();

  if (!stats[appId]) {
    return null; // No data yet
  }

  const appStats = stats[appId];
  const daysSinceFirstTracked = (Date.now() - appStats.firstTracked) / (1000 * 60 * 60 * 24);

  // Don't suggest if not enough history
  if (daysSinceFirstTracked < SUGGESTION_THRESHOLD_DAYS) {
    return null;
  }

  const suggestions = {
    enabledTools: [],
    disabledTools: [],
    reasoning: []
  };

  availableTools.forEach(toolId => {
    const toolStats = appStats.tools[toolId];

    if (!toolStats) {
      // No usage data - keep default state
      return;
    }

    const totalChanges = toolStats.enableCount + toolStats.disableCount;

    // Not enough data for this tool
    if (totalChanges < MIN_USAGE_COUNT) {
      return;
    }

    const enableRatio = toolStats.enableCount / totalChanges;
    const disableRatio = toolStats.disableCount / totalChanges;

    // Suggest enabling if user frequently enables it
    if (enableRatio > 0.7) {
      suggestions.enabledTools.push(toolId);
      suggestions.reasoning.push({
        tool: toolId,
        suggestion: 'enable',
        reason: `Enabled ${toolStats.enableCount} times (${Math.round(enableRatio * 100)}% of changes)`
      });
    }

    // Suggest disabling if user frequently disables it
    if (disableRatio > 0.7) {
      suggestions.disabledTools.push(toolId);
      suggestions.reasoning.push({
        tool: toolId,
        suggestion: 'disable',
        reason: `Disabled ${toolStats.disableCount} times (${Math.round(disableRatio * 100)}% of changes)`
      });
    }
  });

  // Only return suggestions if we have some
  if (suggestions.reasoning.length === 0) {
    return null;
  }

  return suggestions;
};

/**
 * Get tool usage summary for display
 * @param {string} appId - App identifier
 * @param {string} toolId - Tool identifier
 * @returns {Object|null} Tool usage summary
 */
export const getToolUsageSummary = (appId, toolId) => {
  const stats = getToolUsageStats();

  if (!stats[appId]?.tools?.[toolId]) {
    return null;
  }

  const toolStats = stats[appId].tools[toolId];
  const totalChanges = toolStats.enableCount + toolStats.disableCount;

  return {
    enableCount: toolStats.enableCount,
    disableCount: toolStats.disableCount,
    totalChanges,
    lastModified: toolStats.lastModified,
    preference: toolStats.enableCount > toolStats.disableCount ? 'enabled' : 'disabled'
  };
};

/**
 * Clear usage stats for an app
 * @param {string} appId - App identifier
 */
export const clearToolUsageStats = appId => {
  const stats = getToolUsageStats();

  if (stats[appId]) {
    delete stats[appId];
    saveToolUsageStats(stats);
  }
};

/**
 * Clear all usage stats
 */
export const clearAllToolUsageStats = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear tool usage stats:', error);
  }
};
