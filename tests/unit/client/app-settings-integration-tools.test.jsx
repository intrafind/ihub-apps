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

test('bindings without tools stay off the list', async () => {
  const { result } = await settled({
    id: 'research',
    integrations: {
      ihub: { actions: ['ask_user'] },
      ifinder: {},
      iassistant: {},
      jira: { actions: [] }
    }
  });
  expect(result.current.enabledTools).toEqual(['ihub', 'ifinder']);
});

test('the settings this browser kept survive the mount, and its integration state stays until imported', async () => {
  // The app is there before the models: the save must not run before the
  // kept settings are read, and must not drop keys it does not own.
  sessionStorage.setItem(
    'ai_hub_app_settings_research',
    JSON.stringify({ selectedStyle: 'brief', enabledTools: ['jira'] })
  );
  const app = { id: 'research', integrations: { jira: {} } };
  const { result } = renderHook(() => useAppSettings(app.id, app));
  await waitFor(() => expect(result.current.modelsLoading).toBe(false));
  await waitFor(() => expect(result.current.selectedStyle).toBe('brief'));
  // The preferences request fails here (the API mock has none), so nothing
  // was imported and the browser keeps its integration state for next time.
  const kept = JSON.parse(sessionStorage.getItem('ai_hub_app_settings_research'));
  expect(kept.selectedStyle).toBe('brief');
  expect(kept.enabledTools).toEqual(['jira']);
});
