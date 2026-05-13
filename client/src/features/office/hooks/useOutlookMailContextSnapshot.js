import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEmbeddedHost } from '../contexts/EmbeddedHostContext';

/**
 * Maintains a live, user-editable snapshot of the current host mail context
 * (Outlook taskpane: subject + body + attachments; browser extension: page
 * text + selection). Exposed to the chat panel so it can render an
 * `OfficeMailContextBanner` above the input — the user sees what's about
 * to be sent and can drop individual attachments before pressing send.
 *
 * Behavior:
 *  - Fetches `host.readMessageContext()` on mount and again whenever Outlook
 *    fires `ihub:itemchanged` (user navigates to a different email).
 *  - Tracks per-message edits: a set of attachment ids the user removed via
 *    the banner. The set resets on item change.
 *  - `buildSnapshotOverride()` returns a copy of the live ctx with removed
 *    attachments stripped — chat adapter accepts this as `hostContextOverride`
 *    in params, skipping its own `readMessageContext()` call.
 *  - `confirmSent()` resets removals after a successful send so the next
 *    message starts from a clean snapshot of the same email.
 */
export function useOutlookMailContextSnapshot() {
  const host = useEmbeddedHost();
  const [state, setState] = useState({ loading: true, ctx: null });
  const [removedAttachmentIds, setRemovedAttachmentIds] = useState(() => new Set());
  // Bumped by ItemChanged so the chat panel can reset its edit state too.
  const [generation, setGeneration] = useState(0);
  const cancelRef = useRef({ cancelled: false });

  const hostKind = host?.kind;

  useEffect(() => {
    cancelRef.current = { cancelled: false };
    const localCancel = cancelRef.current;

    async function load() {
      setState({ loading: true, ctx: null });
      try {
        const ctx = await host.readMessageContext();
        if (!localCancel.cancelled) setState({ loading: false, ctx });
      } catch {
        if (!localCancel.cancelled) setState({ loading: false, ctx: null });
      }
    }

    load();

    function onItemChange() {
      setRemovedAttachmentIds(new Set());
      setGeneration(g => g + 1);
      load();
    }

    document.addEventListener('ihub:itemchanged', onItemChange);
    return () => {
      localCancel.cancelled = true;
      document.removeEventListener('ihub:itemchanged', onItemChange);
    };
    // host is a stable object from EmbeddedHostProvider; depend on kind so we
    // don't refetch on every render but do refetch if the host actually swaps.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [hostKind]);

  const removeAttachment = useCallback(id => {
    if (id == null) return;
    setRemovedAttachmentIds(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const restoreAttachments = useCallback(() => {
    setRemovedAttachmentIds(prev => (prev.size === 0 ? prev : new Set()));
  }, []);

  /**
   * Build the context override to forward to the chat adapter. Returns null
   * when no live context exists (extension on chrome:// page, Outlook compose
   * mode without an item, etc.) so the adapter can fall back to its own
   * `host.readMessageContext()` call.
   */
  const buildSnapshotOverride = useCallback(() => {
    if (!state.ctx) return null;
    const filtered = { ...state.ctx };
    if (removedAttachmentIds.size > 0 && Array.isArray(filtered.attachments)) {
      filtered.attachments = filtered.attachments.filter(a => !removedAttachmentIds.has(a?.id));
    }
    return filtered;
  }, [state.ctx, removedAttachmentIds]);

  const visibleAttachments = useMemo(() => {
    const list = Array.isArray(state.ctx?.attachments) ? state.ctx.attachments : [];
    // Hide inline images (signatures, embedded UI) from the user-facing list —
    // they still ride along in the API payload but cluttering the banner with
    // them makes review noisy.
    return list.filter(a => !a?.isInline);
  }, [state.ctx]);

  return {
    loading: state.loading,
    ctx: state.ctx,
    visibleAttachments,
    removedAttachmentIds,
    removeAttachment,
    restoreAttachments,
    buildSnapshotOverride,
    generation
  };
}

export default useOutlookMailContextSnapshot;
