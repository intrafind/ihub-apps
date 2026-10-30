// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { fetchIntegrationScopes } from '../../../api';

const NO_INTEGRATIONS = [];

/**
 * The scopes the chat's integrations offer (where iFinder searches, whom
 * iAssistant asks) and which one is picked for this chat (#3050).
 *
 * The list comes from `GET /api/integrations/scopes` for the app and the
 * chat's model; nothing here knows which integration is behind an entry. The
 * selection is the chat's state (`integrationScopes` from `useAppSettings`):
 * a stored scope the list no longer offers falls back to the integration's
 * default, so the picker never shows a scope the server would refuse.
 *
 * @param {Object} params
 * @param {Object} params.app - The app config
 * @param {string} [params.modelId] - The chat's model
 * @param {string} [params.language] - UI language, for the scope names
 * @param {Object<string, string>} params.selected - The chat's picked scopes
 * @param {(scopes: Object<string, string>) => void} params.onChange - Stores a new selection
 * @returns {{
 *   integrations: Array<Object>,
 *   scopes: Object<string, string>,
 *   setScope: (integrationId: string, scopeId: string) => void,
 *   loading: boolean
 * }} `integrations` with `current` set to the scope in use; `scopes` is what
 *   the next chat request sends (only for integrations whose picker shows).
 */
export default function useIntegrationScopes({ app, modelId, language, selected, onChange }) {
  // What the server answered, and for which request: an answer for another
  // app or model is not shown while the new one loads.
  const [answer, setAnswer] = useState({ key: null, integrations: [] });
  const appId = app?.id;
  const requestKey = appId ? `${appId}|${modelId || ''}|${language || ''}` : null;

  useEffect(() => {
    if (!requestKey) return undefined;
    let cancelled = false;
    // Inside the chain, so a failure of any kind lands in the catch below.
    Promise.resolve()
      .then(() => fetchIntegrationScopes({ appId, modelId, language }))
      .then(data => {
        if (cancelled) return;
        setAnswer({
          key: requestKey,
          integrations: Array.isArray(data?.integrations) ? data.integrations : []
        });
      })
      .catch(() => {
        // No picker rather than a broken chat: the server applies its
        // defaults when a turn names no scope.
        if (!cancelled) setAnswer({ key: requestKey, integrations: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, appId, modelId, language]);

  const loading = Boolean(requestKey) && answer.key !== requestKey;
  const listed = answer.key === requestKey ? answer.integrations : NO_INTEGRATIONS;

  const integrations = useMemo(
    () =>
      listed.map(integration => {
        const picked = selected?.[integration.id];
        const offered = integration.scopes?.some(scope => scope.id === picked);
        return {
          ...integration,
          current: !integration.fixed && offered ? picked : integration.defaultScope
        };
      }),
    [listed, selected]
  );

  const scopes = useMemo(() => {
    const out = {};
    for (const integration of integrations) {
      if (integration.scopePicker !== 'hidden' && integration.current) {
        out[integration.id] = integration.current;
      }
    }
    return out;
  }, [integrations]);

  const setScope = (integrationId, scopeId) => {
    onChange?.({ ...(selected || {}), [integrationId]: scopeId });
  };

  return { integrations, scopes, setScope, loading };
}
