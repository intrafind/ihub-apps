// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { makeAdminApiCall } from './adminApi';

/** Platform budget across all models and the reset schedule (with the next resets). */
export const fetchUsageLimitSettings = async () =>
  (await makeAdminApiCall('/admin/usage/limits/settings')).data;

/** @param {{allModels: Object, resets: Object}} settings */
export const saveUsageLimitSettings = async settings =>
  (await makeAdminApiCall('/admin/usage/limits/settings', { method: 'PUT', body: settings })).data;

/**
 * One page of users with their buckets.
 *
 * @param {{search?: string, status?: string, modelId?: string, page?: number, pageSize?: number}} query
 */
export const fetchUsageLimitUsers = async (query = {}) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  return (await makeAdminApiCall(`/admin/usage/limits/users?${params}`)).data;
};

/** Per model: global limits, tokens, users near or over their budget. */
export const fetchUsageLimitModels = async () =>
  (await makeAdminApiCall('/admin/usage/limits/models')).data;

/** Per group: limits, members and their tokens. */
export const fetchUsageLimitGroups = async () =>
  (await makeAdminApiCall('/admin/usage/limits/groups')).data;

/** Reset a user's current-window counts (optionally one model / one window). */
export const resetUsageLimitUser = async (userKey, body = {}) =>
  (
    await makeAdminApiCall(`/admin/usage/limits/users/${encodeURIComponent(userKey)}/reset`, {
      method: 'POST',
      body
    })
  ).data;

/** Users at or above `threshold` (default 0.8) of a limit, one row per budget, soonest reset first. */
export const fetchUsageLimitNear = async ({ threshold, limit } = {}) => {
  const params = new URLSearchParams();
  if (threshold != null) params.set('threshold', String(threshold));
  if (limit != null) params.set('limit', String(limit));
  return (await makeAdminApiCall(`/admin/usage/limits/near?${params}`)).data;
};
