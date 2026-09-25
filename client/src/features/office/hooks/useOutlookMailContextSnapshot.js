import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEmbeddedHost } from '../contexts/EmbeddedHostContext';
import { traceOffice, shortItemId } from '../utilities/officeLog';

// Outlook dispatches this for both `ItemChanged` (the pinned pane now shows a
// different item) and `SelectedItemsChanged` (the list selection moved, which
// also fires on re-selecting the open email and on list refreshes). See
// client/office/taskpane-entry.jsx.
const ITEM_CHANGED_EVENT = 'ihub:itemchanged';
// A burst of events (a single click fires both of the above) costs one read,
// and the pause gives the host a moment to finish swapping
// Office.context.mailbox.item.
const RELOAD_DEBOUNCE_MS = 150;

/**
 * Maintains a live, user-editable snapshot of the current host mail context
 * (Outlook taskpane: subject + body + attachments; browser extension: page
 * text + selection). Exposed to the chat panel so it can render an
 * `OfficeMailContextBanner` above the input — the user sees what's about
 * to be sent and can drop individual attachments before pressing send.
 *
 * This hook is the ONLY reader of the Outlook item. Everything that needs to
 * know which email is open — the context strip, the token estimate, the pin
 * state, and the chat panel's "start a new chat" decision — reads it from the
 * published snapshot. Earlier versions let the chat panel decide from the
 * synchronous `Office.context.mailbox.item.itemId` at event time instead;
 * that id lags behind the selection, so the two disagreed about which email
 * was open and the pane answered about a different email than it displayed
 * (#2470, #2505, #2509).
 *
 * Behavior:
 *  - Fetches `host.readMessageContext()` on mount and again, debounced,
 *    whenever Outlook fires `ihub:itemchanged`. ItemChanged shows the loading
 *    state and publishes what the read returns. SelectedItemsChanged alone
 *    reads quietly and publishes only when the read found a different email
 *    than the one shown — decided from the read's result, never from the
 *    synchronous `Office.context.mailbox.item.itemId`, so it cannot wedge
 *    the pane on the previous email the way the id gates of #2505/#2509 did.
 *  - Tracks per-message edits: a set of attachment ids the user removed via
 *    the banner, and an email-body opt-out. Both reset when the published
 *    snapshot moves to a different item, so re-selecting the open email or a
 *    list refresh doesn't undo them (#2450). Hosts without Outlook item ids
 *    (browser extension) reset on every read, as before.
 *  - `buildSnapshotOverride()` returns a copy of the live ctx with removed
 *    attachments stripped — chat adapter accepts this as `hostContextOverride`
 *    in params, skipping its own `readMessageContext()` call.
 */
export function useOutlookMailContextSnapshot() {
  const host = useEmbeddedHost();
  const [state, setState] = useState({ loading: true, ctx: null });
  const [removedAttachmentIds, setRemovedAttachmentIds] = useState(() => new Set());
  // Per-email opt-out for the email body. Survives within a single email view
  // but resets when a different email is published, so the user can't
  // accidentally suppress the body of an unrelated email. Replaces the old
  // `hostContextFlags.emailBody` plumbing (issue #1467) — the
  // OfficeMailContextBanner owns this state now and the contextToggles
  // mechanism is no longer used in the Outlook host.
  const [includeBody, setIncludeBody] = useState(true);
  // Bumped when the snapshot moves to a different item so the chat panel can
  // reset its edit state too.
  const [generation, setGeneration] = useState(0);
  // Monotonic sequence for context loads. A single click in Outlook fires
  // both ItemChanged and SelectedItemsChanged (each dispatching
  // 'ihub:itemchanged'), so loads overlap; only the newest one may publish
  // its result. Without this, a slow load that started on the previous
  // email resolves last and clobbers the fresh snapshot with stale
  // attachments ("not part of this item" errors).
  const loadSeqRef = useRef(0);
  const reloadTimerRef = useRef(null);
  // itemId of the snapshot last published (null when it had no item).
  const itemIdRef = useRef(null);
  // Mirrors state.loading for the load callbacks.
  const loadingRef = useRef(true);
  // Whether the pending debounced read was asked for by a visible event.
  const visiblePendingRef = useRef(false);

  const hostKind = host?.kind;

  useEffect(() => {
    let disposed = false;

    function setSnapshot(next) {
      loadingRef.current = next.loading;
      setState(next);
    }

    // `quiet`: read without blanking the strip, and leave the screen alone
    // when the read finds the email already shown.
    async function load({ quiet = false } = {}) {
      const seq = ++loadSeqRef.current;
      if (!quiet) setSnapshot({ loading: true, ctx: null });
      let ctx = null;
      try {
        ctx = await host.readMessageContext();
      } catch {
        ctx = null;
      }
      const itemId = ctx?.itemId ?? null;
      const superseded = disposed || seq !== loadSeqRef.current;
      const unchanged = quiet && !loadingRef.current && itemId && itemId === itemIdRef.current;
      traceOffice(
        superseded ? 'snapshot-dropped' : unchanged ? 'snapshot-unchanged' : 'snapshot-published',
        { seq, quiet, itemId: shortItemId(itemId), subject: ctx?.subject ?? null }
      );
      if (superseded || unchanged) return;

      // Per-email edits belong to one email. No id (browser extension, or a
      // read that found no item) always counts as different, as before.
      if (!itemId || itemId !== itemIdRef.current) {
        setRemovedAttachmentIds(new Set());
        setIncludeBody(true);
        setGeneration(g => g + 1);
      }
      itemIdRef.current = itemId;
      setSnapshot({ loading: false, ctx });
    }

    load();

    function onItemChange(event) {
      // SelectedItemsChanged also fires for re-selecting the open email, list
      // refreshes and, on Outlook for Mac, just before the ItemChanged of a
      // real switch. Blanking the strip for it made every click a double
      // refresh that repainted the old email first, so it only gets a quiet
      // check. ItemChanged (and an event without a source) means the open
      // email changed: supersede any in-flight load and show the loading
      // state right away. Either way the read itself is debounced.
      const quiet = event?.detail?.source === 'SelectedItemsChanged';
      if (!quiet) {
        visiblePendingRef.current = true;
        loadSeqRef.current++;
        setSnapshot({ loading: true, ctx: null });
      }
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = setTimeout(() => {
        reloadTimerRef.current = null;
        const visible = visiblePendingRef.current;
        visiblePendingRef.current = false;
        load({ quiet: !visible });
      }, RELOAD_DEBOUNCE_MS);
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
