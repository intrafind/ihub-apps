// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Apps with an app whose required integration is off or not
 * installed. The page used to crash then: the "Open app" action's `disabled`
 * check called `missingRequirements` without the translator, which names a
 * missing installation through `t`.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  fetchAdminApps: jest.fn(),
  fetchAppIntegrationStatus: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  fetchAppIntegrationStatus: (...args) => mockApi.fetchAppIntegrationStatus(...args),
  getAdminApiErrorMessage: err => err?.message || 'error',
  makeAdminApiCall: jest.fn(),
  reorderApps: jest.fn(),
  toggleApps: jest.fn()
}));
jest.mock('../../../client/src/api', () => ({
  fetchUIConfig: jest.fn().mockResolvedValue({})
}));
// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {} })
}));
jest.mock('../../../client/src/features/apps/components/AppDetailsPopup', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/components/AppCreationWizard', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/components/AppTemplateSelector', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/UploadConfigButton', () => ({
  __esModule: true,
  default: () => null
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const AdminAppsPage = require('../../../client/src/features/admin/pages/AdminAppsPage').default;

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }
  });
});

const PEOPLE_APP = {
  id: 'people',
  name: { en: 'People finder' },
  enabled: true,
  integrations: { 'type:people-directory': {} }
};
const PORTAL_APP = {
  id: 'open-data',
  name: { en: 'Open data search' },
  enabled: true,
  integrations: { govdata: {} }
};

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.fetchAdminApps.mockResolvedValue([PEOPLE_APP, PORTAL_APP]);
  // No people directory enabled; the portal is not installed at all.
  mockApi.fetchAppIntegrationStatus.mockResolvedValue({ 'type:people-directory': false });
});

test('lists apps whose required integration is off instead of crashing', async () => {
  render(
    <MemoryRouter>
      <AdminAppsPage />
    </MemoryRouter>
  );
  expect(await screen.findByText('People finder')).toBeInTheDocument();
  expect(screen.getByText('Open data search')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
