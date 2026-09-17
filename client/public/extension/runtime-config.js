// Replaced at packaging time by /api/admin/browser-extension/download.{zip,crx}.
//
// In an unpacked dev build (developer side-load) this stays as null and the
// React side panel falls back to the iHub base URL the user types into the
// extension options page; it then fetches the runtime config from
// /api/integrations/browser-extension/config at startup.
globalThis.IHUB_RUNTIME_CONFIG = globalThis.IHUB_RUNTIME_CONFIG || null;
