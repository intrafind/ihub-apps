import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEmbeddedHost } from '../contexts/EmbeddedHostContext';
import { getLiveItemId } from '../utilities/outlookMailContext';
import {
  ITEM_CHANGED_EVENT,
  ITEM_CHANGE_SOURCE,
  getItemChangeSource,
  isDifferentItem
} from '../utilities/officeItemChange';

// Debounce for the read that follows an `ihub:itemchanged` event: a burst of
// events costs one read, and the pause gives the host a moment to finish
// swapping Office.context.mailbox.item.
const RELOAD_DEBOUNCE_MS = 150;
// Pause before the one verification read that follows a read whose result
// looks stale (see `isUnconfirmed`). Outlook reports a selection change
// before it opens the new email, and right after ItemChanged the item it
// serves can still carry the previous email's cached fields, so a read
// landing in that window returns the old email or nothing at all.
const VERIFY_DELAY_MS = 400;
// How many verification reads may follow one event. A read downloads the
// attachments, so this stays small: the settled read of a genuinely
// different email needs none, and a re-selection of the open email or a
// list refresh costs one background read.
const MAX_VERIFY_READS = 1;

/**
 * Maintains a live, user-editable snapshot of the current host mail context
 * (Outlook taskpane: subject + body + attachments; browser extension: page
 * text + selection). Exposed to the chat panel so it can render an
 * `OfficeMailContextBanner` above the input — the user sees what's about
 * to be sent and can drop individual attachments before pressing send.
 *
 * Behavior:
 *  - Fetches `host.readMessageContext()` on mount and again whenever Outlook
 *    fires `ihub:itemchanged`. ItemChanged shows the loading state first;
 *    SelectedItemsChanged reads in the background and only publishes when
 *    the read really returned a different item, so re-selecting the open
 *    email or a list refresh changes nothing on screen.
 *  - Which item is shown is decided by what the read returned, never by the
 *    synchronous `Office.context.mailbox.item.itemId` at event time: that id
 *    can lag behind the selection (it is what made the pane stick to the
 *    previous email). A read that still returned the previous item, or no
 *    item, is followed by one verification read after a short pause.
 *  - Tracks per-message edits: a set of attachment ids the user removed via
 *    the banner. The set resets when the snapshot moves to a different item.
 *  - `buildSnapshotOverride()` returns a copy of the live ctx with removed
 *    attachments stripped — chat adapter accepts this as `hostContextOverride`
 *    in params, skipping its own `readMessageContext()` call.
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
  // The one pending timer: the debounced read after an event, or the
  // verification read after a read that looked stale.
  const timerRef = useRef(null);
  // itemId the per-email edits above belong to.
  const itemIdRef = useRef(getLiveItemId());
  // itemId of the snapshot last published (null when it had no item).
  const publishedItemIdRef = useRef(null);

  const hostKind = host?.kind;

  useEffect(() => {
    let disposed = false;

    function clearTimer() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function schedule(fn, delay) {
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        fn();
      }, delay);
    }

    function publish(ctx) {
      const itemId = ctx?.itemId ?? null;
      // Edits belong to one email. `isDifferentItem` also resets for hosts
      // without item ids (browser extension), as before.
      if (isDifferentItem({ liveItemId: itemId, lastItemId: itemIdRef.current })) {
        setRemovedAttachmentIds(new Set());
        setIncludeBody(true);
        setGeneration(g => g + 1);
      }
      itemIdRef.current = itemId;
      publishedItemIdRef.current = itemId;
      setState({ loading: false, ctx });
    }

    /**
     * A read after an item-change event is unconfirmed when it cannot have
     * been the new email: it returned the item that was already on screen
     * before the event, or no item at all (the host mid-swap). Both are what
     * a read landing before Outlook finished switching looks like.
     */
    function isUnconfirmed(ctx, previousItemId) {
      if (!ctx || ctx.available === false) return true;
      const itemId = ctx.itemId ?? null;
      return itemId != null && itemId === previousItemId;
    }

    /**
     * @param {object} [opts]
     * @param {string|null} [opts.source] - Outlook event that caused the read;
     *   null for the mount read.
     * @param {number} [opts.verifyBudget] - Verification reads still allowed.
     */
    async function load({ source = null, verifyBudget = 0 } = {}) {
      const seq = ++loadSeqRef.current;
      const previousItemId = publishedItemIdRef.current;
      const isSelection = source === ITEM_CHANGE_SOURCE.selectedItemsChanged;
      if (!isSelection) setState({ loading: true, ctx: null });
      let ctx = null;
      try {
        ctx = await host.readMessageContext();
      } catch {
        ctx = null;
      }
      if (disposed || seq !== loadSeqRef.current) return;

      const unconfirmed = source != null && isUnconfirmed(ctx, previousItemId);
      if (unconfirmed && verifyBudget > 0) {
        // Keep what is on screen (or the loading state) and look again once
        // the host has had time to settle; a newer event supersedes this.
        schedule(() => load({ source, verifyBudget: verifyBudget - 1 }), VERIFY_DELAY_MS);
        return;
      }
      // A selection event that ends on the email already shown changes
      // nothing: don't churn the snapshot (and the token estimate) for it.
      // The strip was not blanked, so there is nothing to restore either.
      if (
        isSelection &&
        ctx &&
        ctx.available !== false &&
        (ctx.itemId ?? null) === previousItemId
      ) {
        return;
      }
      publish(ctx);
    }

    load();

    function onItemChange(event) {
      const source = getItemChangeSource(event);
      // Supersede any in-flight read right away. ItemChanged is Outlook's
      // word that the pane shows a different item, so show the loading
      // state; SelectedItemsChanged also fires for re-selecting the open
      // email, multi-select and list refreshes, so it reads in the
      // background and the strip keeps the current email until the read
      // proves the item changed.
      loadSeqRef.current++;
      if (source !== ITEM_CHANGE_SOURCE.selectedItemsChanged) {
        // Reset the edits as early as the live id lets us; `publish` covers
        // the case where that id still lags behind the selection.
        const liveItemId = getLiveItemId();
        if (isDifferentItem({ liveItemId, lastItemId: itemIdRef.current })) {
          setRemovedAttachmentIds(new Set());
          setIncludeBody(true);
          setGeneration(g => g + 1);
        }
        itemIdRef.current = liveItemId;
        setState({ loading: true, ctx: null });
      }
      schedule(() => load({ source, verifyBudget: MAX_VERIFY_READS }), RELOAD_DEBOUNCE_MS);
    }

    document.addEventListener(ITEM_CHANGED_EVENT, onItemChange);
    return () => {
      // `disposed` keeps every load started by this effect run from
      // publishing; a re-run's own loads supersede them via the shared
      // sequence ref.
      disposed = true;
      clearTimer();
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
