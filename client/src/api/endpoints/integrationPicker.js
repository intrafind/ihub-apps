// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

/**
 * The chat's integrations picker (#2923). Server:
 * `server/routes/integrations/userIntegrations.js`.
 *
 * Not cached: rows carry the user's connection status, and the default is
 * changed from the picker itself.
 */

/**
 * The picker rows of an app: one per integration, MCP server, remote agent or
 * tool, decided by the server.
 *
 * A row: `{ id, kind, integration, refs, coveredBy, name, description, icon,
 * effects, capabilities, connection }`. Switching a row on adds its `refs` to
 * the chat's `enabledTools`; `coveredBy` are other references that keep it on.
 *
 * @param {string} appId
 * @param {Object} [options]
 * @param {string} [options.language]
 * @returns {Promise<Object[]>}
 */
export const fetchIntegrationPicker = async (appId, { language } = {}) => {
  const data = await handleApiResponse(
    () =>
      apiClient.get('/integrations/picker', {
        params: { app: appId, ...(language ? { lang: language } : {}) }
      }),
    null
  );
  return Array.isArray(data?.rows) ? data.rows : [];
};

/**
 * What a new chat of the app starts with for the signed-in user:
 * `{ stored, available, preferences: { enabledTools, websearchEnabled, integrationScopes } }`.
 *
 * @param {string} appId
 * @returns {Promise<Object>}
 */
export const fetchIntegrationPreferences = async appId =>
  handleApiResponse(
    () => apiClient.get('/integrations/preferences', { params: { app: appId } }),
    null
  );

/**
 * Save what new chats of the app start with. `importOnce` writes only when the
 * user has no default yet (the carry-over of what this browser kept).
 *
 * @param {string} appId
 * @param {{enabledTools?: string[], websearchEnabled?: boolean, integrationScopes?: Object<string, string>}} preferences
 * @param {Object} [options]
 * @param {boolean} [options.importOnce=false]
 * @returns {Promise<Object>} Same shape as {@link fetchIntegrationPreferences}
 */
export const saveIntegrationPreferences = async (appId, preferences, { importOnce = false } = {}) =>
  handleApiResponse(
    () =>
      apiClient.put(
        '/integrations/preferences',
        { ...preferences, ...(importOnce ? { import: true } : {}) },
        { params: { app: appId } }
      ),
    null
  );
