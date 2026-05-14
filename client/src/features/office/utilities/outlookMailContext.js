/* global Office */

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

function getBodyTextAsync() {
  return new Promise((resolve, reject) => {
    const item = Office.context.mailbox.item;
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

function isAttachmentContentApiAvailable() {
  const item = Office.context?.mailbox?.item;
  return !!(item && typeof item.getAttachmentContentAsync === 'function');
}

function getAttachmentContentAsync(attachmentId) {
  return new Promise((resolve, reject) => {
    const item = Office.context.mailbox.item;
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

function getAttachmentDescriptors() {
  const item = Office.context.mailbox.item;
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

function getSubjectAsync() {
  return new Promise(resolve => {
    const item = Office.context.mailbox.item;
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

export async function fetchCurrentMailContext() {
  if (!isOutlookMailItemAvailable()) {
    return {
      available: false,
      reason: 'Not running in Outlook with a mail item (Office.js item missing).',
      attachments: []
    };
  }

  const item = Office.context.mailbox.item;
  let bodyText = null;
  try {
    bodyText = await getBodyTextAsync();
  } catch {}

  let subject = null;
  try {
    subject = await getSubjectAsync();
  } catch {}

  const itemId = item.itemId ?? null;

  const descriptors = getAttachmentDescriptors();
  const attachments = [];

  // Check Mailbox API availability ONCE up-front. Without 1.8+ we can't pull
  // attachment content at all — emit a single notice instead of repeating the
  // same error for every attachment.
  let attachmentApiUnavailable = false;
  if (descriptors.length > 0 && !isAttachmentContentApiAvailable()) {
    attachmentApiUnavailable = true;
    console.warn(
      '[outlook] getAttachmentContentAsync unavailable (requires Mailbox 1.8+); skipping attachment content fetch.'
    );
  }

  for (const d of descriptors) {
    if (!d.id) {
      attachments.push({ ...d, error: 'Missing attachment id' });
      continue;
    }
    if (attachmentApiUnavailable) {
      // Keep the descriptor so the UI can list the attachment with a
      // clear "host unsupported" reason, but don't try to fetch content.
      attachments.push({
        ...d,
        error: 'Attachment content requires Outlook Mailbox 1.8+ (host does not support it).'
      });
      continue;
    }
    if (d.attachmentType === 'item') {
      // Attached emails (.eml/.msg items) come back as a MIME message, not a
      // binary doc — handing them to base64ToFile + processDocumentFile is a
      // dead-end. Skip the fetch and let the UI render an "unsupported" entry.
      attachments.push({
        ...d,
        skipped: true,
        skipReason: 'eml',
        skipMessage: 'Email items are not yet supported as attachments.'
      });
      continue;
    }
    try {
      const raw = await getAttachmentContentAsync(d.id);
      attachments.push({
        ...d,
        content: {
          format: raw.format,
          content: raw.content
        }
      });
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      console.error('[outlook] failed to read attachment content', {
        fileName: d.name,
        contentType: d.contentType,
        attachmentType: d.attachmentType,
        size: d.size,
        error: message
      });
      attachments.push({
        ...d,
        error: message
      });
    }
  }

  return {
    available: true,
    subject,
    itemId,
    bodyText,
    attachments,
    attachmentApiUnavailable
  };
}
