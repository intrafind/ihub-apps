// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { fetchIntegrationRequests } from '../../../api/integrationsAdminApi';

/**
 * Window event the Requests tab sends after it (re)loaded the queue, with
 * `detail.openCount`, so the sidebar badge follows without a second request.
 */
export const INTEGRATION_REQUESTS_EVENT = 'admin:integration-requests-changed';

/** Tell the sidebar how many requests are open now. */
export function announceIntegrationRequestCount(openCount) {
  window.dispatchEvent(new CustomEvent(INTEGRATION_REQUESTS_EVENT, { detail: { openCount } }));
}

/**
 * The number of open integration requests, for the admin sidebar's badge
 * (#2926). Read once when the admin layout mounts and kept current by
 * {@link INTEGRATION_REQUESTS_EVENT}. Zero when the queue cannot be read.
 *
 * @param {boolean} enabled - Only full admins can read the queue
 * @returns {number}
 */
export default function useIntegrationRequestCount(enabled) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    fetchIntegrationRequests()
      .then(data => {
        if (!cancelled) setCount(Number(data?.openCount) || 0);
      })
      .catch(() => {});
    const onChange = event => setCount(Number(event.detail?.openCount) || 0);
    window.addEventListener(INTEGRATION_REQUESTS_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(INTEGRATION_REQUESTS_EVENT, onChange);
    };
  }, [enabled]);

  return enabled ? count : 0;
}
