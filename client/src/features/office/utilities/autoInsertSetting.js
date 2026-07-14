const AUTO_INSERT_STORAGE_KEY = 'office_ihub_auto_insert';

export function isAutoInsertEnabled() {
  try {
    const stored = localStorage.getItem(AUTO_INSERT_STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

export function setAutoInsertEnabled(enabled) {
  try {
    localStorage.setItem(AUTO_INSERT_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // localStorage unavailable
  }
}
