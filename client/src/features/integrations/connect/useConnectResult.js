// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { consumeConnectResult, readConnectResult } from './connectResult';

/**
 * The sign-in result this page came back with (`integration_connected`,
 * `integration_error`), the same for every reader on the page.
 *
 * The result is read during render without touching the page; the result
 * parameters are removed from the URL after mount, in an effect, because
 * that replaces the history entry and dispatches a `popstate` the router
 * reacts to — which must not happen while React renders.
 *
 * @param {(result: ReturnType<typeof readConnectResult>) => any} [select] - What the
 *   component keeps of the result (read once, on mount)
 * @returns {any} The selected value (the whole result without `select`)
 *
 * @example
 * const connected = useConnectResult(result => result.connected);
 */
export function useConnectResult(select) {
  const [value] = useState(() => {
    const result = readConnectResult();
    return typeof select === 'function' ? select(result) : result;
  });
  useEffect(() => {
    consumeConnectResult();
  }, []);
  return value;
}

export default useConnectResult;
