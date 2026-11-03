// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

/**
 * The caller's usage limits: token buckets per model and across all models
 * with what is used and when each resets, this month's usage per model and
 * app, and file storage. Never cached — it changes with every answer.
 *
 * @param {Object} [options]
 * @param {string} [options.language]
 */
export const fetchMyUsage = async ({ language } = {}) =>
  handleApiResponse(
    () => apiClient.get('/usage/me', { params: language ? { lang: language } : {} }),
    null,
    null,
    false
  );
