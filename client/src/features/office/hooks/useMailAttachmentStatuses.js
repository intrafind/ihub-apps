import { useCallback, useEffect, useState } from 'react';
import { useEmbeddedHost } from '../contexts/EmbeddedHostContext';
import { buildAttachmentStatuses } from '../utilities/buildChatApiMessages';

/**
 * Reads the current host mail context and exposes a per-attachment status
 * array suitable for display in a banner.
 *
 * Re-runs on:
 *   - mount,
 *   - `ihub:itemchanged` events (Outlook switches the active mail item),
 *   - explicit `refresh()` calls.
 *
 * The hook is deliberately tolerant: if the host has no mail context (browser
 * extension side panel, taskpane without a selected item), it returns an
 * empty list rather than throwing.
 *
 * @returns {{
 *   statuses: Array<{ name: string, status: 'attached' | 'unsupported' | 'failed', message?: string, reason?: string }>,
 *   apiUnavailable: boolean,
 *   refresh: () => void
 * }}
 */
export function useMailAttachmentStatuses() {
  const host = useEmbeddedHost();
  const [statuses, setStatuses] = useState([]);
  const [apiUnavailable, setApiUnavailable] = useState(false);

  const load = useCallback(async () => {
    try {
      const ctx = await host.readMessageContext();
      setStatuses(buildAttachmentStatuses(ctx?.attachments || []));
      setApiUnavailable(!!ctx?.attachmentApiUnavailable);
    } catch {
      // Context unavailable — clear so we don't show stale state.
      setStatuses([]);
      setApiUnavailable(false);
    }
  }, [host]);

  useEffect(() => {
    load();
    const handler = () => load();
    document.addEventListener('ihub:itemchanged', handler);
    return () => document.removeEventListener('ihub:itemchanged', handler);
  }, [load]);

  return { statuses, apiUnavailable, refresh: load };
}
