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

  for (const d of descriptors) {
    if (!d.id) {
      attachments.push({ ...d, error: 'Missing attachment id' });
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
      attachments.push({
        ...d,
        error: e && e.message ? e.message : String(e)
      });
    }
  }

  return {
    available: true,
    subject,
    itemId,
    bodyText,
    attachments
  };
}
