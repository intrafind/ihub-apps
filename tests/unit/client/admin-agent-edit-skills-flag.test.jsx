// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The agent editor offers the Skills field only while the skills feature is
 * on. With it off, `/api/skills` answers 403, and the field used to request
 * it anyway and log errors.
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

let mockSkillsOn = false;
// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: p => `/${p}`,
  buildApiUrl: p => `/api/${p}`,
  getBasePath: () => ''
}));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: (name, fallback) => (name === 'skills' ? mockSkillsOn : fallback) })
}));
jest.mock('../../../client/src/shared/components/SkillsSelector', () => ({
  __esModule: true,
  default: () => <div data-testid="skills-selector" />
}));
jest.mock('../../../client/src/shared/components/IconPicker', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/CapabilityFields', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ProjectPicker', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ isDirty: false, blocker: { state: 'unblocked' }, markSaved() {} })
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: jest.fn(async () => []),
  fetchAdminModels: jest.fn(async () => []),
  getAdminApiErrorMessage: () => 'error'
}));
jest.mock('../../../client/src/api/agentsAdminApi', () => ({
  fetchAgentProfile: jest.fn(),
  createAgentProfile: jest.fn(),
  updateAgentProfile: jest.fn()
}));
jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
  useParams: () => ({})
}));
jest.mock('react-i18next', () => {
  const t = (key, fallback) =>
    typeof fallback === 'string' ? fallback : (fallback?.defaultValue ?? key);
  const translation = { t, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const AdminAgentEditPage =
  require('../../../client/src/features/admin/pages/AdminAgentEditPage').default;

test('no Skills field (and no skills request) while the feature is off', async () => {
  mockSkillsOn = false;
  render(<AdminAgentEditPage />);
  await waitFor(() => expect(screen.getByText(/Decomposition/)).toBeInTheDocument());
  expect(screen.queryByTestId('skills-selector')).not.toBeInTheDocument();
});

test('the Skills field is offered while the feature is on', async () => {
  mockSkillsOn = true;
  render(<AdminAgentEditPage />);
  expect(await screen.findByTestId('skills-selector')).toBeInTheDocument();
});
