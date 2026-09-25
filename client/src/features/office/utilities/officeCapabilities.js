/* global Office */

/**
 * Requirement-set check that never throws.
 *
 * `Office.context.requirements.isSetSupported` is missing on old hosts and
 * throws in a few embed scenarios, so every capability check in the add-in
 * goes through here.
 *
 * @param {string} set requirement set name, e.g. 'Mailbox'.
 * @param {string} version minimum version, e.g. '1.8'.
 * @returns {boolean}
 */
export function isRequirementSetSupported(set, version) {
  try {
    if (
      typeof Office === 'undefined' ||
      !Office.context ||
      !Office.context.requirements ||
      typeof Office.context.requirements.isSetSupported !== 'function'
    ) {
      return false;
    }
    return Office.context.requirements.isSetSupported(set, version);
  } catch {
    return false;
  }
}

export function isMailboxAvailable() {
  try {
    return typeof Office !== 'undefined' && !!Office.context && !!Office.context.mailbox;
  } catch {
    return false;
  }
}

/**
 * True when the currently-selected Outlook item is a calendar appointment.
 * Used by the chat panel to pick calendar-specific starter prompts and by
 * the context strip to switch between the mail and appointment banner.
 *
 * Reads the live `Office.context.mailbox.item`, so it must be re-evaluated
 * whenever the `ihub:itemchanged` event fires.
 */
export function isOutlookAppointmentMode() {
  if (!isMailboxAvailable()) return false;
  try {
    const itemType = String(Office.context.mailbox.item?.itemType || '').toLowerCase();
    return itemType === 'appointment';
  } catch {
    return false;
  }
}
