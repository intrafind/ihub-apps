/**
 * Same-tab notification that one of these lists changed. Mirrors the
 * `ihub:favorites-changed` event favorites use: a `storage` event only fires
 * in *other* tabs, so long-lived components in this one (the sidebar, mounted
 * once in the Layout) would otherwise keep the order they read at boot.
 */
const CHANGE_EVENT = 'ihub:recent-items-changed';

const getCurrentUsername = () => {
  try {
    return localStorage.getItem('ihub_username') || 'default';
  } catch (err) {
    console.error('Error accessing localStorage for username:', err);
    return 'default';
  }
};

export function createRecentItemHelpers({
  prefix,
  max = 5,
  expirationMs = 7 * 24 * 60 * 60 * 1000
}) {
  const getStorageKey = () => `${prefix}${getCurrentUsername()}`;

  const getMap = () => {
    try {
      const raw = localStorage.getItem(getStorageKey());
      const parsed = raw ? JSON.parse(raw) : {};
      const now = Date.now();
      const filtered = Object.entries(parsed).filter(([, ts]) => now - ts < expirationMs);
      if (filtered.length !== Object.keys(parsed).length) {
        const trimmed = Object.fromEntries(filtered);
        localStorage.setItem(getStorageKey(), JSON.stringify(trimmed));
        return trimmed;
      }
      return parsed;
    } catch (err) {
      console.error('Error retrieving recent items:', err);
      return {};
    }
  };

  const notifyChanged = () => {
    try {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { prefix } }));
    } catch {
      // Ignore environments without window/CustomEvent (e.g. SSR)
    }
  };

  const recordUsage = id => {
    if (!id) return;
    try {
      const map = getMap();
      const now = Date.now();
      map[id] = now;
      Object.keys(map).forEach(key => {
        if (now - map[key] >= expirationMs) {
          delete map[key];
        }
      });
      const entries = Object.entries(map)
        .sort((a, b) => b[1] - a[1])
        .slice(0, max);
      localStorage.setItem(getStorageKey(), JSON.stringify(Object.fromEntries(entries)));
      notifyChanged();
    } catch (err) {
      console.error('Error recording recent item usage:', err);
    }
  };

  /**
   * Subscribe to changes of this list — usage recorded in this tab (custom
   * event) and in other tabs (native `storage` event).
   *
   * @param {() => void} listener - Called after the list changed.
   * @returns {() => void} Unsubscribe.
   */
  const subscribe = listener => {
    const handler = event => {
      // Same-tab custom event carries the prefix; ignore the other lists.
      if (event?.detail?.prefix && event.detail.prefix !== prefix) return;
      // Cross-tab storage event carries `key`; it is prefixed with the
      // username, so match on the prefix rather than the full key.
      if (event?.type === 'storage' && event.key && !event.key.startsWith(prefix)) return;
      listener();
    };
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  };

  const getIds = () => {
    const map = getMap();
    const now = Date.now();
    return Object.entries(map)
      .filter(([, ts]) => now - ts < expirationMs)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  };

  return { recordUsage, getIds, subscribe };
}
