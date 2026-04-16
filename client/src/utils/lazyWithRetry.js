import { lazy } from 'react';

/**
 * Checks whether an error is a chunk/module load failure
 * (network down, deployment changed hashes, etc.)
 */
export function isChunkLoadError(error) {
  if (!error) return false;
  const msg = error.message || '';
  return (
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('Loading chunk') ||
    msg.includes('Loading CSS chunk') ||
    error.name === 'ChunkLoadError'
  );
}

const RELOAD_GUARD_KEY = 'chunk-reload-attempted';

/**
 * Drop-in replacement for React.lazy that retries failed dynamic imports
 * with exponential backoff before giving up.
 *
 * On final failure it attempts a single page reload (to pick up new asset
 * hashes after a deployment). A sessionStorage guard prevents infinite loops.
 */
export default function lazyWithRetry(importFn, retries = 3, baseDelay = 1000) {
  return lazy(() => retryImport(importFn, retries, baseDelay));
}

async function retryImport(importFn, retries, baseDelay) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await importFn();
    } catch (error) {
      if (!isChunkLoadError(error) || attempt === retries) {
        // Not a chunk error, or we exhausted retries — try a one-time reload
        if (isChunkLoadError(error) && !sessionStorage.getItem(RELOAD_GUARD_KEY)) {
          sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
          window.dispatchEvent(new CustomEvent('serverUnreachable'));
          window.location.reload();
          // Return a never-resolving promise so React doesn't render stale state
          return new Promise(() => {});
        }
        // Clear the guard so future navigations can try again
        sessionStorage.removeItem(RELOAD_GUARD_KEY);
        throw error;
      }

      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
