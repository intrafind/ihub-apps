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
      resolve();
      return;
    }
    loadedItem.unloadAsync(() => resolve());
  });
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
  const stubs = await getSelectedItemsAsync();
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
        try {
          await unloadItemAsync(loaded);
        } catch {}
      }
    }
  }
  return out;
}
