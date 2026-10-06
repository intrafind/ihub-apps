/* global Office */

import { createPopoutEndpoint } from './officePopoutBridge';
import { getOfficeRemote } from './officeRemote';
import {
  isMailboxAvailable,
  isOutlookAppointmentMode,
  isRequirementSetSupported
} from './officeCapabilities';
import { fetchCurrentMailContext, fetchCurrentOutlookItemContext } from './outlookMailContext';
import { detectOutlookMode, runOutlookMailAction } from './outlookMailActions';
import {
  attachFileToOutlookItem,
  canAttachFileToOutlookItem,
  isOutlookAttachmentHost
} from './outlookAttachments';
import { openExternalUrl } from '../../../utils/externalNavigation';
import { getAccessToken, getRefreshToken, refreshTokenOrExpireSession } from '../api/officeAuth';

/**
 * Pop the task pane's chat out into a large, resizable window.
 *
 * Outlook decides how wide an add-in task pane is, and in Outlook on the web
 * and the new Outlook for Windows the user cannot drag it wider. An Office
 * dialog is a window of its own that the user can move and resize, so the
 * chat moves there — and the pane stays open behind it as the dialog's
 * gateway to Outlook (see `officeRemote.js` for the dialog's half):
 *
 *   dialog → pane   hello, readItemContext, readMailContext, runMailAction,
 *                   attachFile, openUrl, refreshToken, dock
 *                   (events: chatState, pinnedEmails, signedOut)
 *   pane → dialog   itemchanged (with the item's new state)
 *
 * The pane must stay open for this to work: a pane Outlook closes (an
 * unpinned pane when the user selects another email) takes the dialog's
 * gateway with it. The pane therefore shows a placeholder while the dialog is
 * open, and takes the chat back — with whatever happened in the dialog —
 * once it closes.
 */

/** Query parameter that turns the task-pane page into the popped-out chat. */
export const POPOUT_QUERY_PARAM = 'popout';

/** Dialog size, in percent of the screen. The user can resize it from there. */
const DIALOG_WIDTH_PERCENT = 70;
const DIALOG_HEIGHT_PERCENT = 85;

/** Reads go through Outlook's attachment API, which is slow for large files. */
export const POPOUT_READ_TIMEOUT_MS = 2 * 60 * 1000;

/** Same debounce the mail snapshot uses before re-reading a changed item. */
const ITEM_CHANGED_DEBOUNCE_MS = 150;

/** Office's error code for a dialog the user closed with its X. */
export const DIALOG_CLOSED_BY_USER = 12006;

/**
 * Whether this page is the popped-out chat rather than the task pane.
 *
 * @param {string} [search] - `window.location.search`.
 * @returns {boolean}
 */
export function isPopoutPage(search = typeof window !== 'undefined' ? window.location.search : '') {
  try {
    return new URLSearchParams(search).get(POPOUT_QUERY_PARAM) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether the pane can pop its chat out: an Outlook mail host whose dialog API
 * can message the dialog (`messageChild`, DialogApi 1.2). Older clients —
 * volume-licensed Outlook 2016/2019 — cannot, and keep the chat in the pane.
 *
 * @returns {boolean}
 */
export function isPopoutSupported() {
  if (getOfficeRemote()) return false;
  try {
    if (
      typeof Office === 'undefined' ||
      typeof Office?.context?.ui?.displayDialogAsync !== 'function'
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return isMailboxAvailable() && isRequirementSetSupported('DialogApi', '1.2');
}

/**
 * The address of the popped-out chat: the task-pane page itself, flagged.
 * Language and theme ride along because the dialog may not share the pane's
 * storage (Outlook on the web partitions the pane's).
 *
 * @param {object} options
 * @param {string} [options.href] - The pane's own address.
 * @param {string} [options.language]
 * @param {string} [options.theme] - Theme preference: light, dark or auto.
 * @returns {string}
 */
export function buildPopoutUrl({ href = window.location.href, language, theme } = {}) {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(POPOUT_QUERY_PARAM, '1');
  if (language) url.searchParams.set('lang', language);
  if (theme) url.searchParams.set('theme', theme);
  return url.toString();
}

/**
 * The answers to the questions the dialog asks synchronously. See
 * `OfficeRemoteState` in `officeRemote.js`.
 *
 * @returns {import('./officeRemote').OfficeRemoteState}
 */
export function readPaneOutlookState() {
  return {
    mailbox: isMailboxAvailable(),
    mode: detectOutlookMode(),
    isAppointment: isOutlookAppointmentMode(),
    attachHost: isOutlookAttachmentHost(),
    canAttach: canAttachFileToOutlookItem()
  };
}

/**
 * Open the dialog and serve it until it closes.
 *
 * @param {object} options
 * @param {string} options.url - From {@link buildPopoutUrl}.
 * @param {() => object} options.getInit - What the dialog starts with, read when
 *   it asks (`hello`): config, user, app, chat and the pane's Outlook state.
 * @param {(state: object) => void} [options.onChatState] - The dialog's chat,
 *   whenever it changes — what the pane takes back on close.
 * @param {(pinnedEmails: object[]) => void} [options.onPinnedEmails]
 * @param {(reason: 'closed'|'docked'|'signedOut'|'error', error?: any) => void} options.onClosed
 * @returns {Promise<{ close: () => void }>} Resolves once the dialog is open;
 *   rejects when Office refused to open it.
 */
export function openChatPopout({ url, getInit, onChatState, onPinnedEmails, onClosed }) {
  return new Promise((resolve, reject) => {
    let dialog = null;
    let endpoint = null;
    let closed = false;
    let itemTimer = null;

    const onItemChanged = () => {
      if (itemTimer) clearTimeout(itemTimer);
      itemTimer = setTimeout(() => {
        itemTimer = null;
        endpoint?.emit('itemchanged', readPaneOutlookState());
      }, ITEM_CHANGED_DEBOUNCE_MS);
    };

    const finish = (reason, error) => {
      if (closed) return;
      closed = true;
      if (itemTimer) clearTimeout(itemTimer);
      document.removeEventListener('ihub:itemchanged', onItemChanged);
      endpoint?.dispose();
      if (reason !== 'closed') {
        try {
          dialog?.close();
        } catch {
          // Already gone.
        }
      }
      onClosed(reason, error);
    };

    const handlers = {
      hello: () => ({ ...getInit(), state: readPaneOutlookState() }),
      readItemContext: () => fetchCurrentOutlookItemContext(),
      readMailContext: () => fetchCurrentMailContext(),
      runMailAction: ({ action, markdown, options } = {}) =>
        runOutlookMailAction(action, markdown, options || {}),
      attachFile: ({ base64, filename } = {}) => attachFileToOutlookItem({ base64, filename }),
      openUrl: ({ url: target } = {}) => ({ ok: openExternalUrl(target) }),
      refreshToken: async () => {
        await refreshTokenOrExpireSession();
        return { access_token: getAccessToken(), refresh_token: getRefreshToken() };
      },
      dock: state => {
        if (state) onChatState?.(state);
        // Answer first, so the dialog's call settles before it is closed.
        setTimeout(() => finish('docked'), 0);
        return { ok: true };
      }
    };

    const onEvent = (name, payload) => {
      if (name === 'chatState' && payload) onChatState?.(payload);
      else if (name === 'pinnedEmails') onPinnedEmails?.(Array.isArray(payload) ? payload : []);
      else if (name === 'signedOut') finish('signedOut');
    };

    try {
      Office.context.ui.displayDialogAsync(
        url,
        { width: DIALOG_WIDTH_PERCENT, height: DIALOG_HEIGHT_PERCENT },
        result => {
          if (result.status !== Office.AsyncResultStatus.Succeeded) {
            reject(result.error || new Error('The window could not be opened.'));
            return;
          }
          dialog = result.value;
          endpoint = createPopoutEndpoint({
            send: message => dialog.messageChild(message),
            handlers,
            onEvent
          });
          dialog.addEventHandler(Office.EventType.DialogMessageReceived, arg => {
            endpoint?.receive(arg?.message);
          });
          dialog.addEventHandler(Office.EventType.DialogEventReceived, arg => {
            finish(arg?.error === DIALOG_CLOSED_BY_USER ? 'closed' : 'error', arg);
          });
          document.addEventListener('ihub:itemchanged', onItemChanged);
          resolve({ close: () => finish('docked') });
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}
