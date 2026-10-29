// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The projects gate (#1036) reads `platformConfig.projects`, which the real
 * `PlatformConfigProvider` assembles by hand from `/api/configs/platform`.
 * The page tests mock the context and hand the block in directly, so a
 * provider that dropped it went unnoticed: the sidebar entry and the chat's
 * project controls stayed hidden and `/projects` rendered "not found" while
 * the server had projects switched on. This goes through the real provider.
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPlatform = { current: {} };
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAuthStatus: () => Promise.resolve({ authMode: 'local', authMethods: {} }),
  fetchUIConfig: () => Promise.resolve({}),
  fetchPlatformConfig: () => Promise.resolve(mockPlatform.current),
  invalidateAuthStatusCache: () => {},
  invalidatePlatformConfigCache: () => {},
  invalidateUIConfigCache: () => {},
  fetchProject: jest.fn(),
  fetchProjects: jest.fn(),
  fetchProjectList: jest.fn(),
  fetchProjectsConfig: jest.fn()
}));
jest.mock('../../../client/src/shared/contexts/authContextValue', () => ({
  useOptionalAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'u_17' } })
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, def) => def || key, i18n: { language: 'en' } })
}));

const {
  PlatformConfigProvider
} = require('../../../client/src/shared/contexts/PlatformConfigContext');
const {
  useProjectsRouteState,
  useProjectsAvailability
} = require('../../../client/src/features/projects/hooks/useProjects');

function Gate() {
  const route = useProjectsRouteState();
  const { userProjectsEnabled } = useProjectsAvailability();
  return (
    <div data-testid="gate">
      {route}/{String(userProjectsEnabled)}
    </div>
  );
}

const renderGate = () =>
  render(
    <PlatformConfigProvider>
      <Gate />
    </PlatformConfigProvider>
  );

test('opens the projects routes when the server turns user projects on', async () => {
  mockPlatform.current = { projects: { enabled: true, userProjects: true } };
  renderGate();
  await waitFor(() => expect(screen.getByTestId('gate')).toHaveTextContent('ready/true'));
});

test('keeps them closed when the server has them off', async () => {
  mockPlatform.current = { projects: { enabled: true, userProjects: false } };
  renderGate();
  await waitFor(() => expect(screen.getByTestId('gate')).toHaveTextContent('unavailable/false'));
});
