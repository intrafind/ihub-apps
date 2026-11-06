// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from '../client';
import { buildSourceParams } from './sources';

// Documents can be large and the integration may resolve the real download link
// before streaming, so give the content call more room than the 30s default.
const CONTENT_REQUEST_TIMEOUT = 120000;

const base = integration => `/integrations/${encodeURIComponent(integration || '')}/files`;

/**
 * Whether an installed integration can hand over documents to the signed-in
 * user: `GET /api/integrations/:id/files`. Rejects with the gate's answer
 * (`404 INTEGRATION_NOT_FOUND | INTEGRATION_NOT_CONFIGURED`, `403 INTEGRATION_NOT_GRANTED`).
 *
 * @param {Object} options
 * @param {string} options.integration - installation id
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{id: string, definition: string, type: string|null, name: Object|string}>}
 */
export const fetchIntegrationFilesProbe = async ({ integration, signal } = {}) => {
  const response = await apiClient.get(base(integration), { signal });
  return response.data;
};

/**
 * A document's bytes from an installed integration
 * (`GET /api/integrations/:id/files/content`), fetched with the signed-in
 * user's own permissions in that system.
 *
 * @param {Object} options
 * @param {string} options.integration - installation id
 * @param {{id: string, scope?: string}} options.ref
 * @param {'original'|'pdf'|'text'} [options.format='original']
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export const fetchIntegrationFileContent = async ({
  integration,
  ref,
  format = 'original',
  signal
} = {}) => {
  const params = buildSourceParams(ref, format);
  return apiClient.get(`${base(integration)}/content?${params}`, {
    responseType: 'blob',
    signal,
    timeout: CONTENT_REQUEST_TIMEOUT
  });
};

/**
 * A document's details (`GET /api/integrations/:id/files/metadata`).
 *
 * @param {Object} options
 * @param {string} options.integration - installation id
 * @param {{id: string, scope?: string}} options.ref
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Object>}
 */
export const fetchIntegrationFileMetadata = async ({ integration, ref, signal } = {}) => {
  const params = buildSourceParams(ref);
  const response = await apiClient.get(`${base(integration)}/metadata?${params}`, { signal });
  return response.data;
};
