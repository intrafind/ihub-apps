import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../../../api/client';

/**
 * Polls `/api/integrations/nextcloud/status` to decide whether the current
 * iHub user has already OAuth-linked their Nextcloud account. The
 * embedded UI uses `connected === false` to render a "Connect Nextcloud"
 * CTA before attempting any document fetch.
 *
 * Unlike `useNextcloudBrowser` (which does the full picker flow), this
 * hook only owns the connect state — it never lists files. The actual
 * file fetch happens later through `fetchCurrentDocumentContext`.
 *
 * @param {{ providerId?: string }} options
 * @param {string} [options.providerId] Provider id forwarded into the
 *   OAuth start URL when the user clicks "Connect Nextcloud". When omitted,
 *   the hook still surfaces the connect status but cannot start the flow.
 */
export function useNextcloudConnection({ providerId } = {}) {
  const [status, setStatus] = useState('checking'); // 'checking' | 'connected' | 'not_connected' | 'error'
  const [error, setError] = useState(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    setStatus('checking');
    setError(null);
    try {
      const response = await apiClient.get('/integrations/nextcloud/status');
      if (!mounted.current) return;
      setStatus(response.data?.connected ? 'connected' : 'not_connected');
    } catch (err) {
      if (!mounted.current) return;
      if (err?.response?.status === 401) {
        setStatus('not_connected');
      } else {
        setStatus('error');
        setError(err.message || 'Failed to check Nextcloud connection');
      }
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Start the Nextcloud OAuth flow. iHub redirects to Nextcloud's
   * authorize endpoint, then back to `/api/integrations/nextcloud/<providerId>/callback`
   * which writes the encrypted refresh token via TokenStorageService. We
   * pass the *current* window location as `returnUrl` so the user lands
   * back in the embed when the flow completes — same behaviour as the
   * settings page.
   */
  const link = useCallback(() => {
    if (!providerId) {
      setError('No Nextcloud providerId configured for this embed.');
      return;
    }
    // Use the *full* current URL so the OAuth dance returns to the embed
    // with the same hash selection intact. The server validates this
    // against the request's hostname (`isValidReturnUrl`).
    const returnUrl = window.location.pathname + window.location.search + window.location.hash;
    const authUrl = `/api/integrations/nextcloud/auth?providerId=${encodeURIComponent(
      providerId
    )}&returnUrl=${encodeURIComponent(returnUrl)}`;
    // Hard navigation, not popup — the Nextcloud OAuth pages reject
    // being iframed and the existing flow already top-level navigates
    // from the settings page.
    window.location.assign(authUrl);
  }, [providerId]);

  return {
    status,
    connected: status === 'connected',
    error,
    refresh,
    link
  };
}
