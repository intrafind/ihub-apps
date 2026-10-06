/**
 * The Outlook gateway of a chat that was popped out of the task pane.
 *
 * A popped-out chat runs in an Office dialog, which cannot reach the mailbox:
 * `Office.context.mailbox` does not exist there. Everything that reads or
 * writes the Outlook item therefore asks the pane instead, through the bridge
 * in `officePopoutBridge.js`. The pane-side half lives in `officePopout.js`.
 *
 * The Outlook utilities (`officeCapabilities`, `outlookMailContext`,
 * `outlookMailActions`, `outlookAttachments`, `externalNavigation`,
 * `officeAuth`) check {@link getOfficeRemote} first and delegate when it is
 * set, so the chat UI above them runs unchanged in either window.
 *
 * Synchronous questions — which mode the item is in, whether it is a meeting,
 * whether it can take an attachment — cannot wait for a round-trip. The pane
 * answers them up front in `state`, and again with every item change, before
 * the dialog fires its own `ihub:itemchanged`.
 *
 * Deliberately free of imports: the utilities import this module, so it must
 * not import them back.
 *
 * @typedef {Object} OfficeRemoteState
 * @property {boolean} mailbox - Whether the pane is attached to a mailbox item.
 * @property {'read'|'compose'|null} mode - `detectOutlookMode()` in the pane.
 * @property {boolean} isAppointment - `isOutlookAppointmentMode()` in the pane.
 * @property {boolean} attachHost - `isOutlookAttachmentHost()` in the pane.
 * @property {boolean} canAttach - `canAttachFileToOutlookItem()` in the pane.
 *
 * @typedef {Object} OfficeRemote
 * @property {OfficeRemoteState} state
 * @property {(method: string, payload?: any, options?: { timeoutMs?: number }) => Promise<any>} call
 */

/** @type {OfficeRemote|null} */
let remote = null;

/**
 * Route the Outlook utilities through the pane (or stop, with `null`).
 *
 * @param {OfficeRemote|null} next
 */
export function setOfficeRemote(next) {
  remote = next || null;
}

/** @returns {OfficeRemote|null} The pane gateway, when this is a popped-out chat. */
export function getOfficeRemote() {
  return remote;
}

/**
 * Replace the pane's answers to the synchronous questions — on an item change.
 *
 * @param {Partial<OfficeRemoteState>} state
 */
export function updateOfficeRemoteState(state) {
  if (!remote || !state || typeof state !== 'object') return;
  remote.state = { ...remote.state, ...state };
}
