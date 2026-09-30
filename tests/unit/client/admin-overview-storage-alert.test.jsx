/**
 * Admin Overview: warns when a volume iHub writes to is filling up, and shows
 * the fullest volume's free space in "Platform status". Links to the System
 * resources page only when that page is enabled (`admin.pages.system`).
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  const vars = (typeof fallback === 'object' ? fallback : options) || {};
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match
  );
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t, i18n: { language: 'en' } })
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
let mockPlatformConfig;
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: mockPlatformConfig })
}));

import AdminOverview from '../../../client/src/features/admin/pages/AdminOverview';

const GiB = 1024 ** 3;

function platformInfo(storage) {
  return {
    apps: { total: 1, enabled: 1 },
    models: { total: 1, enabled: 1 },
    providers: { total: 1, enabled: 1 },
    sources: { total: 0, enabled: 0 },
    tools: { total: 0, enabled: 0 },
    groups: 3,
    users: 1,
    storage,
    auth: {
      mode: 'local',
      anonymous: false,
      local: true,
      proxy: false,
      oidcProviders: 0,
      ldapProviders: 0,
      oauth: { authz: false, clients: false }
    }
  };
}

function renderOverview(storage) {
  mockOverview = {
    stats: null,
    platformInfo: platformInfo(storage),
    recentActivity: [],
    isLoading: false,
    isFreshInstance: false
  };
  return render(
    <MemoryRouter>
      <AdminOverview />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockPlatformConfig = {};
});

test('warns when disk space is critically low and links to the details', () => {
  renderOverview({ status: 'critical', usedPercent: 95, available: 1 * GiB, total: 20 * GiB });

  expect(screen.getByRole('alert')).toHaveTextContent(
    'Disk space is critically low: 1.0 GB free (95% used).'
  );
  expect(screen.getByRole('link', { name: /View system resources/ })).toHaveAttribute(
    'href',
    '/admin/system-resources'
  );
  const row = screen.getByText('1.0 GB free');
  expect(row).toHaveAttribute('title', '95% of 20.0 GB used');
});

test('no banner while disk space is fine, but the row is still shown', () => {
  renderOverview({ status: 'ok', usedPercent: 20, available: 40 * GiB, total: 50 * GiB });

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Disk space')).toBeInTheDocument();
  expect(screen.getByText('40.0 GB free')).toBeInTheDocument();
});

test('does not link to the System resources page when system pages are hidden', () => {
  mockPlatformConfig = { admin: { pages: { system: false } } };
  renderOverview({ status: 'warning', usedPercent: 85, available: 3 * GiB, total: 20 * GiB });

  expect(screen.getByRole('alert')).toHaveTextContent('Disk space is running low');
  expect(screen.queryByRole('link', { name: /View system resources/ })).not.toBeInTheDocument();
});

test('no disk row when the server could not read any volume', () => {
  renderOverview(null);

  expect(screen.queryByText('Disk space')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
