/**
 * Feature Registry
 *
 * Central registry of all toggleable platform features.
 * Single source of truth for feature IDs, names, descriptions,
 * categories, and default states.
 *
 * @module featureRegistry
 */

export const featureRegistry = [
  {
    id: 'workflows',
    name: { en: 'Workflows', de: 'Workflows' },
    description: {
      en: 'Agentic workflow automation for multi-step AI tasks',
      de: 'Agentische Workflow-Automatisierung für mehrstufige KI-Aufgaben'
    },
    category: 'preview',
    default: false,
    preview: true
  },
  {
    id: 'integrations',
    name: { en: 'Integrations', de: 'Integrationen' },
    description: {
      en: 'External service integrations (Jira, Cloud Storage)',
      de: 'Externe Dienst-Integrationen (Jira, Cloud Storage)'
    },
    category: 'preview',
    default: true,
    preview: true
  },
  {
    id: 'promptsLibrary',
    name: { en: 'Prompts Library', de: 'Prompt-Bibliothek' },
    description: {
      en: 'Browsable library of reusable prompt templates',
      de: 'Durchsuchbare Bibliothek wiederverwendbarer Prompt-Vorlagen'
    },
    category: 'content',
    default: true
  },
  {
    id: 'usageTracking',
    name: { en: 'Usage Tracking', de: 'Nutzungsverfolgung' },
    description: {
      en: 'Track token usage, request counts, and costs per user/model',
      de: 'Token-Nutzung, Anfragenzählung und Kosten pro Benutzer/Modell verfolgen'
    },
    category: 'analytics',
    default: true
  },
  {
    id: 'tools',
    name: { en: 'Tool Calling', de: 'Tool-Aufrufe' },
    description: {
      en: 'Allow AI models to call external tools and functions',
      de: 'KI-Modellen erlauben, externe Tools und Funktionen aufzurufen'
    },
    category: 'ai',
    default: true
  },
  {
    id: 'sources',
    name: { en: 'Sources', de: 'Quellen' },
    description: {
      en: 'Add custom knowledge sources directly to prompts',
      de: 'Benutzerdefinierte Wissensquellen direkt zu Prompts hinzufügen'
    },
    category: 'ai',
    default: true
  },
  {
    id: 'shortLinks',
    name: { en: 'Short Links', de: 'Kurzlinks' },
    description: {
      en: 'Create short URLs linking directly to specific apps',
      de: 'Kurz-URLs erstellen, die direkt zu bestimmten Apps führen'
    },
    category: 'content',
    default: true
  },
  {
    id: 'pdfExport',
    name: { en: 'PDF Export', de: 'PDF-Export' },
    description: {
      en: 'Export chat conversations as formatted PDF documents',
      de: 'Chat-Unterhaltungen als formatierte PDF-Dokumente exportieren'
    },
    category: 'content',
    default: true
  }
];

export const featureCategories = {
  preview: { name: { en: 'Preview', de: 'Vorschau' }, order: 1 },
  ai: { name: { en: 'AI Capabilities', de: 'KI-Funktionen' }, order: 2 },
  content: { name: { en: 'Content', de: 'Inhalte' }, order: 3 },
  analytics: { name: { en: 'Analytics', de: 'Analytik' }, order: 4 }
};

/**
 * Resolve all features with their current enabled state.
 * Merges registry defaults with the saved feature configuration.
 *
 * @param {Object} featureConfig - Saved feature flags from features.json
 * @returns {Object[]} Array of feature objects with `enabled` field
 */
export function resolveFeatures(featureConfig = {}) {
  return featureRegistry.map(f => ({
    ...f,
    enabled: featureConfig[f.id] ?? f.default
  }));
}

/**
 * Check if a specific feature is enabled.
 *
 * @param {string} featureId - Feature ID to check
 * @param {Object} featureConfig - Saved feature flags from features.json
 * @returns {boolean} True if the feature is enabled
 */
export function isFeatureEnabled(featureId, featureConfig = {}) {
  const entry = featureRegistry.find(f => f.id === featureId);
  if (!entry) return true; // Unknown features are enabled by default
  return featureConfig[featureId] ?? entry.default;
}

/**
 * Express middleware factory that gates a route behind a feature flag.
 * Returns 403 with code FEATURE_DISABLED when the feature is off.
 *
 * @param {string} featureId - Feature ID to check
 * @returns {Function} Express middleware
 */
export function requireFeature(featureId) {
  // Lazy import to avoid circular dependency at module load time
  let _configCache;
  return async (req, res, next) => {
    if (!_configCache) {
      _configCache = (await import('./configCache.js')).default;
    }
    if (!isFeatureEnabled(featureId, _configCache.getFeatures())) {
      return res.status(403).json({
        error: `Feature '${featureId}' is not enabled`,
        code: 'FEATURE_DISABLED'
      });
    }
    next();
  };
}
