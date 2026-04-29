// Replaced at packaging time by the iHub admin "Download Extension" flow.
// In an unpacked dev build this stays as null and the extension falls back
// to the user-supplied iHub base URL stored in chrome.storage.local.
globalThis.IHUB_RUNTIME_CONFIG = globalThis.IHUB_RUNTIME_CONFIG || null;
