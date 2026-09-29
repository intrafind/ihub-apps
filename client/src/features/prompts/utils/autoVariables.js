import { fetchPromptVariables } from '../../../api';
import { BUILTIN_AUTO_VARIABLES } from '../../../../../shared/promptVariables.js';

/** How long resolved automatic variables are reused — `{{time}}` moves on. */
const AUTO_VALUES_TTL_MS = 60_000;

let autoCache = null; // { lang, at, promise }

/**
 * The automatic variables for this user, from the server — the same
 * resolution a message gets when it is sent. On failure the names are still
 * known and the values are left to the server, which resolves whatever is
 * left in the text on send.
 *
 * @param {string} lang - UI language.
 * @returns {Promise<{autoNames: string[], values: Object}>}
 */
export function loadAutoVariables(lang) {
  if (autoCache && autoCache.lang === lang && Date.now() - autoCache.at < AUTO_VALUES_TTL_MS) {
    return autoCache.promise;
  }
  const promise = fetchPromptVariables(lang)
    .then(result => ({
      autoNames: Array.isArray(result?.autoNames) ? result.autoNames : BUILTIN_AUTO_VARIABLES,
      values: result?.values && typeof result.values === 'object' ? result.values : {}
    }))
    .catch(() => {
      autoCache = null;
      return { autoNames: [...BUILTIN_AUTO_VARIABLES], values: {} };
    });
  autoCache = { lang, at: Date.now(), promise };
  return promise;
}
