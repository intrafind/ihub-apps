/* global Office */

import {
  fetchCurrentAppointmentContext,
  isOutlookAppointmentItemAvailable
} from './outlookCalendarContext';
import { readMailboxUserProfile, readMessageHeaders } from './outlookItemFields';

function getLiveItem() {
  try {
    return Office.context?.mailbox?.item ?? null;
  } catch {
    return null;
  }
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

// Exported so the review banner can recognize this specific failure and
// collapse it into a single explanatory line instead of repeating it once
// per attachment (see issue #1451).
export const MAILBOX_ATTACHMENT_API_UNAVAILABLE_MESSAGE =
  'getAttachmentContentAsync is not available (requires Mailbox 1.8+).';

// Exported for the same reason as above: the banner needs to tell "too
// large to fetch" apart from a generic fetch failure.
export const ATTACHMENT_TOO_LARGE_MESSAGE = 'Attachment too large to include automatically.';

// Attachments larger than this are skipped instead of pulled into memory as
// base64 — a large PDF/video attachment previously hung the taskpane while
// downloading, then failed anyway once it reached the document pipeline.
const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;

function getAttachmentContentAsync(item, attachmentId) {
  return new Promise((resolve, reject) => {
    if (!item || typeof item.getAttachmentContentAsync !== 'function') {
      reject(new Error(MAILBOX_ATTACHMENT_API_UNAVAILABLE_MESSAGE));
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
  const itemType = getCurrentOutlookItemType();
  if (itemType === 'appointment' || isOutlookAppointmentItemAvailable()) {
    return fetchCurrentAppointmentContext();
  }
  const ctx = await fetchCurrentMailContext();
  return { ...ctx, itemKind: 'message' };
}

// How often a snapshot read restarts against the new item before giving up
// when the user keeps switching emails mid-read. Every switch also fires
// ItemChanged, which triggers a fresh fetch anyway — this just bounds one
// call.
const MAX_SNAPSHOT_ATTEMPTS = 3;
// Pause before re-reading a torn snapshot, so the host can finish swapping
// Office.context.mailbox.item to the newly selected email.
const SNAPSHOT_RETRY_DELAY_MS = 200;
// The host's error for an attachment id that does not belong to the item it
// currently serves — the signature of a descriptor list read from a stale item.
const INVALID_ATTACHMENT_ID_RE = /does not exist|InvalidAttachmentId|not part of this item/i;

export async function fetchCurrentMailContext() {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt++) {
    // Capture the item exactly once per attempt. Every read below goes
    // against this capture so one snapshot can never mix two emails.
    const item = getLiveItem();
    if (!item) {
      return {
        available: false,
        reason: 'Not running in Outlook with a mail item (Office.js item missing).',
        attachments: []
      };
    }
    const itemId = item.itemId ?? null;

    const { snapshot, aborted, torn } = await readMailSnapshot(item, itemId);

    // Body and attachment content are host round-trips — the user may have
    // selected a different email while we were reading. A torn snapshot
    // (old descriptors, failed content fetches) must never be surfaced:
    // restart against the item that is now selected. The `aborted` flag
    // covers the switch-away-and-back case, where the live itemId matches
    // again by the time we check but the attachment list was cut short.
    if (aborted || getLiveItemId() !== itemId) continue;

    // Right after ItemChanged the host can still hand out the previous
    // email's cached fields (id, subject, attachment list) while the async
    // body and attachment calls already run against the new one. The
    // tell-tale sign is every attachment fetch failing with "attachment
    // identifier does not exist": the descriptors and the served item
    // disagree, and the pane would show the old attachments, each marked as
    // failed, next to the new body. Re-read after a short pause; the last
    // attempt returns what it got so the user still sees the email.
    if (torn && attempt < MAX_SNAPSHOT_ATTEMPTS - 1) {
      console.warn(
        '[office] mail snapshot looks torn (every attachment fetch failed with an unknown id) — re-reading the item'
      );
      await new Promise(resolve => setTimeout(resolve, SNAPSHOT_RETRY_DELAY_MS));
      continue;
    }
    return snapshot;
  }

  return {
    available: false,
    reason: 'Outlook item kept changing while reading; snapshot aborted.',
    attachments: []
  };
}

/**
 * One atomic read of the item the user has open. The snapshot carries the
 * body, the attachments and the headers the reply apps need — sender,
 * recipients, creation time — plus the signed-in mailbox user, so the model
 * can tell the user's own contributions in a quoted thread from everyone
 * else's. Every header degrades to null / [] on its own.
 */
async function readMailSnapshot(item, itemId) {
  let bodyText = null;
  try {
    bodyText = await getBodyTextAsync(item);
  } catch {}

  let subject = null;
  try {
    subject = await getSubjectAsync(item);
  } catch {}

  let headers = { from: null, to: [], cc: [], dateTimeCreated: null };
  try {
    headers = await readMessageHeaders(item);
  } catch {}
  const mailboxUser = readMailboxUserProfile();

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
    if (typeof d.size === 'number' && d.size > MAX_ATTACHMENT_SIZE_BYTES) {
      attachments.push({ ...d, error: ATTACHMENT_TOO_LARGE_MESSAGE });
      continue;
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

  const torn =
    !aborted &&
    attachments.length > 0 &&
    attachments.every(a => a.error && INVALID_ATTACHMENT_ID_RE.test(String(a.error)));

  return {
    torn,
    snapshot: {
      available: true,
      subject,
      itemId,
      from: headers.from,
      to: headers.to,
      cc: headers.cc,
      dateTimeCreated: headers.dateTimeCreated,
      mailboxUser,
      bodyText,
      attachments
    },
    aborted
  };
}
