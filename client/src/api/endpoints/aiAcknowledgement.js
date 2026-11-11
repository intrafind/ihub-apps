// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

/**
 * The AI-use notice the caller has to confirm and whether they did. Per user
 * and language, so never cached.
 *
 * @param {Object} [options]
 * @param {string} [options.language]
 */
export const fetchMyAiAcknowledgement = async ({ language } = {}) =>
  handleApiResponse(
    () =>
      apiClient.get('/ai-acknowledgements/me', {
        params: language ? { language } : {},
        // A 401 here (anonymous access is off and nobody is signed in, a public share link for
        // one) only means "nothing to ask": it must not be read as an expired session.
        _suppressAuthExpired: true
      }),
    null,
    null,
    false
  );

/**
 * Confirm the notice the caller was shown.
 *
 * @param {{version: number, textHash: string, language?: string}} body
 */
export const acknowledgeAi = async body =>
  handleApiResponse(() => apiClient.post('/ai-acknowledgements/me', body), null, null, false);
