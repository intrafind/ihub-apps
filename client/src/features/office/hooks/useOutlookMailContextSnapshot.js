import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEmbeddedHost } from '../contexts/EmbeddedHostContext';
import { fetchCurrentSelectedText } from '../utilities/outlookMailContext';

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
 *    attachments stripped and `selectedText` freshly re-read (unless the user
 *    toggled selection off) — chat adapter accepts this as
 *    `hostContextOverride` in params, skipping its own `readMessageContext()`
 *    call.
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
  // Per-email opt-out for using the highlighted selection instead of the
  // full body. Defaults to true (prefer the selection whenever one exists)
  // and resets on ItemChanged alongside `includeBody`, mirroring the same
  // per-email lifetime.
  const [useSelection, setUseSelection] = useState(true);
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

    function onItemChange() {
      setRemovedAttachmentIds(new Set());
      setIncludeBody(true);
      setUseSelection(true);
      setGeneration(g => g + 1);
      // Supersede any in-flight load right away and show the loading state,
      // but debounce the actual read: the second event of the double
      // dispatch lands within milliseconds, and the short pause also gives
      // the host time to finish swapping Office.context.mailbox.item.
      loadSeqRef.current++;
      setState({ loading: true, ctx: null });
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = setTimeout(() => {
        reloadTimerRef.current = null;
        load();
      }, 150);
    }

    document.addEventListener('ihub:itemchanged', onItemChange);
    return () => {
      // `disposed` keeps every load started by this effect run from
      // publishing; a re-run's own loads supersede them via the shared
      // sequence ref.
      disposed = true;
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
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
   * `host.readMessageContext()` call. Honors the "Include body" checkbox in
   * the banner by clearing `bodyText` when the user has opted out.
   *
   * Async because the selection is re-read fresh right before send: Office.js
   * has no "selection changed" event, so the snapshot's `selectedText` (last
   * refreshed on ItemChanged) can be stale the moment the user changes their
   * highlight without navigating away. When the user has toggled selection
   * off (`useSelection === false`), `selectedText` is cleared so
   * `combineUserTextWithEmailContext` falls back to the body/includeBody
   * behavior instead.
   */
  const buildSnapshotOverride = useCallback(async () => {
    if (!state.ctx) return null;
    const filtered = { ...state.ctx };
    if (!includeBody) {
      filtered.bodyText = null;
    }
    if (useSelection && filtered.itemKind !== 'appointment') {
      try {
        filtered.selectedText = await fetchCurrentSelectedText();
      } catch {
        filtered.selectedText = null;
      }
    } else {
      filtered.selectedText = null;
    }
    if (removedAttachmentIds.size > 0 && Array.isArray(filtered.attachments)) {
      filtered.attachments = filtered.attachments.filter(a => !removedAttachmentIds.has(a?.id));
    }
    return filtered;
  }, [state.ctx, removedAttachmentIds, includeBody, useSelection]);

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
    useSelection,
    setUseSelection,
    generation
  };
}

export default useOutlookMailContextSnapshot;
