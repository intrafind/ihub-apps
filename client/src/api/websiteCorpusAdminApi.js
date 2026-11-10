// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { makeAdminApiCall } from './adminApi';

/**
 * Admin API of the internal websites the Website Corpus may reach
 * (Admin → Integrations → Requests): what users asked for, what an admin
 * approved or declined. Server: `server/routes/admin/websiteCorpusDomains.js`.
 */

const BASE = '/admin/website-corpus/domains';
const json = body => ({ headers: { 'Content-Type': 'application/json' }, body });
const entryPath = id => `${BASE}/${encodeURIComponent(id)}`;

/** `{ items, nextCursor, openCount }`, open requests first. */
export const fetchWebsiteCorpusDomains = async () => (await makeAdminApiCall(BASE)).data;

/** Allow a host without a request (a wildcard such as `*.corp.example` is allowed here). */
export const addWebsiteCorpusDomain = async (host, { note } = {}) =>
  (await makeAdminApiCall(BASE, { method: 'POST', ...json({ host, ...(note ? { note } : {}) }) }))
    .data;

/** Approve a request: the Website Corpus may reach that host. */
export const approveWebsiteCorpusDomain = async (id, { note } = {}) =>
  (
    await makeAdminApiCall(`${entryPath(id)}/_approve`, {
      method: 'POST',
      ...json(note ? { note } : {})
    })
  ).data;

/** Decline a request, or withdraw an approval. */
export const declineWebsiteCorpusDomain = async (id, { note } = {}) =>
  (
    await makeAdminApiCall(`${entryPath(id)}/_decline`, {
      method: 'POST',
      ...json(note ? { note } : {})
    })
  ).data;

/** Remove an entry: an approval is withdrawn, a decision forgotten. */
export const removeWebsiteCorpusDomain = async id => {
  await makeAdminApiCall(entryPath(id), { method: 'DELETE' });
};
