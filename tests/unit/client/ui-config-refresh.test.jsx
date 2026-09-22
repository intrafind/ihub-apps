import { render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api', () => ({
  fetchUIConfig: jest.fn(),
  invalidateUIConfigCache: jest.fn()
}));
// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: path => path,
  buildAssetUrl: path => path
}));

import { fetchUIConfig, invalidateUIConfigCache } from '../../../client/src/api';
import { UIConfigProvider, useUIConfig } from '../../../client/src/shared/contexts/UIConfigContext';
import { resolveHomePath } from '../../../client/src/utils/homePage';
import { readAppShortcutConfig } from '../../../client/src/utils/appShortcuts';

/**
 * Everything an admin changes under UI Customization reaches the running app
 * through this context: the sidebar's app shortcuts and the view "/" redirects
 * to both read it. API responses are cached in memory for 30 minutes, so a
 * refresh that goes through the cache hands back the configuration the page
 * booted with and the change only shows after a full reload (#2320).
 */

const APP_HOME = {
  startPage: { defaultPage: 'app', defaultPageAppId: 'translator', sidebarAppsCount: 2 }
};
const APPS_HOME = {
  startPage: { defaultPage: 'apps', sidebarAppsCount: 7, featuredAppIds: ['chat'] }
};

function Probe() {
  const { uiConfig, isLoading, refreshUIConfig } = useUIConfig();
  const { sidebarCount, featuredAppIds } = readAppShortcutConfig(uiConfig);
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="home">{resolveHomePath(uiConfig)}</span>
      <span data-testid="sidebar-count">{sidebarCount}</span>
      <span data-testid="featured">{featuredAppIds.join(',')}</span>
      <button onClick={refreshUIConfig}>refresh</button>
    </div>
  );
}

const renderProbe = async () => {
  const utils = render(
    <UIConfigProvider>
      <Probe />
    </UIConfigProvider>
  );
  await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
  return utils;
};

beforeEach(() => {
  fetchUIConfig.mockReset();
  invalidateUIConfigCache.mockReset();
});

test('a refresh drops the cached response before refetching', async () => {
  fetchUIConfig.mockResolvedValueOnce(APP_HOME).mockResolvedValueOnce(APPS_HOME);
  await renderProbe();

  // The initial load may be served from the cache — nothing has changed yet.
  expect(invalidateUIConfigCache).not.toHaveBeenCalled();

  await act(async () => {
    screen.getByText('refresh').click();
  });

  expect(invalidateUIConfigCache).toHaveBeenCalledTimes(1);
  expect(fetchUIConfig).toHaveBeenCalledTimes(2);
  // Invalidation has to happen first, or the refetch is answered from the cache.
  expect(invalidateUIConfigCache.mock.invocationCallOrder[0]).toBeLessThan(
    fetchUIConfig.mock.invocationCallOrder[1]
  );
});

test('the saved configuration reaches the "/" redirect and the sidebar shortcuts', async () => {
  fetchUIConfig.mockResolvedValueOnce(APP_HOME).mockResolvedValueOnce(APPS_HOME);
  await renderProbe();

  expect(screen.getByTestId('home')).toHaveTextContent('/apps/translator');
  expect(screen.getByTestId('sidebar-count')).toHaveTextContent('2');
  expect(screen.getByTestId('featured')).toHaveTextContent('');

  await act(async () => {
    screen.getByText('refresh').click();
  });

  expect(screen.getByTestId('home')).toHaveTextContent('/apps');
  expect(screen.getByTestId('sidebar-count')).toHaveTextContent('7');
  expect(screen.getByTestId('featured')).toHaveTextContent('chat');
});

test('a refresh keeps the current config on screen instead of flipping to loading', async () => {
  let resolveRefresh;
  fetchUIConfig
    .mockResolvedValueOnce(APP_HOME)
    .mockImplementationOnce(() => new Promise(resolve => (resolveRefresh = resolve)));
  await renderProbe();

  await act(async () => {
    screen.getByText('refresh').click();
  });

  // Still in flight: `isLoading` must stay false so the language selector and
  // the "/" redirect keep rendering the answer we already have.
  expect(screen.getByTestId('loading')).toHaveTextContent('false');
  expect(screen.getByTestId('home')).toHaveTextContent('/apps/translator');

  await act(async () => {
    resolveRefresh(APPS_HOME);
  });
  expect(screen.getByTestId('home')).toHaveTextContent('/apps');
});

test('a failed refresh reports the error and keeps the last good config', async () => {
  const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
  fetchUIConfig.mockResolvedValueOnce(APP_HOME).mockRejectedValueOnce(new Error('boom'));
  await renderProbe();

  await act(async () => {
    screen.getByText('refresh').click();
  });

  expect(screen.getByTestId('home')).toHaveTextContent('/apps/translator');
  expect(screen.getByTestId('loading')).toHaveTextContent('false');
  expect(logged).toHaveBeenCalled();
  logged.mockRestore();
});
