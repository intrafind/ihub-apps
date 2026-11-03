// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { consumeConnectResult } from '../../features/integrations/connect/connectResult';

/**
 * Global clean-up of the integration sign-in result parameters
 * (`integration_connected`, `integration_error`, `integration`).
 *
 * Every integration's sign-in returns to the page it started on with these
 * parameters. This hook reads them once per page through
 * `consumeConnectResult`, which keeps the result for the page's own readers
 * (the chat's Connect cards and retry, Settings → Integrations) and removes
 * the parameters from the URL, so a reload or a shared link does not carry
 * them.
 */
export function useOAuthCallbackCleanup() {
  const { pathname } = useLocation();

  useEffect(() => {
    consumeConnectResult();
  }, [pathname]);
}
