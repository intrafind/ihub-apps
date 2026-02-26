import { buildPath, getBasePath } from '../utils/runtimeBasePath';

let _registration = null;

/**
 * Register the service worker at the correct base-path-aware URL.
 * No-ops if the SW is already registered (prevents duplicate visibilitychange listeners).
 * The SW scope matches the base path so it intercepts only in-scope requests.
 */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (_registration) return;

  try {
    const swUrl = buildPath('/sw.js');
    const basePath = getBasePath();
    const scope = basePath ? `${basePath}/` : '/';

    _registration = await navigator.serviceWorker.register(swUrl, { scope });

    // Check for updates whenever the page becomes visible again
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        _registration?.update().catch(() => {});
      }
    });
  } catch (err) {
    // SW registration failure is non-fatal — the app works normally without it
    console.warn('[SW] Registration failed:', err.message);
  }
}

/**
 * Unregister all service workers for this origin.
 * Called when PWA is disabled in admin settings to clean up any existing SW.
 */
export async function unregisterServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  _registration = null;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map(r => r.unregister()));
}
