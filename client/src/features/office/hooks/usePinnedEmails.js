import { useCallback, useState } from 'react';
import {
  fetchCurrentMailContext,
  fetchSelectedItemsContext
} from '../utilities/outlookMailContext';
import { isMultiSelectBodySupported } from '../utilities/officeCapabilities';

/**
 * Emails the user has explicitly attached to the next message — "pinned" or
 * "collected" emails. They ride alongside the currently open item so a user
 * can move through the inbox, pick up a few messages, and answer them in one
 * go. Used by the start page (collect, then start the chat) and by the chat
 * panel (keep collecting mid-conversation); the start page hands its list to
 * the panel through the chat handoff.
 *
 * `addEmails` is the single "Add email(s)" entry point (issue #1553): it
 * attaches every email the user has Ctrl-selected in Outlook (Mailbox 1.15+)
 * and/or the email open in the reading pane, de-duplicated by item id.
 */
export default function usePinnedEmails() {
  const [pinnedEmails, setPinnedEmails] = useState([]);
  const [addEmailsLoading, setAddEmailsLoading] = useState(false);
  const multiSelectSupported = isMultiSelectBodySupported();

  const addEmails = useCallback(async () => {
    setAddEmailsLoading(true);
    try {
      const collected = [];
      const seenIds = new Set();
      const pushEntry = entry => {
        if (entry.itemId && seenIds.has(entry.itemId)) return;
        if (entry.itemId) seenIds.add(entry.itemId);
        collected.push(entry);
      };

      // 1. Pull every email the user has multi-selected in Outlook. On a
      //    single selection this returns just the open email; on no
      //    selection it returns nothing — both handled by the fallback
      //    below. Errors are logged, not swallowed, so a failing host API
      //    never leaves the user staring at an unresponsive button.
      if (multiSelectSupported) {
        try {
          const items = await fetchSelectedItemsContext();
          if (Array.isArray(items)) {
            for (const it of items) {
              pushEntry({
                itemId: it.itemId ?? null,
                subject: it.subject ?? null,
                bodyText: it.bodyText ?? null,
                attachments: []
              });
            }
          }
        } catch (err) {
          console.warn('[office] reading selected emails failed', err);
        }
      }

      // 2. When the user has a single email open — either because
      //    multi-select isn't supported, or only one message is selected —
      //    pull the full current-mail context. This guarantees the open
      //    email is always added and captures its attachments, which the
      //    lightweight multi-select reader deliberately skips.
      if (collected.length <= 1) {
        try {
          const ctx = await fetchCurrentMailContext();
          if (ctx?.available && (ctx.itemId || ctx.subject || ctx.bodyText)) {
            const entry = {
              itemId: ctx.itemId ?? null,
              subject: ctx.subject ?? null,
              bodyText: ctx.bodyText ?? null,
              attachments: ctx.attachments ?? []
            };
            // Upgrade the matching multi-select stub with attachments rather
            // than adding a duplicate of the same email.
            const idx = ctx.itemId ? collected.findIndex(c => c.itemId === ctx.itemId) : -1;
            if (idx >= 0) collected[idx] = entry;
            else pushEntry(entry);
          }
        } catch (err) {
          console.warn('[office] reading current email failed', err);
        }
      }

      if (collected.length === 0) return;

      setPinnedEmails(prev => {
        const seen = new Set(prev.map(p => p.itemId).filter(Boolean));
        const additions = collected.filter(c => !(c.itemId && seen.has(c.itemId)));
        return additions.length ? [...prev, ...additions] : prev;
      });
    } finally {
      setAddEmailsLoading(false);
    }
  }, [multiSelectSupported]);

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
    addEmailsLoading,
    multiSelectSupported
  };
}
