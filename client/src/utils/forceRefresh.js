/**
 * Force Refresh Utility
 *
 * This utility handles the force refresh mechanism by:
 * 1. Checking the refresh salt from the platform configuration
 * 2. Comparing it with the stored salt in localStorage
 * 3. If salt has changed, clearing all caches and forcing a full reload
 * 4. Preserving the disclaimer acceptance flag during refresh
 */

import { fetchPlatformConfig } from '../api/api';

const REFRESH_SALT_KEY = 'ihub-refresh-salt';
const DISCLAIMER_KEY = 'ihub-disclaimer-acknowledged';

/**
 * Checks if a force refresh is needed by comparing the current salt with the stored salt
 * @returns {Promise<boolean>} True if force refresh is needed, false otherwise
 */
export const checkForceRefresh = async () => {
  try {
    console.log('🔍 Checking for force refresh...');

    // Fetch current platform configuration
    const platformConfig = await fetchPlatformConfig({ skipCache: true });

    if (!platformConfig || !platformConfig.computedRefreshSalt) {
      console.warn('No refresh salt found in platform configuration');
      return false;
    }

    const currentSalt = platformConfig.computedRefreshSalt;
    const storedSalt = localStorage.getItem(REFRESH_SALT_KEY);

    console.log(`Current salt: ${currentSalt}, Stored salt: ${storedSalt}`);

    // If no stored salt (first run), store current salt and continue
    if (!storedSalt) {
      localStorage.setItem(REFRESH_SALT_KEY, currentSalt);
      console.log('✅ First run - stored initial salt');
      return false;
    }

    // Compare salts
    if (currentSalt !== storedSalt) {
      console.log('🔄 Salt mismatch detected - force refresh needed');
      return true;
    }

    console.log('✅ Salt matches - no force refresh needed');
    return false;
  } catch (error) {
    console.error('Error checking force refresh:', error);
    // On error, don't force refresh to avoid infinite loops
    return false;
  }
};

/**
 * Performs a force refresh by clearing all caches and reloading the page
 */
export const performForceRefresh = async () => {
  try {
    console.log('🔄 Performing force refresh...');

    // Get current platform configuration to get the new salt
    const platformConfig = await fetchPlatformConfig({ skipCache: true });
    const newSalt = platformConfig?.computedRefreshSalt;

    if (newSalt) {
      // Preserve disclaimer acceptance
      const disclaimerAcknowledged = localStorage.getItem(DISCLAIMER_KEY);

      // Clear all localStorage
      localStorage.clear();

      // Clear all sessionStorage
      sessionStorage.clear();

      // Restore disclaimer acceptance
      if (disclaimerAcknowledged) {
        localStorage.setItem(DISCLAIMER_KEY, disclaimerAcknowledged);
      }

      // Store new salt
      localStorage.setItem(REFRESH_SALT_KEY, newSalt);

      console.log('✅ Cleared all caches and storage');
    }

    // Force reload the page with cache busting
    // Using window.location.reload(true) is deprecated, so we use a different approach
    const url = new URL(window.location.href);
    url.searchParams.set('_refresh', Date.now().toString());
    window.location.href = url.toString();
  } catch (error) {
    console.error('Error during force refresh:', error);
    // Fallback to simple reload
    window.location.reload();
  }
};

/**
 * Initializes the force refresh check and performs refresh if needed
 * This should be called early in the application startup
 */
export const initializeForceRefresh = async () => {
  const needsRefresh = await checkForceRefresh();

  if (needsRefresh) {
    await performForceRefresh();
    // This will reload the page, so code after this won't execute
  }
};
