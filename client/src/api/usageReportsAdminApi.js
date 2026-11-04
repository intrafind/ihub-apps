// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { makeAdminApiCall } from './adminApi';

/**
 * Admin usage reports: every call takes the same range params —
 * `{ range: 'today'|'24h'|'7d'|'30d'|'90d'|'12m'|'custom', from?, to? }`
 * (`from`/`to` as `YYYY-MM-DD`, inclusive, for custom).
 */
function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

/** KPIs vs the previous period, the series, top models and apps. */
export const fetchUsageSummary = async params =>
  (await makeAdminApiCall(`/admin/usage/summary?${query(params)}`)).data;

/** Rows per `dimension` (user|group|app|model|provider|surface) with per-model sub-rows. */
export const fetchUsageBreakdown = async params =>
  (await makeAdminApiCall(`/admin/usage/breakdown?${query(params)}`)).data;

/** Error rate over time, errors by code and provider, latency per model. */
export const fetchUsageReliability = async params =>
  (await makeAdminApiCall(`/admin/usage/reliability?${query(params)}`)).data;

/** Feedback ratings in total and per user, app and model. */
export const fetchUsageFeedbackSummary = async params =>
  (await makeAdminApiCall(`/admin/usage/feedback/summary?${query(params)}`)).data;

/** One page of call records, newest first (`cursor` from the previous page). */
export const fetchUsageCalls = async params =>
  (await makeAdminApiCall(`/admin/usage/calls?${query(params)}`)).data;

/**
 * Download the raw records of a range (`format`: csv|json) as a file.
 * Fetched through the admin client so token-based admin sessions work too.
 */
export async function downloadUsageExport(params, format = 'csv') {
  const response = await makeAdminApiCall(`/admin/usage/export?${query({ ...params, format })}`, {
    responseType: 'blob'
  });
  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = `usage-export-${params?.range || 'range'}.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
