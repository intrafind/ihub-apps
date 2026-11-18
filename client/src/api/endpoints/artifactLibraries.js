// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from '../client';

/**
 * Library kit for HTML artifacts (`/api/artifact-libraries`, #3822): the
 * vetted libraries iHub ships, and the source of one, which the client inlines
 * into a preview or a download (`features/chat/utils/artifactLibraryKit.js`).
 * Both are readable without signing in, so a public share's preview works.
 */

/**
 * The kit: `{ enabled, items: [{ id, name, version, global, use, license, homepage, bytes,
 * sha256, available }] }`.
 *
 * @returns {Promise<{ enabled: boolean, items: Array<Object> }>}
 */
export const fetchArtifactLibraries = async () => {
  const response = await apiClient.get('/artifact-libraries');
  return response.data;
};

/**
 * The source of one kit library, as text.
 *
 * @param {string} libraryId - A kit id (`chart.js`, `d3`, `alpinejs`).
 * @returns {Promise<string>}
 */
export const fetchArtifactLibrarySource = async libraryId => {
  const response = await apiClient.get(
    `/artifact-libraries/${encodeURIComponent(libraryId)}/source`,
    // Text as it is: no JSON parsing of a JavaScript file.
    { responseType: 'text', transformResponse: [data => data] }
  );
  return typeof response.data === 'string' ? response.data : String(response.data ?? '');
};
