const STORAGE_KEY = 'ihubDebugLogging';

function isDebugLoggingEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function debugLog(...args) {
  if (import.meta.env.DEV || isDebugLoggingEnabled()) {
    console.log(...args);
  }
}

// Lets anyone flip on the app's debug logs from the devtools console in any
// browser (including production builds), without needing a dev build.
if (typeof window !== 'undefined') {
  window.enableDebugLogging = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      /* ignore */
    }
    console.log('[debugLog] Debug logging enabled.');
  };

  window.disableDebugLogging = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    console.log('[debugLog] Debug logging disabled.');
  };
}
