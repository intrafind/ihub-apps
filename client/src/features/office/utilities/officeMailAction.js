/**
 * What the task pane does with an assistant answer in Outlook: the action
 * vocabulary, which actions each Outlook mode offers, and how the default one
 * is resolved (issue #2446).
 *
 * The pane used to offer three buttons, two of which ran the same handler —
 * "Add to email" and "Reply to email" both opened a *reply-to-sender* form,
 * so every other `To:` and all `CC:` recipients of a thread silently
 * disappeared, and Forward did not exist at all. Each action now maps to
 * exactly one Office.js call (see `outlookMailActions.js`):
 *
 * | Action      | Office.js                                          |
 * |-------------|----------------------------------------------------|
 * | `answer`    | `item.displayReplyFormAsync`                       |
 * | `answerAll` | `item.displayReplyAllFormAsync`                    |
 * | `forward`   | `mailbox.displayNewMessageFormAsync` + quoted mail |
 * | `new`       | `mailbox.displayNewMessageFormAsync`               |
 * | `insert`    | `item.body.setSelectedDataAsync` / `prependAsync`  |
 *
 * ## Which actions a mode offers
 *
 * The split is not cosmetic — it is what the Outlook API supports:
 *
 * - **Read mode** (an email is selected in the reading pane): the
 *   `display*FormAsync` openers exist, `item.body` is read-only. Insert has no
 *   draft to insert into, so it is not offered.
 * - **Compose mode** (the user is already writing a reply, a forward or a new
 *   mail): the draft exists, so Insert is the only meaningful action. The
 *   openers are not available here either — `displayNewMessageFormAsync` is
 *   documented as *read mode only*, which is why "New email" invoked from a
 *   Forward draft failed with an undiagnosable alert (issue #2449).
 *
 * The order of each mode's list is also its context-dependent default: reply
 * all in read mode (nobody is dropped from a thread by accident), insert in
 * compose mode.
 *
 * ## Resolution order
 *
 * user override → admin default → the mode's context default.
 *
 * The user override lives in the host's localStorage under an `office_`-prefixed
 * key, like the appearance and language preferences (`officeTheme.js`,
 * `officeLocale.js`) — per user, per device, nothing on the server. The admin
 * default is `platform.json → officeIntegration.defaultMailAction`, served to
 * the pane by `/api/integrations/office-addin/config` and mirrored server-side
 * in `server/utils/officeMailActions.js`.
 *
 * A configured default that the current mode does not offer is skipped rather
 * than honoured — an admin who prefers "Answer all" must still get Insert
 * while the user is composing.
 */

export const MAIL_ACTION_ANSWER = 'answer';
export const MAIL_ACTION_ANSWER_ALL = 'answerAll';
export const MAIL_ACTION_FORWARD = 'forward';
export const MAIL_ACTION_NEW = 'new';
export const MAIL_ACTION_INSERT = 'insert';

/** Every action the pane knows, in no particular order. */
export const OFFICE_MAIL_ACTIONS = [
  MAIL_ACTION_ANSWER,
  MAIL_ACTION_ANSWER_ALL,
  MAIL_ACTION_FORWARD,
  MAIL_ACTION_NEW,
  MAIL_ACTION_INSERT
];

/** "Whatever fits the current Outlook mode" — the shipped default. */
export const MAIL_ACTION_AUTO = 'auto';

/** What an admin or a user may pick as the default action. */
export const OFFICE_MAIL_ACTION_CHOICES = [MAIL_ACTION_AUTO, ...OFFICE_MAIL_ACTIONS];

export const DEFAULT_OFFICE_MAIL_ACTION = MAIL_ACTION_AUTO;

export const OFFICE_MAIL_ACTION_STORAGE_KEY = 'office_ihub_mail_action';

/**
 * Fired on `document` by the Settings dialog when the user picks a different
 * default, so an open chat re-resolves without a reload — the same shape as the
 * `ihub:itemchanged` notification the pane already uses.
 */
export const MAIL_ACTION_PREFERENCE_EVENT = 'ihub:mailactionchanged';

export const OUTLOOK_READ_MODE = 'read';
export const OUTLOOK_COMPOSE_MODE = 'compose';

/**
 * The actions each mode offers, most prominent first. The first entry is that
 * mode's context-dependent default.
 */
const ACTIONS_BY_MODE = {
  [OUTLOOK_READ_MODE]: [
    MAIL_ACTION_ANSWER_ALL,
    MAIL_ACTION_ANSWER,
    MAIL_ACTION_FORWARD,
    MAIL_ACTION_NEW
  ],
  [OUTLOOK_COMPOSE_MODE]: [MAIL_ACTION_INSERT]
};

/**
 * @param {'read'|'compose'|null} mode
 * @returns {string[]} the actions offered in this mode, default first. Empty
 *   for a host that is not an Outlook mail surface (the browser-extension side
 *   panel, a Word task pane, no item selected).
 */
export function actionsForMode(mode) {
  const actions = ACTIONS_BY_MODE[mode];
  return actions ? [...actions] : [];
}

/** @returns {boolean} whether `mode` offers `action` at all. */
export function isMailActionAvailable(action, mode) {
  return actionsForMode(mode).includes(action);
}

/**
 * The user's own default, or `auto` when they never chose one.
 * @returns {string} one of `OFFICE_MAIL_ACTION_CHOICES`
 */
export function getStoredMailActionPreference() {
  try {
    const stored = localStorage.getItem(OFFICE_MAIL_ACTION_STORAGE_KEY);
    if (stored && OFFICE_MAIL_ACTION_CHOICES.includes(stored)) return stored;
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_OFFICE_MAIL_ACTION;
}

/**
 * Persist the user's default. Takes effect on the next render — no reload.
 * @returns {boolean} false when the value is not a known choice
 */
export function setMailActionPreference(choice) {
  if (!OFFICE_MAIL_ACTION_CHOICES.includes(choice)) {
    console.warn(`[office] ignoring unknown mail action preference: ${choice}`);
    return false;
  }
  try {
    localStorage.setItem(OFFICE_MAIL_ACTION_STORAGE_KEY, choice);
  } catch {
    // localStorage unavailable — the choice still applies for this session
  }
  return true;
}

/**
 * Normalize what the server sent for the admin default. Sanitized rather than
 * validated, like the neighbouring add-in settings: a hand-edited
 * platform.json must never break the pane.
 *
 * @param {unknown} value - `useOfficeConfig().defaultMailAction`
 * @returns {string} one of `OFFICE_MAIL_ACTION_CHOICES`
 */
export function readAdminMailActionDefault(value) {
  return OFFICE_MAIL_ACTION_CHOICES.includes(value) ? value : DEFAULT_OFFICE_MAIL_ACTION;
}

/**
 * The action the primary button runs: user override → admin default → the
 * mode's context default. Configured values the mode does not offer are
 * skipped, so the fallback is always something that works here.
 *
 * @param {object} params
 * @param {'read'|'compose'|null} params.mode
 * @param {string} [params.userPreference] - `getStoredMailActionPreference()`
 * @param {string} [params.adminDefault]   - `readAdminMailActionDefault(...)`
 * @returns {string|null} the action id, or null when this host offers none
 */
export function resolveDefaultMailAction({ mode, userPreference, adminDefault } = {}) {
  const available = actionsForMode(mode);
  if (available.length === 0) return null;
  for (const candidate of [userPreference, adminDefault]) {
    if (candidate && candidate !== MAIL_ACTION_AUTO && available.includes(candidate)) {
      return candidate;
    }
  }
  return available[0];
}
