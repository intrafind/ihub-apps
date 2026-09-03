/**
 * Sanitize an app config before it is sent to a browser.
 *
 * Parallel to `sanitizeModelForPublic` in `routes/modelRoutes.js`: the cached
 * app object is server-side configuration, and a few fields on it have no
 * client-side use while carrying information the client should not hold.
 *
 * Today that is `transcription.vocabulary` — the speech-to-text hotword list.
 * The browser never sends terms (it sends an app id and the server resolves the
 * list), and a vocabulary can name customers or employees, so it must not ride
 * along in `/api/apps`. Admin routes keep the raw object.
 */

/**
 * @param {Object} app - Cached app config.
 * @returns {Object} A shallow copy safe to serialize to a browser.
 */
export function sanitizeAppForPublic(app) {
  if (!app || typeof app !== 'object') return app;
  if (!app.transcription?.vocabulary) return app;
  // Only the nested block is cloned — everything else stays shared, so this
  // stays cheap on the hot `/api/apps` path.
  const { vocabulary: _vocabulary, ...transcription } = app.transcription;
  return { ...app, transcription };
}

/**
 * @param {Object[]} apps
 * @returns {Object[]}
 */
export function sanitizeAppsForPublic(apps) {
  return Array.isArray(apps) ? apps.map(sanitizeAppForPublic) : apps;
}

export default { sanitizeAppForPublic, sanitizeAppsForPublic };
