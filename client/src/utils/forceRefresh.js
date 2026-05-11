/**
 * Force Refresh Utility
 *
 * This utility handles the force refresh mechanism by:
 * 1. Checking the refresh salt from the platform configuration
 * 2. Comparing it with the stored salt in localStorage
 * 3. If salt has changed, clearing all caches and forcing a full reload
 * 4. Preserving the disclaimer acceptance flag during refresh
 *
 * Loop safety:
 * Triggers like a version update (e.g. 5.2.10-RC4 → 5.3.11) intentionally bump
 * `computedRefreshSalt`, which is what fires this flow in the first place. If
 * anything goes wrong while storing the new salt — empty server response,
 * blocked localStorage, etc. — a naive "reload anyway" would loop forever.
 * `REFRESH_ATTEMPT_KEY` caps consecutive force-refresh attempts so the user
 * lands on the app instead of a reload storm. The counter is cleared once the
 * salt matches.
 */

import { fetchUIConfig } from '../api/api';

const REFRESH_SALT_KEY = 'ihub-refresh-salt';
const DISCLAIMER_KEY = 'ihub-disclaimer-acknowledged';
const REFRESH_ATTEMPT_KEY = 'ihub-refresh-attempt';
const REFRESH_PARAM = '_refresh';
const MAX_REFRESH_ATTEMPTS = 2;

const readAttemptCount = () => {
  const raw = sessionStorage.getItem(REFRESH_ATTEMPT_KEY);
  const parsed = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const clearAttemptCount = () => {
  sessionStorage.removeItem(REFRESH_ATTEMPT_KEY);
};

/**
 * Strip the `_refresh` cache-busting param from the current URL without
 * triggering navigation. Keeps the address bar clean after a successful
 * refresh and prevents the param from snowballing across reloads.
 */
export const stripRefreshParamFromUrl = () => {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(REFRESH_PARAM)) return;
    url.searchParams.delete(REFRESH_PARAM);
    const newUrl = url.pathname + (url.search ? url.search : '') + url.hash;
    window.history.replaceState(window.history.state, '', newUrl);
  } catch (error) {
    console.warn('Could not strip _refresh param from URL:', error);
  }
};

/**
 * Checks if a force refresh is needed by comparing the current salt with the stored salt
 * @returns {Promise<boolean>} True if force refresh is needed, false otherwise
 */
export const checkForceRefresh = async () => {
  try {
    console.log('🔍 Checking for force refresh...');

    // Fetch current UI configuration (which now contains the refresh salt)
    const uiConfig = await fetchUIConfig({ skipCache: true });

    if (!uiConfig || !uiConfig.computedRefreshSalt) {
      console.warn('No refresh salt found in UI configuration');
      return false;
    }

    const currentSalt = uiConfig.computedRefreshSalt;
    const storedSalt = localStorage.getItem(REFRESH_SALT_KEY);

    console.log(`Current salt: ${currentSalt}, Stored salt: ${storedSalt}`);

    // If no stored salt (first run), store current salt and continue
    if (!storedSalt) {
      localStorage.setItem(REFRESH_SALT_KEY, currentSalt);
      clearAttemptCount();
      console.log('✅ First run - stored initial salt');
      return false;
    }

    // Compare salts
    if (currentSalt !== storedSalt) {
      console.log('🔄 Salt mismatch detected - force refresh needed');
      return true;
    }

    // Salts match: we're on the version the server expects. Reset the loop
    // guard so a *future* legitimate version change can refresh again.
    clearAttemptCount();
    console.log('✅ Salt matches - no force refresh needed');
    return false;
  } catch (error) {
    console.error('Error checking force refresh:', error);
    // On error, don't force refresh to avoid infinite loops
    return false;
  }
};

/**
 * Performs a force refresh by clearing all caches and reloading the page.
 *
 * Reloads only when the new salt was successfully fetched AND written to
 * localStorage, and only while the attempt counter is under the cap. Any
 * other branch logs and returns without navigating, so the user always
 * lands on a usable app instead of in a reload loop.
 */
export const performForceRefresh = async () => {
  const attempts = readAttemptCount();
  if (attempts >= MAX_REFRESH_ATTEMPTS) {
    console.warn(
      `Force refresh attempted ${attempts} times in a row; aborting to avoid a loop. ` +
        'Continuing with the current page state.'
    );
    clearAttemptCount();
    return;
  }
  sessionStorage.setItem(REFRESH_ATTEMPT_KEY, String(attempts + 1));

  let newSalt = null;
  try {
    console.log('🔄 Performing force refresh...');

    // Get current UI configuration to get the new salt
    const uiConfig = await fetchUIConfig({ skipCache: true });
    newSalt = uiConfig?.computedRefreshSalt || null;

    if (!newSalt) {
      console.warn('Force refresh: server response missing computedRefreshSalt; not reloading.');
      return;
    }

    // Preserve disclaimer acceptance
    const disclaimerAcknowledged = localStorage.getItem(DISCLAIMER_KEY);

    // Clear all localStorage / sessionStorage, then restore the keys we need
    // to survive a refresh. We restore the attempt counter so a follow-up
    // load can still detect a runaway loop.
    const attemptCounter = sessionStorage.getItem(REFRESH_ATTEMPT_KEY);
    localStorage.clear();
    sessionStorage.clear();
    if (disclaimerAcknowledged) {
      localStorage.setItem(DISCLAIMER_KEY, disclaimerAcknowledged);
    }
    if (attemptCounter) {
      sessionStorage.setItem(REFRESH_ATTEMPT_KEY, attemptCounter);
    }
    localStorage.setItem(REFRESH_SALT_KEY, newSalt);

    // Verify the write actually took effect. Some browser modes (Safari
    // private mode, storage quota, blocked storage) silently drop writes,
    // which would put us in a loop on reload.
    if (localStorage.getItem(REFRESH_SALT_KEY) !== newSalt) {
      console.warn('Force refresh: could not persist new salt to localStorage; not reloading.');
      return;
    }

    console.log('✅ Cleared all caches and storage');
  } catch (error) {
    console.error('Error during force refresh:', error);
    // Do NOT reload here. A reload without storing the new salt would loop;
    // the user can manually retry or the next genuine version change will
    // pick this up.
    return;
  }

  // Force reload the page with cache busting. Drop any existing `_refresh`
  // param first so it doesn't accumulate across reloads.
  const url = new URL(window.location.href);
  url.searchParams.delete(REFRESH_PARAM);
  url.searchParams.set(REFRESH_PARAM, Date.now().toString());
  window.location.href = url.toString();
};

/**
 * Initializes the force refresh check and performs refresh if needed.
 * This should be called early in the application startup.
 */
export const initializeForceRefresh = async () => {
  // Strip any leftover ?_refresh=... from a previous reload so the URL stays
  // clean and a manual reload doesn't carry it forward.
  stripRefreshParamFromUrl();

  const needsRefresh = await checkForceRefresh();

  if (needsRefresh) {
    await performForceRefresh();
    // If we get here without a reload, performForceRefresh decided it was
    // unsafe to continue (loop guard, write failure, missing salt). The app
    // continues to render with the stale stored salt.
  }
};
