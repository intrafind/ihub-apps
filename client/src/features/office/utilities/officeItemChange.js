/**
 * Decides what an `ihub:itemchanged` event means for the Outlook taskpane.
 *
 * The taskpane dispatches `ihub:itemchanged` for two different Outlook
 * events (see client/office/taskpane-entry.jsx):
 *
 *  - `ItemChanged` — the pinned taskpane now shows a different item.
 *  - `SelectedItemsChanged` — the message-list selection changed. This also
 *    fires on re-selecting the same message, on Ctrl-selecting more
 *    messages and on list refreshes, so on its own it never means "the user
 *    moved to a different email". It exists to keep the "Add email(s)"
 *    control in sync with the live selection (#1553).
 *
 * The event's `detail.source` names which one fired; an event without a
 * source (older dispatchers, other hosts) is treated as `ItemChanged`.
 * Issue #2450: the chat used to reset on every dispatch, so a spurious
 * selection event silently wiped a finished answer.
 */

export const ITEM_CHANGED_EVENT = 'ihub:itemchanged';

export const ITEM_CHANGE_SOURCE = {
  itemChanged: 'ItemChanged',
  selectedItemsChanged: 'SelectedItemsChanged'
};

/**
 * @param {Event} event - The `ihub:itemchanged` DOM event.
 * @returns {string} The Outlook event that caused it.
 */
export function getItemChangeSource(event) {
  return event?.detail?.source || ITEM_CHANGE_SOURCE.itemChanged;
}

/**
 * Whether the chat conversation should start over for a new item.
 *
 * Only a genuine switch to a different, known item qualifies: a selection
 * event never does, and neither does an event with no live item (the user
 * deselected or multi-selected) or one for the item already open.
 *
 * @param {object} args
 * @param {string} args.source - From `getItemChangeSource`.
 * @param {string|null} args.liveItemId - itemId of the item now open.
 * @param {string|null} args.lastItemId - itemId the conversation belongs to.
 * @returns {boolean}
 */
export function shouldStartNewChatForItemChange({ source, liveItemId, lastItemId }) {
  if (source !== ITEM_CHANGE_SOURCE.itemChanged) return false;
  if (!liveItemId) return false;
  return liveItemId !== lastItemId;
}

/**
 * Whether per-item edits in the context strip (removed attachments, the
 * email-body opt-out) belong to a different item now. Unlike the chat, the
 * strip follows the live item on either event; the edits survive only when
 * the event is known to concern the same item. Hosts without Outlook item
 * ids (no `liveItemId`) keep resetting on every event.
 *
 * @param {object} args
 * @param {string|null} args.liveItemId
 * @param {string|null} args.lastItemId
 * @returns {boolean}
 */
export function isDifferentItem({ liveItemId, lastItemId }) {
  return !liveItemId || liveItemId !== lastItemId;
}
