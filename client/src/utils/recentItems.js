const getCurrentUsername = () => {
  try {
    return localStorage.getItem('aihub_username') || 'default';
  } catch (err) {
    console.error('Error accessing localStorage for username:', err);
    return 'default';
  }
};

export function createRecentItemHelpers({ prefix, max = 5, expirationMs = 7 * 24 * 60 * 60 * 1000 }) {
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

  const recordUsage = (id) => {
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
    } catch (err) {
      console.error('Error recording recent item usage:', err);
    }
  };

  const getIds = () => {
    const map = getMap();
    const now = Date.now();
    return Object.entries(map)
      .filter(([, ts]) => now - ts < expirationMs)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  };

  return { getMap, recordUsage, getIds };
}
