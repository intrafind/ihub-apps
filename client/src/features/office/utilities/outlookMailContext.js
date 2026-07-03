/* global Office */

import {
  fetchCurrentAppointmentContext,
  isOutlookAppointmentItemAvailable
} from './outlookCalendarContext';

export function isOutlookMailItemAvailable() {
  try {
    return (
      typeof Office !== 'undefined' &&
      Office.context &&
      Office.context.mailbox &&
      Office.context.mailbox.item
    );
  } catch {
    return false;
  }
}

/**
 * All Office mailbox item operations in this module run through this promise
 * queue. Office.js allows only ONE item to be loaded via `loadItemByIdAsync`
 * at a time and redirects `Office.context.mailbox.item` to the loaded item
 * until `unloadAsync` completes — a context read that interleaves with a
 * load/unload cycle observes the wrong item, and a load started while
 * another is active fails outright. Serializing every reader keeps the
 * mailbox state coherent no matter how many callers fire at once (double
 * ItemChanged/SelectedItemsChanged dispatch, pin-button clicks, sends).
 */
let mailboxQueue = Promise.resolve();

function withMailboxLock(fn) {
  const result = mailboxQueue.then(() => fn());
  // Keep the chain alive whether the operation succeeds or fails.
  mailboxQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * itemId of the live `Office.context.mailbox.item`, or null when no item is
 * selected (the user deselected, compose mode, reading pane off). Cheap and
 * synchronous — safe to call at any frequency.
 */
export function getLiveItemId() {
  try {
    return Office.context?.mailbox?.item?.itemId ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns the lowercased itemType of the currently selected Outlook item,
 * or null if Office.js / mailbox.item is unavailable. Used by the host
 * adapter to pick between the mail and appointment context readers.
 */
export function getCurrentOutlookItemType() {
  try {
    const item = Office.context?.mailbox?.item;
    if (!item) return null;
    return String(item.itemType || '').toLowerCase() || null;
  } catch {
    return null;
  }
}

// The helpers below take the mail item as an explicit argument instead of
// re-reading `Office.context.mailbox.item` at call time. Office swaps that
// global whenever the user selects a different email, so a fetch that
// dereferences it at every await boundary can stitch together a snapshot
// from two different emails — most visibly by reading email A's attachment
// descriptors and then requesting their content from email B, which fails
// with InvalidAttachmentId ("attachment is not part of this item").

function getBodyTextAsync(item) {
  return new Promise((resolve, reject) => {
    if (!item || !item.body) {
      resolve(null);
      return;
    }
    item.body.getAsync(Office.CoercionType.Text, result => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        reject(result.error);
        return;
      }
      resolve(result.value ?? null);
    });
  });
}

function getAttachmentContentAsync(item, attachmentId) {
  return new Promise((resolve, reject) => {
    if (!item || typeof item.getAttachmentContentAsync !== 'function') {
      reject(new Error('getAttachmentContentAsync is not available (requires Mailbox 1.8+).'));
      return;
    }
    item.getAttachmentContentAsync(attachmentId, result => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        reject(result.error);
        return;
      }
      resolve(result.value);
    });
  });
}

function getAttachmentDescriptors(item) {
  if (!item || !item.attachments || !item.attachments.length) {
    return [];
  }
  return item.attachments.map(a => ({
    id: a.id,
    name: a.name,
    size: a.size,
    contentType: a.contentType,
    attachmentType: a.attachmentType,
    isInline: a.isInline
  }));
}

function getSubjectAsync(item) {
  return new Promise(resolve => {
    if (!item) {
      resolve(null);
      return;
    }
    if (typeof item.subject === 'string') {
      resolve(item.subject);
    } else if (item.subject && typeof item.subject.getAsync === 'function') {
      item.subject.getAsync(result => {
        resolve(result.status === Office.AsyncResultStatus.Succeeded ? result.value : null);
      });
    } else {
      resolve(null);
    }
  });
}

/**
 * Unified entry point used by the host adapter — dispatches to either the
 * mail-context or appointment-context reader based on the current item's
 * `itemType`. Adds an `itemKind: 'message'|'appointment'` discriminator to
 * the mail-context payload so downstream consumers (snapshot hook, context
 * strip, chat adapter) can pick the right banner / prompt formatter.
 */
export async function fetchCurrentOutlookItemContext() {
  // The itemType probe and both readers run under the mailbox lock: while a
  // multi-select loadItemByIdAsync cycle is active, Office.context.mailbox.item
  // is redirected to the loaded message, so probing outside the lock could
  // classify a calendar item as mail (or hand the appointment reader a
  // redirected item). Note fetchCurrentMailContextLocked is called directly —
  // the public fetchCurrentMailContext would try to take the lock again.
  return withMailboxLock(async () => {
    const itemType = getCurrentOutlookItemType();
    if (itemType === 'appointment' || isOutlookAppointmentItemAvailable()) {
      return fetchCurrentAppointmentContext();
    }
    const ctx = await fetchCurrentMailContextLocked();
    return { ...ctx, itemKind: 'message' };
  });
}

// How often a snapshot read restarts against the new item before giving up
// when the user keeps switching emails mid-read. Every switch also fires
// ItemChanged, which triggers a fresh fetch anyway — this just bounds one
// call.
const MAX_SNAPSHOT_ATTEMPTS = 3;

export async function fetchCurrentMailContext() {
  return withMailboxLock(fetchCurrentMailContextLocked);
}

async function fetchCurrentMailContextLocked() {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt++) {
    if (!isOutlookMailItemAvailable()) {
      return {
        available: false,
        reason: 'Not running in Outlook with a mail item (Office.js item missing).',
        attachments: []
      };
    }

    // Capture the item exactly once per attempt. Every read below goes
    // against this capture so one snapshot can never mix two emails.
    const item = Office.context.mailbox.item;
    const itemId = item.itemId ?? null;

    const { snapshot, aborted } = await readMailSnapshot(item, itemId);

    // Body and attachment content are host round-trips — the user may have
    // selected a different email while we were reading. A torn snapshot
    // (old descriptors, failed content fetches) must never be surfaced:
    // restart against the item that is now selected. The `aborted` flag
    // covers the switch-away-and-back case, where the live itemId matches
    // again by the time we check but the attachment list was cut short.
    if (aborted || getLiveItemId() !== itemId) continue;
    return snapshot;
  }

  return {
    available: false,
    reason: 'Outlook item kept changing while reading; snapshot aborted.',
    attachments: []
  };
}

async function readMailSnapshot(item, itemId) {
  let bodyText = null;
  try {
    bodyText = await getBodyTextAsync(item);
  } catch {}

  let subject = null;
  try {
    subject = await getSubjectAsync(item);
  } catch {}

  const descriptors = getAttachmentDescriptors(item);
  const attachments = [];
  let aborted = false;

  for (const d of descriptors) {
    if (!d.id) {
      attachments.push({ ...d, error: 'Missing attachment id' });
      continue;
    }
    // Stop downloading as soon as the selection moves on — the caller
    // retries the whole snapshot, so finishing these fetches would only
    // produce InvalidAttachmentId errors against the newly selected item.
    // The explicit flag matters for the switch-away-and-back case: the
    // live itemId can match the capture again by the time the caller
    // checks, but the attachment list would be silently truncated.
    if (getLiveItemId() !== itemId) {
      aborted = true;
      break;
    }
    try {
      const raw = await getAttachmentContentAsync(item, d.id);
      attachments.push({
        ...d,
        content: {
          format: raw.format,
          content: raw.content
        }
      });
    } catch (e) {
      attachments.push({
        ...d,
        error: e && e.message ? e.message : String(e)
      });
    }
  }

  return {
    snapshot: {
      available: true,
      subject,
      itemId,
      bodyText,
      attachments
    },
    aborted
  };
}

function getSelectedItemsAsync() {
  return new Promise((resolve, reject) => {
    if (
      typeof Office === 'undefined' ||
      !Office.context ||
      !Office.context.mailbox ||
      typeof Office.context.mailbox.getSelectedItemsAsync !== 'function'
    ) {
      reject(new Error('getSelectedItemsAsync is not available (requires Mailbox 1.13+).'));
      return;
    }
    Office.context.mailbox.getSelectedItemsAsync(result => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        reject(result.error);
        return;
      }
      resolve(Array.isArray(result.value) ? result.value : []);
    });
  });
}

function loadItemByIdAsync(itemId) {
  return new Promise((resolve, reject) => {
    if (
      typeof Office === 'undefined' ||
      !Office.context ||
      !Office.context.mailbox ||
      typeof Office.context.mailbox.loadItemByIdAsync !== 'function'
    ) {
      reject(new Error('loadItemByIdAsync is not available (requires Mailbox 1.15+).'));
      return;
    }
    Office.context.mailbox.loadItemByIdAsync(itemId, result => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        reject(result.error);
        return;
      }
      resolve(result.value);
    });
  });
}

function getLoadedItemBodyTextAsync(loadedItem) {
  return new Promise(resolve => {
    if (!loadedItem || !loadedItem.body || typeof loadedItem.body.getAsync !== 'function') {
      resolve(null);
      return;
    }
    loadedItem.body.getAsync(Office.CoercionType.Text, result => {
      resolve(result.status === Office.AsyncResultStatus.Succeeded ? (result.value ?? null) : null);
    });
  });
}

function unloadItemAsync(loadedItem) {
  return new Promise(resolve => {
    if (!loadedItem || typeof loadedItem.unloadAsync !== 'function') {
      resolve(true);
      return;
    }
    loadedItem.unloadAsync(result => {
      resolve(result?.status !== Office.AsyncResultStatus.Failed);
    });
  });
}

/**
 * Unload a loaded multi-select item, retrying once on failure. This must not
 * fail silently: while an item is loaded, `Office.context.mailbox.item` is
 * redirected to it, so a leaked load freezes every subsequent context read
 * on that email until the taskpane is reloaded (Office.js offers no other
 * recovery).
 */
async function unloadItemWithRetry(loadedItem) {
  let unloaded = false;
  try {
    unloaded = await unloadItemAsync(loadedItem);
  } catch {}
  if (!unloaded) {
    try {
      unloaded = await unloadItemAsync(loadedItem);
    } catch {}
  }
  if (!unloaded) {
    console.warn(
      '[office] unloadAsync failed — Office.context.mailbox.item may stay stale until the taskpane reloads'
    );
  }
  return unloaded;
}

/**
 * Read body + subject for every email the user has currently selected in
 * Outlook (Ctrl-click multi-select). Requires Mailbox 1.15+ — callers should
 * gate this behind `isMultiSelectBodySupported()` from officeCapabilities.js.
 *
 * Attachments are intentionally NOT pulled here: loadItemByIdAsync's loaded
 * item doesn't expose getAttachmentContentAsync, and round-tripping every
 * selected email's attachments would explode token budgets. Pinned single
 * emails (added one-by-one via `fetchCurrentMailContext`) still carry their
 * attachments.
 */
export async function fetchSelectedItemsContext() {
  return withMailboxLock(fetchSelectedItemsContextLocked);
}

async function fetchSelectedItemsContextLocked() {
  const stubs = await getSelectedItemsAsync();

  // Single selection: the selected email is the one open in the reading
  // pane, which callers already read in full (body + attachments) via
  // fetchCurrentMailContext. Skip the loadItemByIdAsync/unloadAsync cycle
  // entirely — it redirects Office.context.mailbox.item to the loaded item
  // and a failed unload freezes the taskpane on that email — and Microsoft's
  // multi-select guidance is to avoid loadItemByIdAsync whenever the data is
  // available another way.
  if (stubs.length <= 1) {
    const liveId = getLiveItemId();
    const only = stubs[0];
    if (!only || !only.itemId || (liveId && only.itemId === liveId)) {
      return [];
    }
  }

  const out = [];
  for (const stub of stubs) {
    if (!stub || !stub.itemId) continue;
    let loaded = null;
    try {
      loaded = await loadItemByIdAsync(stub.itemId);
      const bodyText = await getLoadedItemBodyTextAsync(loaded);
      out.push({
        available: true,
        subject: stub.subject ?? null,
        itemId: stub.itemId,
        bodyText,
        attachments: []
      });
    } catch {
      out.push({
        available: true,
        subject: stub.subject ?? null,
        itemId: stub.itemId,
        bodyText: null,
        attachments: []
      });
    } finally {
      if (loaded) {
        await unloadItemWithRetry(loaded);
      }
    }
  }
  return out;
}
