import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEmbeddedHost } from '../contexts/EmbeddedHostContext';
import { getLiveItemId } from '../utilities/outlookMailContext';
import {
  ITEM_CHANGED_EVENT,
  ITEM_CHANGE_SOURCE,
  getItemChangeSource,
  isDifferentItem
} from '../utilities/officeItemChange';

// How long a SelectedItemsChanged event waits before the hook checks whether
// the open item actually changed. Outlook fires it as soon as the list
// selection moves, usually before mailbox.item points at the new email.
const SELECTION_SETTLE_MS = 400;

/**
 * Maintains a live, user-editable snapshot of the current host mail context
 * (Outlook taskpane: subject + body + attachments; browser extension: page
 * text + selection). Exposed to the chat panel so it can render an
 * `OfficeMailContextBanner` above the input — the user sees what's about
 * to be sent and can drop individual attachments before pressing send.
 *
 * Behavior:
 *  - Fetches `host.readMessageContext()` on mount and again whenever Outlook
 *    fires `ihub:itemchanged` for ItemChanged (user navigates to a different
 *    email). A SelectedItemsChanged event only re-reads once the selection
 *    has settled and the open item really is a different one.
 *  - Tracks per-message edits: a set of attachment ids the user removed via
 *    the banner. The set resets when the event concerns a different item.
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
  // Per-email opt-out for the email body. Survives within a single email view
  // but resets on ItemChanged so the user can't accidentally suppress the
  // body of an unrelated email. Replaces the old `hostContextFlags.emailBody`
  // plumbing (issue #1467) — the OfficeMailContextBanner owns this state now
  // and the contextToggles mechanism is no longer used in the Outlook host.
  const [includeBody, setIncludeBody] = useState(true);
  // Bumped by ItemChanged so the chat panel can reset its edit state too.
  const [generation, setGeneration] = useState(0);
  // Monotonic sequence for context loads. A single click in Outlook fires
  // both ItemChanged and SelectedItemsChanged (each dispatching
  // 'ihub:itemchanged'), so loads overlap; only the newest one may publish
  // its result. Without this, a slow load that started on the previous
  // email resolves last and clobbers the fresh snapshot with stale
  // attachments ("not part of this item" errors).
  const loadSeqRef = useRef(0);
  const reloadTimerRef = useRef(null);
  const selectionTimerRef = useRef(null);
  // itemId the snapshot and the per-email edits above belong to.
  const itemIdRef = useRef(getLiveItemId());

  const hostKind = host?.kind;

  useEffect(() => {
    let disposed = false;

    async function load() {
      const seq = ++loadSeqRef.current;
      setState({ loading: true, ctx: null });
      let ctx = null;
      try {
        ctx = await host.readMessageContext();
      } catch {
        ctx = null;
      }
      if (disposed || seq !== loadSeqRef.current) return;
      setState({ loading: false, ctx });
    }

    load();

    function reload() {
      // A selection event for the email already open (re-selecting it, a
      // list refresh) must not undo the user's attachment removals or body
      // opt-out — only a different item does. Issue #2450.
      const liveItemId = getLiveItemId();
      if (isDifferentItem({ liveItemId, lastItemId: itemIdRef.current })) {
        setRemovedAttachmentIds(new Set());
        setIncludeBody(true);
        setGeneration(g => g + 1);
      }
      itemIdRef.current = liveItemId;
      // Supersede any in-flight load right away and show the loading state,
      // but debounce the actual read: a burst of events should cost one
      // read, and the short pause also gives the host time to finish
      // swapping Office.context.mailbox.item.
      loadSeqRef.current++;
      setState({ loading: true, ctx: null });
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = setTimeout(() => {
        reloadTimerRef.current = null;
        load();
      }, 150);
    }

    function onItemChange(event) {
      if (getItemChangeSource(event) !== ITEM_CHANGE_SOURCE.selectedItemsChanged) {
        reload();
        return;
      }
      // SelectedItemsChanged fires the moment the list selection moves,
      // usually before Outlook has pointed mailbox.item at the new email
      // (and ItemChanged follows once it has). Reading right away showed
      // the previous email first and the new one only after ItemChanged's
      // re-read, or an empty "Email context" when the read landed mid-swap.
      // Let the selection settle and re-read only if the open item really
      // changed and no ItemChanged has covered it by then. Re-selecting the
      // open email or a list refresh then costs nothing at all.
      if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = setTimeout(() => {
        selectionTimerRef.current = null;
        if (getLiveItemId() === itemIdRef.current) return;
        reload();
      }, SELECTION_SETTLE_MS);
    }

    document.addEventListener(ITEM_CHANGED_EVENT, onItemChange);
    return () => {
      // `disposed` keeps every load started by this effect run from
      // publishing; a re-run's own loads supersede them via the shared
      // sequence ref.
      disposed = true;
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
      if (selectionTimerRef.current) {
        clearTimeout(selectionTimerRef.current);
        selectionTimerRef.current = null;
      }
      document.removeEventListener(ITEM_CHANGED_EVENT, onItemChange);
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
   * `host.readMessageContext()` call. Honors the "Include body" checkbox in
   * the banner by clearing `bodyText` when the user has opted out.
   */
  const buildSnapshotOverride = useCallback(() => {
    if (!state.ctx) return null;
    const filtered = { ...state.ctx };
    if (!includeBody) {
      filtered.bodyText = null;
    }
    if (removedAttachmentIds.size > 0 && Array.isArray(filtered.attachments)) {
      filtered.attachments = filtered.attachments.filter(a => !removedAttachmentIds.has(a?.id));
    }
    return filtered;
  }, [state.ctx, removedAttachmentIds, includeBody]);

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
    includeBody,
    setIncludeBody,
    generation
  };
}

export default useOutlookMailContextSnapshot;
