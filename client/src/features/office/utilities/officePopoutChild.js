/* global Office */

import { createPopoutEndpoint } from './officePopoutBridge';
import { setOfficeRemote, updateOfficeRemoteState } from './officeRemote';
import { POPOUT_READ_TIMEOUT_MS } from './officePopout';

/**
 * The popped-out chat's end of the bridge to the task pane (the pane's end is
 * `openChatPopout` in `officePopout.js`).
 *
 * Connects, asks the pane for everything the chat starts with, and installs
 * the pane as this window's Outlook gateway (`officeRemote.js`), so the
 * Outlook utilities route through it from here on.
 */

/** How long the window waits for the pane's first answer. */
const HELLO_TIMEOUT_MS = 15 * 1000;

/** Calls that go through Outlook's own, sometimes slow, APIs in the pane. */
const SLOW_METHODS = new Set(['readItemContext', 'readMailContext', 'runMailAction', 'attachFile']);

/**
 * Connect to the pane.
 *
 * @returns {Promise<{
 *   init: { config: object, user: object|null, tokens: object, chat: object, state: object },
 *   popout: { role: 'child', dock: Function, report: Function, reportPinned: Function,
 *     signedOut: Function }
 * }>} Rejects when the pane does not answer — the window was opened from
 *   somewhere else, or the pane is gone.
 */
export async function connectPopoutToPane() {
  const endpoint = createPopoutEndpoint({
    send: message => Office.context.ui.messageParent(message),
    onEvent: (name, payload) => {
      if (name !== 'itemchanged') return;
      // The synchronous answers first, so whoever reacts to the event reads
      // the new item's.
      updateOfficeRemoteState(payload);
      document.dispatchEvent(new CustomEvent('ihub:itemchanged'));
    }
  });

  await new Promise((resolve, reject) => {
    Office.context.ui.addHandlerAsync(
      Office.EventType.DialogParentMessageReceived,
      arg => endpoint.receive(arg?.message),
      result => {
        if (result?.status === Office.AsyncResultStatus.Failed) reject(result.error);
        else resolve();
      }
    );
  });

  const init = await endpoint.request('hello', null, { timeoutMs: HELLO_TIMEOUT_MS });
  if (!init || typeof init !== 'object' || !init.config) {
    throw new Error('The Outlook pane sent nothing to start with.');
  }

  setOfficeRemote({
    state: init.state && typeof init.state === 'object' ? init.state : {},
    call: (method, payload, options = {}) =>
      endpoint.request(method, payload, {
        timeoutMs: SLOW_METHODS.has(method) ? POPOUT_READ_TIMEOUT_MS : undefined,
        ...options
      })
  });

  const popout = {
    role: 'child',
    // The pane takes the chat and closes this window. A pane that is gone
    // cannot, so the window closes itself — there is nothing left to do here.
    dock: state =>
      endpoint.request('dock', state).catch(() => {
        try {
          window.close();
        } catch {
          // Office keeps the window; its X still closes it.
        }
      }),
    report: state => endpoint.emit('chatState', state),
    reportPinned: pinnedEmails => endpoint.emit('pinnedEmails', pinnedEmails),
    signedOut: () => endpoint.emit('signedOut')
  };

  return { init, popout };
}
