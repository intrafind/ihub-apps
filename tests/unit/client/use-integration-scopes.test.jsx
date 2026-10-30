// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { renderHook, waitFor } from '@testing-library/react';

/**
 * `useIntegrationScopes` (intrafind/ihub-apps#3050): what the next chat turn
 * sends as `integrationScopes`, before and after the scope list has loaded.
 */

let resolveFetch;
jest.mock('../../../client/src/api', () => ({
  fetchIntegrationScopes: jest.fn(
    () =>
      new Promise(resolve => {
        resolveFetch = resolve;
      })
  )
}));

const { fetchIntegrationScopes } = require('../../../client/src/api');
const useIntegrationScopes =
  require('../../../client/src/features/chat/hooks/useIntegrationScopes').default;

const LISTED = {
  integrations: [
    {
      id: 'ifinder',
      scopePicker: 'menu',
      fixed: false,
      defaultScope: 'standard',
      scopes: [{ id: 'standard' }, { id: 'contracts' }]
    }
  ]
};

describe('useIntegrationScopes', () => {
  beforeEach(() => {
    resolveFetch = undefined;
    fetchIntegrationScopes.mockClear();
  });

  it('sends the stored pick while the list loads, then the checked one', async () => {
    const { result } = renderHook(() =>
      useIntegrationScopes({
        app: { id: 'ifinder-search' },
        modelId: 'm',
        language: 'en',
        selected: { ifinder: 'contracts' },
        onChange: jest.fn()
      })
    );

    expect(result.current.loading).toBe(true);
    expect(result.current.scopes).toEqual({ ifinder: 'contracts' });

    await waitFor(() => expect(typeof resolveFetch).toBe('function'));
    resolveFetch(LISTED);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scopes).toEqual({ ifinder: 'contracts' });
  });

  it('falls back to the default for a stored pick the list no longer offers', async () => {
    const { result } = renderHook(() =>
      useIntegrationScopes({
        app: { id: 'ifinder-search' },
        selected: { ifinder: 'gone' },
        onChange: jest.fn()
      })
    );
    await waitFor(() => expect(typeof resolveFetch).toBe('function'));
    resolveFetch(LISTED);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scopes).toEqual({ ifinder: 'standard' });
  });
});
