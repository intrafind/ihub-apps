// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { acknowledgeAi, fetchMyAiAcknowledgement } from '../../api';
import AiAcknowledgementDialog from '../../features/chat/components/AiAcknowledgementDialog';
import { openExternalUrl } from '../../utils/externalNavigation';
import AiAcknowledgementContext from './aiAcknowledgementContextValue';
import { useOptionalAuth } from './authContextValue';
import { useUIConfig } from './UIConfigContext';

const DISCLAIMER_STORAGE_KEY = 'ihub-disclaimer-acknowledged';
const DISCLAIMER_CLOSED_EVENT = 'ihub-disclaimer-closed';
const DISMISSED_KEY = 'ihub-ai-ack-dismissed';
const CHANNEL_NAME = 'ihub-ai-ack';

function readSession(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key, value) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* sessionStorage can be blocked */
  }
}

function disclaimerPending(uiConfig) {
  if (!uiConfig?.disclaimer || uiConfig.disclaimer.enabled === false) return false;
  try {
    return !window.localStorage.getItem(DISCLAIMER_STORAGE_KEY);
  } catch {
    return false;
  }
}

/** Whether the viewer has to see the dialog for this state of `GET /me`. */
function needsDialog(current) {
  if (!current || !current.enabled || current.acknowledged) return false;
  if (current.enforce) return true;
  return readSession(DISMISSED_KEY) !== '1';
}

/**
 * Single host of the AI-use acknowledgement (#3326, EU AI Act).
 *
 * Two triggers feed one dialog, so every surface behaves the same:
 * - proactive: a sender awaits `ensureAcknowledged()` before it sends anything;
 * - reactive: the API answered `428 AI_ACKNOWLEDGEMENT_REQUIRED` (stale tab, the
 *   admin asked again while the page was open) and the sender calls
 *   `handleAcknowledgementRequired()`.
 * Both resolve to whether the user may go on. The server stays the source of
 * truth; this state is only an optimisation.
 *
 * The dialog queues behind the legacy `DisclaimerPopup`: never two modals.
 *
 * Embedded hosts (the Outlook pane, the browser extension's side panel) mount
 * this without the web app's `AuthProvider`, so what the web app derives from
 * it can be passed in:
 *
 * @param {Object} props
 * @param {boolean} [props.active=true] - `false` while nobody is signed in: no
 *   request is made (a 401 there would read as an expired session).
 * @param {string} [props.viewerKey] - Identity of the signed-in viewer; a change
 *   re-reads the state. Defaults to what `AuthProvider` says.
 * @param {boolean} [props.anonymous] - Whether the viewer is a guest. Defaults to
 *   what `AuthProvider` says.
 * @param {'indigo'|'slate'} [props.tone] - Look of the dialog.
 * @param {boolean} [props.compact] - Narrow host (task pane, short frame).
 * @param {(url: string) => Promise<boolean>|boolean} [props.openPolicy] - How the
 *   host opens the policy link; `false` shows the address to copy instead.
 * @param {boolean} [props.showPolicyAddress] - Always show the address as well.
 * @param {string} [props.appUrl] - Where "Open iHub in the browser" goes.
 */
export function AiAcknowledgementProvider({
  children,
  active = true,
  viewerKey: viewerKeyOverride,
  anonymous: anonymousOverride,
  tone = 'indigo',
  compact = false,
  openPolicy,
  showPolicyAddress = false,
  appUrl
}) {
  const { i18n } = useTranslation();
  const auth = useOptionalAuth();
  const { uiConfig } = useUIConfig() || {};
  const language = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];
  const viewerKey =
    viewerKeyOverride ??
    (auth ? `${auth.isAuthenticated ? 'auth' : 'anon'}:${auth.user?.id ?? ''}` : '');
  const loading = auth?.isLoading === true;

  const [state, setState] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState(false);
  // "AI-use notice" opened later, after confirming: text and a Close button.
  const [readOnly, setReadOnly] = useState(false);
  const [hasMessage, setHasMessage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(false);
  // A guest's confirmation did not stick: the frame drops the cookie.
  const [cookieBlocked, setCookieBlocked] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  // The user closed the dialog without confirming: the composer shows a note.
  const [declined, setDeclined] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(() => disclaimerPending(uiConfig));
  const waitersRef = useRef([]);
  const stateRef = useRef(null);
  stateRef.current = state;
  const openRef = useRef(false);
  openRef.current = open;
  // The read-only notice is not waiting on a confirmation: nothing closes it silently.
  const readOnlyRef = useRef(false);
  readOnlyRef.current = readOnly;
  const channelRef = useRef(null);
  const anonymous = anonymousOverride ?? !auth?.isAuthenticated;

  // The disclaimer is global and shown on page load: the acknowledgement waits for it.
  useEffect(() => {
    setDisclaimerOpen(disclaimerPending(uiConfig));
    const onClosed = () => setDisclaimerOpen(false);
    window.addEventListener(DISCLAIMER_CLOSED_EVENT, onClosed);
    return () => window.removeEventListener(DISCLAIMER_CLOSED_EVENT, onClosed);
  }, [uiConfig]);

  const load = useCallback(async () => {
    if (!active) return null;
    try {
      const data = await fetchMyAiAcknowledgement({ language });
      setState(data);
      setLoadFailed(false);
      return data;
    } catch {
      // Without the state the client does not gate; the server still enforces (428),
      // and the dialog then says the notice could not be loaded.
      setLoadFailed(true);
      return null;
    }
  }, [active, language]);

  useEffect(() => {
    if (!active) {
      setState(null);
      setLoadFailed(false);
      setDeclined(false);
      return;
    }
    if (loading) return;
    void load();
  }, [active, load, loading, viewerKey]);

  const settle = useCallback(result => {
    const pending = waitersRef.current;
    waitersRef.current = [];
    pending.forEach(resolve => resolve(result));
  }, []);

  const closeDialog = useCallback(
    result => {
      setOpen(false);
      setReadOnly(false);
      setError(null);
      setStale(false);
      setCookieBlocked(false);
      setDeclined(!result);
      settle(result);
    },
    [settle]
  );

  // The feature was switched off, or this user confirmed elsewhere, while the dialog was open:
  // nothing is left to ask, and the waiting sends must not stay blocked. The read-only
  // review of an already confirmed notice stays open until the user closes it.
  useEffect(() => {
    if (open && !readOnly && state && (!state.enabled || state.acknowledged)) closeDialog(true);
  }, [open, readOnly, state, closeDialog]);

  // Another tab confirmed: take it over silently and let the waiting sender go on.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    channel.onmessage = async () => {
      const data = await load();
      if (data?.acknowledged && !readOnlyRef.current) closeDialog(true);
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [load, closeDialog]);

  // Another client (the web app, Teams, the extension) confirmed meanwhile: the
  // pane or frame regaining focus picks it up, so the user is not asked twice.
  // BroadcastChannel only reaches same-origin tabs; an Outlook pane, a pop-out
  // dialog and the extension are different origins.
  useEffect(() => {
    if (!active) return undefined;
    const recheck = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const current = stateRef.current;
      // A dialog that waits for a confirmation; the read-only notice does not.
      const waiting = openRef.current && !readOnlyRef.current;
      if (current && !waiting && !needsDialog(current)) return;
      const data = await load();
      if (waiting && data && !needsDialog(data)) closeDialog(true);
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [active, load, closeDialog]);

  const openDialog = useCallback(withMessage => {
    setHasMessage(Boolean(withMessage));
    setReadOnly(false);
    setOpen(true);
    return new Promise(resolve => {
      waitersRef.current.push(resolve);
    });
  }, []);

  const ensureAcknowledged = useCallback(
    async ({ hasPendingMessage = false, onAsk } = {}) => {
      if (!active) return true;
      let current = stateRef.current;
      if (!current) {
        // Never loaded, or the load failed: try once more. Still nothing: the
        // server decides (a 428 then opens the dialog's "could not load" state).
        current = await load();
        if (!current) return true;
      } else if (needsDialog(current)) {
        // Another client may have confirmed since this state was read.
        current = (await load()) ?? current;
      }
      if (!needsDialog(current)) return true;
      // The sender learns that the user is being asked: the host may have moved on
      // (another email, another tab) while the dialog was open.
      onAsk?.();
      return openDialog(hasPendingMessage);
    },
    [active, load, openDialog]
  );

  const handleAcknowledgementRequired = useCallback(async () => {
    // The server says it is needed, whatever this tab believed.
    const data = await load();
    if (data && data.enabled && data.acknowledged) return true;
    if (data && !data.enabled) return true; // switched off meanwhile
    // Nothing to show: settle the waiting send as declined instead of opening a dialog
    // that cannot render. It renders with a notice, or, when none was ever loaded and
    // the load just failed, as the "could not load" state with Try again.
    const canRender = Boolean(stateRef.current?.enabled) || (!stateRef.current && active);
    if (!data && !canRender) return false;
    setState(prev => (prev ? { ...prev, acknowledged: false } : prev));
    return openDialog(true);
  }, [active, load, openDialog]);

  /**
   * Run a request that starts an LLM turn (a workflow, say) behind the gate:
   * confirm first, and when the server still answers 428 confirm and run it once
   * more. Without a gate to ask, `fn` simply runs.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T|undefined>} undefined when the user declined
   */
  const runWithAcknowledgement = useCallback(
    async fn => {
      if (!(await ensureAcknowledged({ hasPendingMessage: true }))) return undefined;
      try {
        return await fn();
      } catch (err) {
        // The API's code first: Axios sets its own `code` (ERR_BAD_REQUEST) on an HTTP 428.
        const code = err?.response?.data?.code || err?.code;
        if (code !== 'AI_ACKNOWLEDGEMENT_REQUIRED') throw err;
        if (!(await handleAcknowledgementRequired())) return undefined;
        return await fn();
      }
    },
    [ensureAcknowledged, handleAcknowledgementRequired]
  );

  const confirm = useCallback(async () => {
    const current = stateRef.current;
    if (!current) return;
    setSubmitting(true);
    setError(null);
    try {
      await acknowledgeAi({
        version: current.requiredVersion,
        textHash: current.textHash,
        language: current.language
      });
      if (anonymous && current.enforce) {
        // A guest's proof is a cookie. A frame of another site drops it: the
        // confirmation then would not count at the next send.
        const fresh = await load();
        if (fresh?.enabled && !fresh.acknowledged) {
          setCookieBlocked(true);
          return;
        }
      }
      setState({ ...current, acknowledged: true });
      try {
        channelRef.current?.postMessage('acknowledged');
      } catch {
        /* the channel is closed */
      }
      setAnnouncement(
        i18n.t('aiAcknowledgement.confirmed', 'Confirmed.') +
          (hasMessage ? ' ' + i18n.t('aiAcknowledgement.sending', 'Sending your message.') : '')
      );
      closeDialog(true);
    } catch (err) {
      if (err?.status === 409 || err?.code === 'CONFLICT') {
        // The text or the version changed while the dialog was open.
        await load();
        setStale(true);
      } else if (err?.isAuthRequired || err?.status === 401) {
        closeDialog(false);
      } else {
        setError(true);
      }
    } finally {
      setSubmitting(false);
    }
  }, [anonymous, closeDialog, hasMessage, i18n, load]);

  const cancel = useCallback(() => {
    if (submitting) return;
    if (readOnly) {
      // Reading the notice again is not a refusal: no note, nothing pending.
      setOpen(false);
      setReadOnly(false);
      settle(true);
      return;
    }
    closeDialog(false);
  }, [closeDialog, readOnly, settle, submitting]);

  const skip = useCallback(() => {
    writeSession(DISMISSED_KEY, '1');
    closeDialog(true);
  }, [closeDialog]);

  const retryLoad = useCallback(async () => {
    const data = await load();
    if (data && !needsDialog(data)) closeDialog(true);
  }, [closeDialog, load]);

  const openInBrowser = useCallback(() => {
    // The server knows the public address (base path, forwarded host) of iHub.
    const url = appUrl || stateRef.current?.appUrl || window.location.origin;
    openExternalUrl(url);
  }, [appUrl]);

  // Reopen the notice later: to confirm while one is pending, else to read it.
  const review = useCallback(async () => {
    const data = (await load()) ?? stateRef.current;
    if (data?.enabled && data.acknowledged) {
      setReadOnly(true);
      setOpen(true);
      return true;
    }
    return openDialog(false);
  }, [load, openDialog]);

  const value = useMemo(
    () => ({
      state,
      // The feature is on: a host shows its "AI-use notice" entry only then.
      available: Boolean(state?.enabled),
      pending: Boolean(state?.enabled && !state?.acknowledged && state?.enforce),
      loadFailed,
      declined,
      runWithAcknowledgement,
      ensureAcknowledged,
      handleAcknowledgementRequired,
      review
    }),
    [
      state,
      loadFailed,
      declined,
      runWithAcknowledgement,
      ensureAcknowledged,
      handleAcknowledgementRequired,
      review
    ]
  );

  return (
    <AiAcknowledgementContext.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <AiAcknowledgementDialog
        isOpen={open && !disclaimerOpen && (Boolean(state?.enabled) || (loadFailed && !state))}
        notice={state?.enabled ? state : null}
        enforce={state?.enforce !== false}
        hasPendingMessage={hasMessage}
        submitting={submitting}
        error={error}
        stale={stale}
        anonymous={anonymous}
        loadFailed={loadFailed}
        cookieBlocked={cookieBlocked}
        readOnly={readOnly}
        tone={tone}
        compact={compact}
        openPolicy={openPolicy}
        showPolicyAddress={showPolicyAddress}
        onConfirm={confirm}
        onCancel={cancel}
        onSkip={skip}
        onRetryLoad={retryLoad}
        onOpenInBrowser={openInBrowser}
      />
    </AiAcknowledgementContext.Provider>
  );
}
