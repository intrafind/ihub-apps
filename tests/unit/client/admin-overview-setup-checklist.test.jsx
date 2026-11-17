// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin Overview "Getting started" checklist (SH-B3). Its ticks used to be constants ("Admin
 * account ready" ticked while the same page warned that `admin` still had the shipped password),
 * and it only appeared with zero apps, which a real install (27 shipped apps) never has.
 * Now each tick comes from a server signal and the checklist shows while a required step is open.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const template = typeof fallback === 'string' ? fallback : key;
      const vars = (typeof fallback === 'object' ? fallback : options) || {};
      return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
        name in vars ? String(vars[name]) : match
      );
    },
    i18n: { language: 'en' }
  })
}));

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));

let mockOverview;
jest.mock('../../../client/src/features/admin/hooks/useOverviewData', () => ({
  __esModule: true,
  useOverviewData: () => mockOverview
}));
jest.mock('../../../client/src/features/admin/hooks/useUpdateCheck', () => ({
  __esModule: true,
  useUpdateCheck: () => ({ updateInfo: null })
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  __esModule: true,
  useUIConfig: () => ({ uiConfig: {} })
}));
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ user: { isAdmin: true, permissions: { adminAccess: true } } })
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: { setup: { configured: true } } })
}));
jest.mock('../../../client/src/features/admin/components/AdminDemoAccountsAlert', () => ({
  __esModule: true,
  default: () => null
}));

import AdminOverview from '../../../client/src/features/admin/pages/AdminOverview';
import {
  buildSetupSteps,
  hasOpenSetupSteps
} from '../../../client/src/features/admin/utils/setupChecklist';
import { SETUP_CHECKLIST_DISMISS_KEY } from '../../../client/src/features/admin/hooks/useSetupChecklist';

/** `GET /admin/overview/stats` of an install with the shipped apps and local sign-in only. */
function overviewStats({ apps = 27, auth = {} } = {}) {
  return {
    apps: { total: apps, enabled: apps },
    models: { total: 3, enabled: 1 },
    providers: { total: 3, enabled: 3 },
    groups: 4,
    users: 2,
    storage: null,
    integrations: { total: 0, enabled: 0, incompatible: 0, updatesAvailable: 0 },
    auth: {
      mode: 'local',
      anonymous: false,
      local: true,
      proxy: false,
      oidcProviders: 0,
      ldapProviders: 0,
      oauth: { authz: false, clients: false },
      ...auth
    }
  };
}

function answer({ demoAccounts = ['admin', 'user'], keyStatuses = [] } = {}) {
  mockMakeAdminApiCall.mockImplementation(url => {
    if (url === '/admin/auth/demo-accounts') {
      return Promise.resolve({
        data: { showDemoAccounts: true, accounts: demoAccounts, warn: demoAccounts.length > 0 }
      });
    }
    if (url === '/admin/models/_key-status') {
      return Promise.resolve({ data: { items: keyStatuses } });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

function renderOverview(stats = overviewStats(), { isFreshInstance = false } = {}) {
  mockOverview = {
    stats: null,
    platformInfo: stats,
    recentActivity: null,
    isLoading: false,
    isFreshInstance
  };
  return render(
    <MemoryRouter>
      <AdminOverview />
    </MemoryRouter>
  );
}

function step(id) {
  return document.querySelector(`[data-step="${id}"]`);
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  localStorage.clear();
});

describe('Getting started checklist on the Overview', () => {
  test('shows on an install with shipped apps while the admin still has the shipped password', async () => {
    answer({ keyStatuses: [{ id: 'gpt', enabled: true, state: 'missing' }] });
    renderOverview();

    expect(await screen.findByText('Getting started')).toBeInTheDocument();
    // Not ticked, links to the users page, says why.
    const admin = step('admin');
    expect(within(admin).getByRole('link', { name: /Admin account ready/ })).toHaveAttribute(
      'href',
      '/admin/users'
    );
    expect(within(admin).getByText(/still signs in with the shipped password/)).toBeInTheDocument();
    // No usable credential on an enabled model: the provider step is open as well.
    expect(within(step('provider')).getByRole('link')).toHaveAttribute('href', '/admin/providers');
    // 27 apps: no "create your first app" step that would tick for apps nobody created.
    expect(step('app')).toBeNull();
    // The platform status card is still shown next to it.
    expect(screen.getByText('Platform status')).toBeInTheDocument();
  });

  test('ticks the steps the server confirms and hides once every required step is done', async () => {
    answer({
      demoAccounts: ['user'],
      keyStatuses: [{ id: 'local', enabled: true, state: 'keyless' }]
    });
    renderOverview();

    await waitFor(() => expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByText('Getting started')).not.toBeInTheDocument();
  });

  test('does not count a disabled model with a key as a configured provider', async () => {
    answer({
      demoAccounts: [],
      keyStatuses: [
        { id: 'off', enabled: false, state: 'ok' },
        { id: 'broken', enabled: true, state: 'undecryptable' }
      ]
    });
    renderOverview();

    await screen.findByText('Getting started');
    expect(within(step('admin')).queryByRole('link')).toBeNull();
    expect(within(step('provider')).getByRole('link')).toBeInTheDocument();
  });

  test('waits for the overview stats before deciding, so it never flashes on an OIDC-only install', async () => {
    // `admin` still has the shipped password in users.json, but local sign-in is off: the step
    // is done. The demo-account answer arrives first; the stats come later.
    answer({ keyStatuses: [{ id: 'local', enabled: true, state: 'keyless' }] });
    const { rerender } = renderOverview(null);

    await waitFor(() => expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByText('Getting started')).not.toBeInTheDocument();

    mockOverview = {
      ...mockOverview,
      platformInfo: overviewStats({ auth: { local: false, oidcProviders: 1 } })
    };
    rerender(
      <MemoryRouter>
        <AdminOverview />
      </MemoryRouter>
    );
    await act(async () => {});
    expect(screen.queryByText('Getting started')).not.toBeInTheDocument();
  });

  test('shows no checklist, and no shipped-password hint, when the stats cannot be read', async () => {
    answer();
    renderOverview(null);

    await waitFor(() => expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByText('Getting started')).not.toBeInTheDocument();
    expect(screen.queryByText(/still signs in with the shipped password/)).not.toBeInTheDocument();
  });

  test('can be hidden, and stays hidden', async () => {
    answer();
    const { unmount } = renderOverview();

    fireEvent.click(await screen.findByRole('button', { name: 'Hide the setup checklist' }));
    expect(screen.queryByText('Getting started')).not.toBeInTheDocument();
    expect(localStorage.getItem(SETUP_CHECKLIST_DISMISS_KEY)).toBe('true');

    unmount();
    mockMakeAdminApiCall.mockClear();
    renderOverview();
    await act(async () => {});
    expect(screen.queryByText('Getting started')).not.toBeInTheDocument();
    expect(mockMakeAdminApiCall).not.toHaveBeenCalled();
  });
});

describe('buildSetupSteps', () => {
  const ids = steps => steps.filter(s => !s.done).map(s => s.id);

  test('leaves a step open, without a reason, when its signal could not be read', () => {
    const steps = buildSetupSteps({ overviewStats: null });
    expect(ids(steps)).toEqual(['admin', 'provider', 'identity']);
    expect(steps.find(s => s.id === 'admin').hint).toBeUndefined();
    expect(hasOpenSetupSteps(steps)).toBe(true);
  });

  test('counts the admin step done when local sign-in is off', () => {
    const steps = buildSetupSteps({
      demoAccounts: { accounts: ['admin'] },
      overviewStats: overviewStats({ auth: { local: false, oidcProviders: 1 } })
    });
    expect(steps.find(s => s.id === 'admin').done).toBe(true);
    expect(steps.find(s => s.id === 'identity').done).toBe(true);
  });

  test('lists "create your first app" only when the server reports no apps', () => {
    expect(ids(buildSetupSteps({ overviewStats: overviewStats({ apps: 0 }) }))).toContain('app');
    expect(ids(buildSetupSteps({ overviewStats: overviewStats({ apps: 1 }) }))).not.toContain(
      'app'
    );
  });

  test('an open optional step alone does not keep the checklist on screen', () => {
    const steps = buildSetupSteps({
      demoAccounts: { accounts: [] },
      modelKeyStatuses: [{ id: 'm', enabled: true, state: 'ok' }],
      overviewStats: overviewStats()
    });
    expect(ids(steps)).toEqual(['identity']);
    expect(hasOpenSetupSteps(steps)).toBe(false);
  });
});
