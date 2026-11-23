// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The tabs of user skills (Admin → Skills) and user prompts (Admin → Prompts) hold settings with
 * unsaved edits. Switching to the other tab must not drop them, and leaving the page asks first:
 * the tab stays mounted (hidden) once opened, and the page carries ONE save bar and leave-guard.
 *
 * Real dirty tracking and the real pages; only the API is faked.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import {
  fetchAdminSkills,
  fetchAdminPrompts,
  fetchAdminGroups,
  makeAdminApiCall
} from '../../../client/src/api/adminApi';
import {
  fetchAdminUserSkills,
  fetchUserSkillSettings,
  saveUserSkillSettings
} from '../../../client/src/api';

const mockI18n = {
  t: (key, fallback, values) =>
    typeof fallback === 'string'
      ? fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''))
      : key,
  i18n: { language: 'en' }
};
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  fetchAdminSkills: jest.fn(),
  fetchAdminPrompts: jest.fn(),
  fetchAdminGroups: jest.fn(),
  togglePrompts: jest.fn(),
  deleteSkill: jest.fn(),
  toggleSkill: jest.fn(),
  exportSkill: jest.fn(),
  importSkill: jest.fn(),
  getAdminApiErrorMessage: err => `API error: ${err?.message}`
}));
jest.mock('../../../client/src/api', () => ({
  fetchUIConfig: jest.fn().mockResolvedValue({}),
  fetchAdminUserSkills: jest.fn(),
  fetchUserSkillSettings: jest.fn(),
  saveUserSkillSettings: jest.fn(),
  deleteUserSkill: jest.fn(),
  promoteUserSkill: jest.fn(),
  deleteUserPrompt: jest.fn()
}));
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegration: jest.fn(),
  fetchInstalledIntegrations: jest.fn().mockResolvedValue({ items: [] })
}));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: () => true })
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ refreshConfig: jest.fn() })
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildUploadUrl: path => path,
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));
jest.mock('../../../client/src/features/prompts/components/PromptDetailsPopup', () => () => null);
jest.mock('../../../client/src/features/prompts/components/PromptEditorModal', () => () => null);
jest.mock('../../../client/src/features/prompts/components/PromptShareDialog', () => () => null);
jest.mock('../../../client/src/features/prompts/components/PromptVersionsModal', () => () => null);
jest.mock('../../../client/src/features/skills/components/SkillDetailsModal', () => () => null);
jest.mock('../../../client/src/features/skills/components/SkillEditorModal', () => () => null);
jest.mock('../../../client/src/features/skills/components/SkillShareDialog', () => () => null);
jest.mock('../../../client/src/features/skills/components/SkillVersionsModal', () => () => null);
jest.mock('../../../client/src/features/admin/components/UploadConfigButton', () => () => null);

const AdminSkillsPage = require('../../../client/src/features/admin/pages/AdminSkillsPage').default;
const AdminPromptsPage =
  require('../../../client/src/features/admin/pages/AdminPromptsPage').default;

const PROMPT_SETTINGS = {
  settings: {
    enabled: true,
    maxPromptsPerUser: 50,
    maxVersions: 50,
    sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, restrictToGroups: [] }
  },
  storageAvailable: true
};
const SKILL_SETTINGS = {
  settings: {
    enabled: true,
    maxSkillsPerUser: 50,
    maxVersions: 50,
    maxSkillSizeKB: 256,
    maxFilesPerSkill: 20,
    allowMarketplace: true,
    sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, restrictToGroups: [] }
  },
  storageAvailable: true
};

const bar = () => screen.queryByRole('region', { name: 'Save changes' });
const everyone = () => screen.getByRole('checkbox', { name: 'Everyone signed in' });

/** A way off the page, as a sidebar link is. */
function GoAway() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/admin/groups')}>
      go away
    </button>
  );
}

const PAGES = [
  {
    name: 'Admin → Skills, user skills tab',
    Page: AdminSkillsPage,
    url: '/admin/skills?tab=user',
    otherTab: 'Skills',
    backTab: 'User skills',
    mock: () => {
      fetchAdminSkills.mockResolvedValue([{ name: 's1', displayName: 'Skill one' }]);
      fetchUserSkillSettings.mockResolvedValue(SKILL_SETTINGS);
      fetchAdminUserSkills.mockResolvedValue({ skills: [] });
      saveUserSkillSettings.mockImplementation(async draft => ({
        settings: draft,
        storageAvailable: true
      }));
    },
    saved: () =>
      expect(saveUserSkillSettings).toHaveBeenCalledWith({
        ...SKILL_SETTINGS.settings,
        sharing: { ...SKILL_SETTINGS.settings.sharing, allowEveryone: true }
      }),
    otherContent: () => screen.findByText('Skill one')
  },
  {
    name: 'Admin → Prompts, user prompts tab',
    Page: AdminPromptsPage,
    url: '/admin/prompts?tab=user',
    otherTab: 'Prompts',
    backTab: 'User prompts',
    mock: () => {
      fetchAdminPrompts.mockResolvedValue([]);
      makeAdminApiCall.mockImplementation(async (url, options) => {
        if (options?.method === 'PUT') {
          return {
            data: {
              ...PROMPT_SETTINGS,
              settings: {
                ...PROMPT_SETTINGS.settings,
                sharing: { ...PROMPT_SETTINGS.settings.sharing, allowEveryone: true }
              }
            }
          };
        }
        if (url === '/admin/prompts?scope=user') return { data: { items: [] } };
        return { data: PROMPT_SETTINGS };
      });
    },
    saved: () =>
      expect(makeAdminApiCall).toHaveBeenCalledWith(
        '/admin/prompts/user-settings',
        expect.objectContaining({ method: 'PUT' })
      ),
    otherContent: () => screen.findAllByRole('button', { name: 'Create New Prompt' })
  }
];

beforeEach(() => {
  jest.resetAllMocks();
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  require('../../../client/src/api/integrationsAdminApi').fetchInstalledIntegrations.mockResolvedValue(
    { items: [] }
  );
  require('../../../client/src/api').fetchUIConfig.mockResolvedValue({});
  fetchAdminGroups.mockResolvedValue({ groups: {} });
});

describe.each(PAGES)('$name', ({ Page, url, otherTab, backTab, mock, saved, otherContent }) => {
  const renderPage = async () => {
    mock();
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Page />
                <GoAway />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByRole('checkbox', { name: 'Everyone signed in' });
  };

  it('keeps the edit and the one bar when the admin switches to the other tab and back', async () => {
    await renderPage();
    expect(bar()).toBeNull();
    fireEvent.click(everyone());
    expect(bar()).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: otherTab }));
    await otherContent();

    // The settings are out of sight; the bar still carries them, once.
    expect(screen.queryByRole('checkbox', { name: 'Everyone signed in' })).toBeNull();
    expect(screen.getAllByRole('region', { name: 'Save changes' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: backTab }));
    expect(everyone()).toBeChecked();
  });

  it('saves the hidden tab from the other tab, and the bar goes away', async () => {
    await renderPage();
    fireEvent.click(everyone());
    fireEvent.click(screen.getByRole('button', { name: otherTab }));
    await otherContent();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });

    saved();
    await waitFor(() => expect(bar()).toBeNull());
  });

  it('asks before the admin leaves the page with the edit, also from the other tab', async () => {
    await renderPage();
    fireEvent.click(everyone());
    fireEvent.click(screen.getByRole('button', { name: otherTab }));
    await otherContent();

    fireEvent.click(screen.getByRole('button', { name: 'go away' }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('lets the admin leave when nothing changed', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'go away' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
