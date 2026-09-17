import { useMemo } from 'react';
import { usePlatformConfig } from '../contexts/PlatformConfigContext';
import { FeatureFlags } from '../../../../shared/featureFlags.js';

/**
 * React hook for accessing feature flags in client components.
 *
 * @returns {FeatureFlags} A FeatureFlags instance configured with current platform config
 *
 * @example
 * function MyComponent({ app }) {
 *   const featureFlags = useFeatureFlags();
 *
 *   // Check platform-level feature
 *   const toolsEnabled = featureFlags.isEnabled('tools', true);
 *
 *   // Check app-level feature
 *   const magicEnabled = featureFlags.isAppFeatureEnabled(app, 'magicPrompt.enabled', false);
 *
 *   // Check both levels
 *   const shortLinksEnabled = featureFlags.isBothEnabled(app, 'shortLinks', true);
 *
 *   // Get feature value
 *   const magicModel = featureFlags.getAppFeatureValue(app, 'magicPrompt.model', null);
 * }
 */
export function useFeatureFlags() {
  const { platformConfig } = usePlatformConfig();

  // Memoize the FeatureFlags instance to avoid recreating on every render
  const featureFlags = useMemo(() => new FeatureFlags(platformConfig), [platformConfig]);

  return featureFlags;
}

/**
 * Whether the feedback star-rating control and submission modal should be
 * shown under AI responses. Gates the UI only — an admin turning this off
 * still leaves the separate `feedbackTracking` flag (storage of already
 * submitted feedback) untouched.
 *
 * @returns {boolean}
 */
export function useFeedbackEnabled() {
  const featureFlags = useFeatureFlags();
  return featureFlags.isEnabled('feedback', true);
}

export default useFeatureFlags;
