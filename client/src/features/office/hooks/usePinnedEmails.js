import { useCallback, useState } from 'react';
import { fetchCurrentMailContext } from '../utilities/outlookMailContext';

/**
 * Emails the user has explicitly attached to the next message — "pinned" or
 * "collected" emails. They ride alongside the currently open item so a user
 * can move through the inbox, pick up a few messages, and answer them in one
 * go. Used by the start page (collect, then start the chat) and by the chat
 * panel (keep collecting mid-conversation); the start page hands its list to
 * the panel through the chat handoff.
 *
 * `addEmails` is the "Add email(s)" entry point (issue #1553): it attaches
 * the email open in the reading pane, de-duplicated by item id. Collecting
 * Ctrl-selected emails was removed with the manifest's SupportsMultiSelect:
 * it turned off ItemChanged in Outlook for Mac, so the pinned pane never
 * followed the open email there.
 */
// Sender / recipients / creation time as read by outlookMailContext — kept on
// the pinned entry so the model sees who wrote each collected email.
const headerFields = src => ({
  from: src.from ?? null,
  to: Array.isArray(src.to) ? src.to : [],
  cc: Array.isArray(src.cc) ? src.cc : [],
  dateTimeCreated: src.dateTimeCreated ?? null
});

export default function usePinnedEmails() {
  const [pinnedEmails, setPinnedEmails] = useState([]);
  const [addEmailsLoading, setAddEmailsLoading] = useState(false);

  const addEmails = useCallback(async () => {
    setAddEmailsLoading(true);
    try {
      // Errors are logged, not swallowed, so a failing host API never leaves
      // the user staring at an unresponsive button.
      let ctx = null;
      try {
        ctx = await fetchCurrentMailContext();
      } catch (err) {
        console.warn('[office] reading current email failed', err);
      }
      if (!ctx?.available || !(ctx.itemId || ctx.subject || ctx.bodyText)) return;
      const entry = {
        itemId: ctx.itemId ?? null,
        subject: ctx.subject ?? null,
        ...headerFields(ctx),
        bodyText: ctx.bodyText ?? null,
        attachments: ctx.attachments ?? []
      };
      setPinnedEmails(prev =>
        entry.itemId && prev.some(p => p.itemId === entry.itemId) ? prev : [...prev, entry]
      );
    } finally {
      setAddEmailsLoading(false);
    }
  }, []);

  const unpin = useCallback(itemId => {
    setPinnedEmails(prev => {
      if (!itemId) return prev;
      return prev.filter(p => p.itemId !== itemId);
    });
  }, []);

  const clearPinned = useCallback(() => {
    setPinnedEmails([]);
  }, []);

  return {
    pinnedEmails,
    setPinnedEmails,
    addEmails,
    unpin,
    clearPinned,
    addEmailsLoading
  };
}
