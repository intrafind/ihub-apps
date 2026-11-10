// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { fetchIntegrationRequests } from '../../../api/integrationsAdminApi';
import { fetchWebsiteCorpusDomains } from '../../../api/websiteCorpusAdminApi';

/**
 * Window event the Requests tab sends after it (re)loaded the queue, with
 * `detail.openCount`, so the sidebar badge follows without a second request.
 */
export const INTEGRATION_REQUESTS_EVENT = 'admin:integration-requests-changed';

/** Tell the sidebar how many requests are open now. */
export function announceIntegrationRequestCount(openCount) {
  window.dispatchEvent(new CustomEvent(INTEGRATION_REQUESTS_EVENT, { detail: { openCount } }));
}

/** Window event the Website Corpus panel sends after it (re)loaded its requests, with `detail.openCount`. */
export const WEBSITE_CORPUS_DOMAINS_EVENT = 'admin:website-corpus-domains-changed';

/** Tell the sidebar how many requests for internal websites are open now. */
export function announceWebsiteCorpusDomainCount(openCount) {
  window.dispatchEvent(new CustomEvent(WEBSITE_CORPUS_DOMAINS_EVENT, { detail: { openCount } }));
}

/**
 * The number of open requests an admin has to decide, for the admin sidebar's
 * badge (#2926): integration requests plus requests for internal websites of
 * the Website Corpus. Read once when the admin layout mounts and kept current
 * by {@link INTEGRATION_REQUESTS_EVENT} and {@link WEBSITE_CORPUS_DOMAINS_EVENT}.
 * Zero when a queue cannot be read.
 *
 * @param {boolean} enabled - Only full admins can read the queues
 * @returns {number}
 */
export default function useIntegrationRequestCount(enabled) {
  const [integrations, setIntegrations] = useState(0);
  const [websites, setWebsites] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    fetchIntegrationRequests()
      .then(data => {
        if (!cancelled) setIntegrations(Number(data?.openCount) || 0);
      })
      .catch(() => {});
    fetchWebsiteCorpusDomains()
      .then(data => {
        if (!cancelled) setWebsites(Number(data?.openCount) || 0);
      })
      .catch(() => {});
    const onIntegrations = event => setIntegrations(Number(event.detail?.openCount) || 0);
    const onWebsites = event => setWebsites(Number(event.detail?.openCount) || 0);
    window.addEventListener(INTEGRATION_REQUESTS_EVENT, onIntegrations);
    window.addEventListener(WEBSITE_CORPUS_DOMAINS_EVENT, onWebsites);
    return () => {
      cancelled = true;
      window.removeEventListener(INTEGRATION_REQUESTS_EVENT, onIntegrations);
      window.removeEventListener(WEBSITE_CORPUS_DOMAINS_EVENT, onWebsites);
    };
  }, [enabled]);

  return enabled ? integrations + websites : 0;
}
