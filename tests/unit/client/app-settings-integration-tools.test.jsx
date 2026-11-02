// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('../../../client/src/api', () => ({
  fetchModels: jest.fn(),
  fetchStyles: jest.fn()
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: jest.fn()
}));

import { fetchModels, fetchStyles } from '../../../client/src/api';
import { useUIConfig } from '../../../client/src/shared/contexts/UIConfigContext';
import useAppSettings from '../../../client/src/shared/hooks/useAppSettings';

/**
 * A new chat starts with every tool the app offers enabled, and the chat sends
 * that list as `enabledTools`; the server drops every tool it does not name.
 * The installed integrations an app binds are on that list, iFinder included:
 * the iFinder Search app of an upgraded 5.6.4 install binds `ifinder` and lists
 * no tools, and used to start with `enabledTools: []`, so its model was
 * offered none of the iFinder tools.
 */

beforeEach(() => {
  sessionStorage.clear();
  fetchModels.mockReset().mockResolvedValue([{ id: 'model-a', name: 'A' }]);
  fetchStyles.mockReset().mockResolvedValue([]);
  useUIConfig.mockReturnValue({ setHeaderColor: jest.fn() });
});

/** Models first, then the app — the order `AppChat` settles in. */
async function settled(app) {
  const rendered = renderHook(({ current }) => useAppSettings(app.id, current), {
    initialProps: { current: null }
  });
  await waitFor(() => expect(rendered.result.current.modelsLoading).toBe(false));
  await act(async () => {
    rendered.rerender({ current: app });
  });
  return rendered;
}

test('a chat in the upgraded iFinder Search app starts with the iFinder tools on', async () => {
  const { result } = await settled({
    id: 'ifinder-search',
    integrations: { ifinder: { scopePicker: 'menu' } }
  });
  expect(result.current.enabledTools).toEqual(['ifinder']);
});

test("the app's own tools come first, and bindings without tools stay off the list", async () => {
  const { result } = await settled({
    id: 'research',
    tools: ['ask_user', 'braveSearch'],
    integrations: { ifinder: {}, iassistant: {}, jira: { actions: [] } }
  });
  expect(result.current.enabledTools).toEqual(['ask_user', 'braveSearch', 'ifinder']);
});
