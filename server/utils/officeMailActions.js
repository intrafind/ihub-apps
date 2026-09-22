/**
 * The Outlook add-in's default answer action — `platform.json →
 * officeIntegration.defaultMailAction`.
 *
 * The task pane offers one action per Outlook API call (issue #2446):
 *
 * - `answer`    — reply to the sender (`item.displayReplyFormAsync`)
 * - `answerAll` — reply to everyone (`item.displayReplyAllFormAsync`)
 * - `forward`   — a forward rebuilt on the new-message form
 * - `new`       — a blank new email
 * - `insert`    — insert into the draft the user is already composing
 *
 * `auto` — the shipped default — means "whatever fits the open item": reply all
 * when an email is selected in the reading pane, insert while the user is
 * composing. An explicit choice is honoured only where Outlook can offer it;
 * the pane falls back to the context default otherwise, so an admin who prefers
 * "Answer all" still gets Insert inside a draft.
 *
 * Each user may override the admin default in the task pane's Settings dialog,
 * which stores the choice in the host's localStorage. Resolution order is
 * user override → this admin default → context default.
 *
 * Two readers, two strictness levels, as for the start-page settings: the
 * public config endpoint *sanitizes* (a hand-edited platform.json must never
 * break the pane), the admin endpoint *validates* (a bad save is reported, not
 * silently repaired). Mirrored on the client in
 * `features/office/utilities/officeMailAction.js`.
 */

/** "Whatever fits the open item" — the shipped default. */
export const OFFICE_MAIL_ACTION_AUTO = 'auto';

/** The actions the task pane can run, in the order the admin form lists them. */
export const OFFICE_MAIL_ACTIONS = ['answer', 'answerAll', 'forward', 'new', 'insert'];

/** The values `officeIntegration.defaultMailAction` accepts. */
export const OFFICE_MAIL_ACTION_CHOICES = [OFFICE_MAIL_ACTION_AUTO, ...OFFICE_MAIL_ACTIONS];

export const DEFAULT_OFFICE_MAIL_ACTION = OFFICE_MAIL_ACTION_AUTO;

/**
 * The setting as the task pane may rely on it, whatever platform.json holds.
 * Never throws.
 *
 * @param {unknown} value - `officeIntegration.defaultMailAction` as stored.
 * @returns {string} one of `OFFICE_MAIL_ACTION_CHOICES`
 */
export function sanitizeOfficeMailAction(value) {
  return OFFICE_MAIL_ACTION_CHOICES.includes(value) ? value : DEFAULT_OFFICE_MAIL_ACTION;
}

/**
 * Check a default action an admin is saving.
 *
 * @param {unknown} value - The `defaultMailAction` field of the request body.
 * @returns {{ value: string } | { error: string }} The value to store, or the
 *   reason the input was rejected. An empty value resets to `auto`.
 */
export function validateOfficeMailAction(value) {
  if (value === null || value === '') return { value: DEFAULT_OFFICE_MAIL_ACTION };
  if (!OFFICE_MAIL_ACTION_CHOICES.includes(value)) {
    return {
      error: `defaultMailAction must be one of: ${OFFICE_MAIL_ACTION_CHOICES.join(', ')}`
    };
  }
  return { value };
}
