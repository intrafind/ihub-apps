// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { acknowledgeAi, fetchMyAiAcknowledgement } from '../../api';
import AiAcknowledgementDialog from '../../features/chat/components/AiAcknowledgementDialog';
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
 */
export function AiAcknowledgementProvider({ children }) {
  const { i18n } = useTranslation();
  const auth = useOptionalAuth();
  const { uiConfig } = useUIConfig() || {};
  const language = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];
  const viewerKey = auth ? `${auth.isAuthenticated ? 'auth' : 'anon'}:${auth.user?.id ?? ''}` : '';
  const loading = auth?.isLoading === true;

  const [state, setState] = useState(null);
  const [open, setOpen] = useState(false);
  const [hasMessage, setHasMessage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  // The user closed the dialog without confirming: the composer shows a note.
  const [declined, setDeclined] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(() => disclaimerPending(uiConfig));
  const waitersRef = useRef([]);
  const stateRef = useRef(null);
  stateRef.current = state;
  const channelRef = useRef(null);

  // The disclaimer is global and shown on page load: the acknowledgement waits for it.
  useEffect(() => {
    setDisclaimerOpen(disclaimerPending(uiConfig));
    const onClosed = () => setDisclaimerOpen(false);
    window.addEventListener(DISCLAIMER_CLOSED_EVENT, onClosed);
    return () => window.removeEventListener(DISCLAIMER_CLOSED_EVENT, onClosed);
  }, [uiConfig]);

  const load = useCallback(async () => {
    try {
      const data = await fetchMyAiAcknowledgement({ language });
      setState(data);
      return data;
    } catch {
      // Without the state the client does not gate; the server still enforces (428).
      return null;
    }
  }, [language]);

  useEffect(() => {
    if (loading) return;
    void load();
  }, [load, loading, viewerKey]);

  const settle = useCallback(result => {
    const pending = waitersRef.current;
    waitersRef.current = [];
    pending.forEach(resolve => resolve(result));
  }, []);

  const closeDialog = useCallback(
    result => {
      setOpen(false);
      setError(null);
      setStale(false);
      setDeclined(!result);
      settle(result);
    },
    [settle]
  );

  // The feature was switched off, or this user confirmed elsewhere, while the dialog was open:
  // nothing is left to ask, and the waiting sends must not stay blocked.
  useEffect(() => {
    if (open && state && (!state.enabled || state.acknowledged)) closeDialog(true);
  }, [open, state, closeDialog]);

  // Another tab confirmed: take it over silently and let the waiting sender go on.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    channel.onmessage = async () => {
      const data = await load();
      if (data?.acknowledged) closeDialog(true);
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [load, closeDialog]);

  const needsDialog = current => {
    if (!current || !current.enabled || current.acknowledged) return false;
    if (current.enforce) return true;
    return readSession(DISMISSED_KEY) !== '1';
  };

  const openDialog = useCallback(withMessage => {
    setHasMessage(Boolean(withMessage));
    setOpen(true);
    return new Promise(resolve => {
      waitersRef.current.push(resolve);
    });
  }, []);

  const ensureAcknowledged = useCallback(
    ({ hasPendingMessage = false } = {}) => {
      if (!needsDialog(stateRef.current)) return Promise.resolve(true);
      return openDialog(hasPendingMessage);
    },
    [openDialog]
  );

  const handleAcknowledgementRequired = useCallback(async () => {
    // The server says it is needed, whatever this tab believed.
    const data = await load();
    if (data && data.enabled && data.acknowledged) return true;
    // Without the notice there is nothing to show: settle the waiting send as declined
    // instead of opening a dialog that cannot render.
    if (data && !data.enabled) return true; // switched off meanwhile
    if (!data && !stateRef.current?.enabled) return false;
    setState(prev => (prev ? { ...prev, acknowledged: false } : prev));
    return openDialog(true);
  }, [load, openDialog]);

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
  }, [closeDialog, hasMessage, i18n, load]);

  const cancel = useCallback(() => {
    if (submitting) return;
    closeDialog(false);
  }, [closeDialog, submitting]);

  const skip = useCallback(() => {
    writeSession(DISMISSED_KEY, '1');
    closeDialog(true);
  }, [closeDialog]);

  // Switching to the viewer's other language changes the text on screen: refetch it.
  const value = useMemo(
    () => ({
      state,
      pending: Boolean(state?.enabled && !state?.acknowledged && state?.enforce),
      declined,
      runWithAcknowledgement,
      ensureAcknowledged,
      handleAcknowledgementRequired,
      review: () => openDialog(false)
    }),
    [
      state,
      declined,
      runWithAcknowledgement,
      ensureAcknowledged,
      handleAcknowledgementRequired,
      openDialog
    ]
  );

  const anonymous = !auth?.isAuthenticated;

  return (
    <AiAcknowledgementContext.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <AiAcknowledgementDialog
        isOpen={open && !disclaimerOpen && Boolean(state?.enabled)}
        notice={state}
        enforce={state?.enforce !== false}
        hasPendingMessage={hasMessage}
        submitting={submitting}
        error={error}
        stale={stale}
        anonymous={anonymous}
        onConfirm={confirm}
        onCancel={cancel}
        onSkip={skip}
      />
    </AiAcknowledgementContext.Provider>
  );
}
