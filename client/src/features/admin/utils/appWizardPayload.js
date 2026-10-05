/**
 * Turn the app creation wizard's working state into the app configuration that
 * is sent to `POST /api/admin/apps`.
 *
 * The wizard keeps UI state next to the app fields (which creation method was
 * picked, the prompt used for AI generation, …). The server validates the body
 * against the app schema, which does not allow unknown top-level keys, so that
 * state has to be dropped before the request.
 */

/**
 * Top-level keys the wizard uses for its own state; none of them is part of an
 * app configuration.
 *
 * - `useAI`, `useTemplate`, `useManual`: the creation method picked on the first step.
 * - `aiGenerated`, `aiPrompt`: set by the AI generation step.
 * - `imageUpload`: the "Enable Image Upload" checkbox on the Advanced step. Uploads
 *   are configured under `upload` in an app; this top-level key was never read.
 */
export const WIZARD_ONLY_KEYS = [
  'useAI',
  'useTemplate',
  'useManual',
  'aiGenerated',
  'aiPrompt',
  'imageUpload'
];

/** Localized fields that are optional and dropped when every language is empty. */
const OPTIONAL_LOCALIZED_FIELDS = ['messagePlaceholder', 'prompt'];

/**
 * Build the app configuration to create from the wizard state.
 *
 * - removes the wizard-only keys ({@link WIZARD_ONLY_KEYS}),
 * - removes `parentId` when the app is not based on a template (the wizard
 *   keeps it as `null`, which the schema does not accept),
 * - removes empty languages from the optional localized fields, and the field
 *   itself when no language is left.
 *
 * @param {object} appData - The wizard's app state.
 * @returns {object} A new object; `appData` is not modified.
 *
 * @example
 * buildAppPayloadFromWizard({ id: 'x', useManual: true, parentId: null, prompt: { en: '' } });
 * // → { id: 'x' }
 */
export function buildAppPayloadFromWizard(appData) {
  const payload = { ...appData };

  for (const key of WIZARD_ONLY_KEYS) {
    delete payload[key];
  }

  if (!payload.parentId) {
    delete payload.parentId;
  }

  for (const field of OPTIONAL_LOCALIZED_FIELDS) {
    if (!payload[field]) continue;
    const filled = Object.fromEntries(
      Object.entries(payload[field]).filter(([, value]) => value && value.trim())
    );
    if (Object.keys(filled).length === 0) {
      delete payload[field];
    } else {
      payload[field] = filled;
    }
  }

  return payload;
}
