const RECENT_APPS_KEY_PREFIX = 'aihub_recent_apps_';
const MAX_RECENT_APPS = 5;
const RECENT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const getCurrentUsername = () => {
  try {
    return localStorage.getItem('aihub_username') || 'default';
  } catch (err) {
    console.error('Error accessing localStorage for username:', err);
    return 'default';
  }
};

const getStorageKey = () => `${RECENT_APPS_KEY_PREFIX}${getCurrentUsername()}`;

export const getRecentAppsMap = () => {
  try {
    const raw = localStorage.getItem(getStorageKey());
    const parsed = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    const filteredEntries = Object.entries(parsed).filter(
      ([, ts]) => now - ts < RECENT_EXPIRATION_MS
    );
    if (filteredEntries.length !== Object.keys(parsed).length) {
      const trimmed = Object.fromEntries(filteredEntries);
      localStorage.setItem(getStorageKey(), JSON.stringify(trimmed));
      return trimmed;
    }
    return parsed;
  } catch (err) {
    console.error('Error retrieving recent apps:', err);
    return {};
  }
};

export const recordAppUsage = (appId) => {
  if (!appId) return;
  try {
    const map = getRecentAppsMap();
    const now = Date.now();
    map[appId] = now;
    // Remove expired entries
    Object.keys(map).forEach((id) => {
      if (now - map[id] >= RECENT_EXPIRATION_MS) {
        delete map[id];
      }
    });
    const entries = Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_RECENT_APPS);
    const trimmed = Object.fromEntries(entries);
    localStorage.setItem(getStorageKey(), JSON.stringify(trimmed));
  } catch (err) {
    console.error('Error recording recent app usage:', err);
  }
};

export const getRecentAppIds = () => {
  const map = getRecentAppsMap();
  const now = Date.now();
  return Object.entries(map)
    .filter(([, ts]) => now - ts < RECENT_EXPIRATION_MS)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
};
