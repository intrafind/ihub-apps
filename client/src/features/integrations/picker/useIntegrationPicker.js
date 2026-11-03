// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { consumeConnectResult } from '../connect/connectResult';
import { isRowOn, setRowOn } from './pickerState';

// The API modules are loaded when first needed: the composer imports this
// hook, and a composer that never shows the picker needs no API client.
const loadApi = () => import('../../../api');
const loadConnect = () => import('../connect/integrationInfo');

/** Channel the tab that finished a sign-in tells the other tabs on. */
export const CONNECT_CHANNEL = 'ihub.integrations.connect';

const NO_ROWS = [];

function openChannel() {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CONNECT_CHANNEL) : null;
  } catch {
    return null;
  }
}

/**
 * Open the vendor's consent in a new tab, so the chat stays where it is.
 * The tab is opened in the click (popup blockers allow that) and sent to the
 * vendor once the server answered the URL; it comes back to this chat
 * (`returnUrl` is the current page). Without a new tab (blocked), this tab
 * goes, and comes back to the same chat.
 *
 * @param {string} integrationId
 * @returns {Promise<void>}
 */
export async function connectInNewTab(integrationId) {
  let tab = null;
  try {
    tab = window.open('', '_blank');
  } catch {
    tab = null;
  }
  try {
    const { startIntegrationConnect } = await loadConnect();
    await startIntegrationConnect(integrationId, {
      navigate: url => {
        if (tab && !tab.closed) {
          // The vendor page must not reach back into this one.
          tab.opener = null;
          tab.location.href = url;
        } else {
          window.location.assign(url);
        }
      }
    });
  } catch (error) {
    if (tab && !tab.closed) tab.close();
    throw error;
  }
}

/**
 * The rows of the chat's integrations picker for an app, from the server
 * (`GET /api/integrations/picker`), kept fresh after a sign-in:
 *
 * - this tab came back from a sign-in (`integration_connected=<id>`): the row
 *   of that integration is switched on in this chat, and the other tabs are told;
 * - another tab finished a sign-in, or the user comes back to this tab: the
 *   rows are reloaded, so "Connect →" turns into a switch.
 *
 * @param {Object} params
 * @param {Object} params.app
 * @param {string} [params.language]
 * @param {string[]|null} params.enabledTools - The chat's references
 * @param {((next: string[]) => void)|null} params.onEnabledToolsChange
 * @returns {{rows: Object[], loading: boolean, reload: () => void, connect: (row: Object) => Promise<void>}}
 */
export default function useIntegrationPicker({
  app,
  language,
  enabledTools,
  onEnabledToolsChange
}) {
  const appId = app?.id || null;
  const [answer, setAnswer] = useState({ key: null, rows: NO_ROWS });
  const [generation, setGeneration] = useState(0);
  const key = appId ? `${appId}|${language || ''}` : null;
  const reload = useCallback(() => setGeneration(value => value + 1), []);

  useEffect(() => {
    if (!appId) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(() => loadApi())
      .then(({ fetchIntegrationPicker }) => fetchIntegrationPicker(appId, { language }))
      .then(rows => {
        if (!cancelled) setAnswer({ key, rows: Array.isArray(rows) ? rows : NO_ROWS });
      })
      .catch(() => {
        // No rows rather than a broken composer.
        if (!cancelled) setAnswer({ key, rows: NO_ROWS });
      });
    return () => {
      cancelled = true;
    };
  }, [appId, language, key, generation]);

  const rows = answer.key === key ? answer.rows : NO_ROWS;
  const loading = Boolean(key) && answer.key !== key;

  // Reload when another tab says it finished a sign-in, and when the user
  // comes back to this tab after starting one here.
  const connectPendingRef = useRef(false);
  useEffect(() => {
    if (!appId) return undefined;
    const onBack = () => {
      if (!connectPendingRef.current || document.visibilityState === 'hidden') return;
      connectPendingRef.current = false;
      reload();
    };
    const channel = openChannel();
    if (channel) channel.onmessage = () => reload();
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
      channel?.close();
    };
  }, [appId, reload]);

  // Back from a sign-in in this tab: switch the row on in this chat, once.
  const latestRef = useRef({ enabledTools, onEnabledToolsChange });
  latestRef.current = { enabledTools, onEnabledToolsChange };
  const handledConnectRef = useRef(null);
  useEffect(() => {
    if (loading || rows.length === 0) return;
    const { connected } = consumeConnectResult();
    if (!connected || handledConnectRef.current === connected) return;
    handledConnectRef.current = connected;
    const channel = openChannel();
    channel?.postMessage({ connected });
    channel?.close();
    const row = rows.find(candidate => candidate.integration === connected);
    const { enabledTools: current, onEnabledToolsChange: change } = latestRef.current;
    if (row && change && Array.isArray(current) && !isRowOn(row, current)) {
      change(setRowOn(rows, current, row.id, true));
    }
  }, [rows, loading]);

  const connect = useCallback(
    async row => {
      if (!row?.integration) return;
      // On in this chat right away: once the user is back, the next turn uses it.
      const { enabledTools: current, onEnabledToolsChange: change } = latestRef.current;
      if (change && Array.isArray(current) && !isRowOn(row, current)) {
        change(setRowOn(rows, current, row.id, true));
      }
      connectPendingRef.current = true;
      await connectInNewTab(row.integration);
    },
    [rows]
  );

  return { rows, loading, reload, connect };
}
