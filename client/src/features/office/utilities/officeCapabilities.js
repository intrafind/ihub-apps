/* global Office */

function safeIsSetSupported(set, version) {
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

// Mailbox 1.13 introduced getSelectedItemsAsync (subject + itemId only).
export function isMultiSelectListSupported() {
  if (!isMailboxAvailable()) return false;
  if (typeof Office.context.mailbox.getSelectedItemsAsync !== 'function') return false;
  return safeIsSetSupported('Mailbox', '1.13');
}

// Mailbox 1.15 added loadItemByIdAsync (load full item, including body) for
// items returned by getSelectedItemsAsync. Without this we'd only have
// subjects for the bulk-select, which isn't useful for summarisation —
// so the native multi-select button is gated on 1.15 here.
export function isMultiSelectBodySupported() {
  if (!isMultiSelectListSupported()) return false;
  if (typeof Office.context.mailbox.loadItemByIdAsync !== 'function') return false;
  return safeIsSetSupported('Mailbox', '1.15');
}
