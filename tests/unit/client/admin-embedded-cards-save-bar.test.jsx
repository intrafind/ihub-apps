// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cards that sit inside another admin page (the Providers timeouts, the Usage limits
 * settings, the Project settings, the Personal apps settings, the settings of user prompts and
 * user skills) have no Save button of their own: the page's bar saves them.
 *
 * For every card, with the real dirty tracking: no bar before a change, the bar after a change
 * that touches only a nested value, Discard puts the field back and hides the bar, a failed save
 * keeps the bar and names the error, the retry sends the edit.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import {
  SaveSectionsBar,
  SaveSectionsProvider
} from '../../../client/src/features/admin/components/SaveSections';
import LlmTimeoutsCard from '../../../client/src/features/admin/components/LlmTimeoutsCard';
import AdminUsageReports from '../../../client/src/features/admin/pages/AdminUsageReports';
import UsageQuotasPanel from '../../../client/src/features/admin/components/UsageQuotasPanel';
import ProjectSharingSettingsPanel from '../../../client/src/features/admin/components/ProjectSharingSettingsPanel';
import UserAppSettingsPanel from '../../../client/src/features/admin/components/UserAppSettingsPanel';
import AdminUserPromptsTab from '../../../client/src/features/admin/components/AdminUserPromptsTab';
import AdminUserSkillsTab from '../../../client/src/features/admin/components/AdminUserSkillsTab';
import {
  fetchAdminGroups,
  fetchAdminUsageMeta,
  fetchProjectSettings,
  fetchUserAppSettings,
  makeAdminApiCall,
  saveProjectSettings,
  saveUserAppSettings
} from '../../../client/src/api/adminApi';
import {
  fetchUsageLimitSettings,
  saveUsageLimitSettings
} from '../../../client/src/api/usageLimitsAdminApi';
import {
  fetchAdminUserSkills,
  fetchUserSkillSettings,
  saveUserSkillSettings
} from '../../../client/src/api';

// A stable `t` and i18n, as in the app: several effects list `t` as a dependency.
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
  fetchAdminGroups: jest.fn(),
  fetchAdminUsageMeta: jest.fn(),
  updateAdminUsageTrackingMode: jest.fn(),
  fetchProjectSettings: jest.fn(),
  saveProjectSettings: jest.fn(),
  fetchUserAppSettings: jest.fn(),
  saveUserAppSettings: jest.fn(),
  getAdminApiErrorMessage: err => `API error: ${err?.message}`
}));
jest.mock('../../../client/src/api/usageLimitsAdminApi', () => ({
  fetchUsageLimitSettings: jest.fn(),
  saveUsageLimitSettings: jest.fn(),
  fetchUsageLimitModels: jest.fn(),
  fetchUsageLimitGroups: jest.fn(),
  fetchUsageLimitNear: jest.fn(),
  fetchUsageLimitUsers: jest.fn(),
  resetUsageLimitUser: jest.fn()
}));
jest.mock('../../../client/src/api', () => ({
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
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));
jest.mock('../../../client/src/features/projects/components/ProjectAppSelect', () => () => null);
// The other tabs of the Usage page are not under test.
jest.mock('../../../client/src/features/admin/components/usage/RangeControl', () => () => null);
jest.mock('../../../client/src/features/admin/components/usage/UsageOverview', () => () => (
  <div data-testid="usage-overview" />
));
jest.mock('../../../client/src/features/admin/components/usage/BreakdownTable', () => () => null);
jest.mock('../../../client/src/features/admin/components/usage/ReliabilityPanel', () => () => null);
jest.mock('../../../client/src/features/admin/components/usage/RequestLog', () => () => null);
jest.mock('../../../client/src/features/prompts/components/PromptEditorModal', () => () => null);
jest.mock('../../../client/src/features/prompts/components/PromptShareDialog', () => () => null);
jest.mock('../../../client/src/features/prompts/components/PromptVersionsModal', () => () => null);
jest.mock('../../../client/src/features/skills/components/SkillDetailsModal', () => () => null);
jest.mock('../../../client/src/features/skills/components/SkillEditorModal', () => () => null);
jest.mock('../../../client/src/features/skills/components/SkillShareDialog', () => () => null);
jest.mock('../../../client/src/features/skills/components/SkillVersionsModal', () => () => null);

const BAR = { name: 'Save changes' };
const bar = () => screen.queryByRole('region', BAR);
const saveButton = () => screen.getByRole('button', { name: 'Save Changes' });
const discardButton = () => screen.getByRole('button', { name: 'Discard' });

const withBar = element => (
  <MemoryRouter>
    <SaveSectionsProvider>
      {element}
      <SaveSectionsBar />
    </SaveSectionsProvider>
  </MemoryRouter>
);

const PROJECT_SETTINGS = {
  sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowCatalog: false },
  tierPolicy: 'ihub',
  defaultAppId: '',
  limits: {
    maxFiles: 25,
    maxFileBytes: 20971520,
    maxProjectBytes: 209715200,
    maxProjectsPerUser: 20
  },
  maxFilesCeiling: 200
};

const USER_APP_SETTINGS = {
  sharing: { allowUsers: true, allowGroups: false, allowEveryone: false, allowPublish: false },
  publishing: { adminEnables: 'always' },
  limits: { maxAppsPerUser: 20 },
  capabilities: {
    modelChoice: true,
    upload: true,
    webSearch: false,
    skills: false,
    integrations: []
  },
  blockedOwners: []
};

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

const USAGE_SETTINGS = {
  allModels: {},
  resets: { dailyAt: '00:00', weeklyOn: 'monday', weeklyAt: '00:00', monthlyAt: '00:00' },
  effectiveTimezone: 'UTC',
  nextResets: {
    day: '2030-01-02T00:00:00Z',
    week: '2030-01-07T00:00:00Z',
    month: '2030-02-01T00:00:00Z'
  }
};

/**
 * One entry per card. `edit` changes one value that lives in a nested object of the card's
 * state (so a shared-baseline mutation would hide the bar), `read` returns it, `fail` makes the
 * next save fail, `ok` lets it succeed, `sent` is what the retry must send.
 */
const CARDS = [
  {
    name: 'LlmTimeoutsCard',
    render: () => render(withBar(<LlmTimeoutsCard />)),
    mock: () =>
      makeAdminApiCall.mockResolvedValue({
        data: {
          saved: {},
          defaults: { connectTimeoutMs: 30000, streamIdleTimeoutMs: 60000 },
          effective: { connectTimeoutMs: 30000, streamIdleTimeoutMs: 60000 }
        }
      }),
    ready: async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    },
    field: () => screen.getByLabelText('Connect timeout (ms)'),
    edit: field => fireEvent.change(field, { target: { value: '5' } }),
    original: null,
    changed: 5,
    error: 'API error: too large',
    fail: () => makeAdminApiCall.mockRejectedValueOnce(new Error('too large')),
    ok: () =>
      makeAdminApiCall.mockResolvedValueOnce({
        data: { saved: { connectTimeoutMs: 5 }, defaults: {}, effective: {} }
      }),
    sentCall: () => makeAdminApiCall.mock.calls.filter(call => call[1]?.method === 'PUT').at(-1),
    sent: [
      '/admin/llm-timeouts',
      { method: 'PUT', body: { connectTimeoutMs: 5, streamIdleTimeoutMs: null } }
    ]
  },
  {
    name: 'UsageQuotasPanel (settings)',
    render: () => render(withBar(<UsageQuotasPanel />)),
    mock: () => fetchUsageLimitSettings.mockResolvedValue(USAGE_SETTINGS),
    ready: () => screen.findByTestId('usage-limit-settings'),
    field: () => screen.getByLabelText('Time zone'),
    edit: field => fireEvent.change(field, { target: { value: 'Europe/Berlin' } }),
    original: '',
    changed: 'Europe/Berlin',
    // The panel words a failure without a response itself.
    error: 'Settings could not be saved',
    fail: () => saveUsageLimitSettings.mockRejectedValueOnce(new Error('bad zone')),
    ok: () =>
      saveUsageLimitSettings.mockResolvedValueOnce({
        ...USAGE_SETTINGS,
        resets: { ...USAGE_SETTINGS.resets, timezone: 'Europe/Berlin' }
      }),
    sentCall: () => saveUsageLimitSettings.mock.calls.at(-1),
    sent: [
      {
        allModels: {},
        resets: { ...USAGE_SETTINGS.resets, timezone: 'Europe/Berlin' }
      }
    ]
  },
  {
    name: 'ProjectSharingSettingsPanel',
    render: () => render(withBar(<ProjectSharingSettingsPanel />)),
    mock: () => fetchProjectSettings.mockResolvedValue(PROJECT_SETTINGS),
    ready: () => screen.findByRole('checkbox', { name: /The project catalog/ }),
    field: () => screen.getByRole('checkbox', { name: /The project catalog/ }),
    edit: field => fireEvent.click(field),
    original: false,
    changed: true,
    read: field => field.checked,
    error: 'API error: denied',
    fail: () => saveProjectSettings.mockRejectedValueOnce(new Error('denied')),
    ok: () =>
      saveProjectSettings.mockImplementationOnce(async settings => ({
        ...PROJECT_SETTINGS,
        ...settings
      })),
    sentCall: () => saveProjectSettings.mock.calls.at(-1),
    sent: [
      {
        sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowCatalog: true },
        tierPolicy: 'ihub',
        defaultAppId: ''
      }
    ]
  },
  {
    name: 'UserAppSettingsPanel',
    render: () => render(withBar(<UserAppSettingsPanel />)),
    mock: () => fetchUserAppSettings.mockResolvedValue(USER_APP_SETTINGS),
    ready: () => screen.findByRole('checkbox', { name: /allowEveryone/ }),
    field: () => screen.getByRole('checkbox', { name: /allowEveryone/ }),
    edit: field => fireEvent.click(field),
    original: false,
    changed: true,
    read: field => field.checked,
    error: 'API error: conflict',
    fail: () => saveUserAppSettings.mockRejectedValueOnce(new Error('conflict')),
    ok: () =>
      saveUserAppSettings.mockResolvedValueOnce({
        ...USER_APP_SETTINGS,
        sharing: { ...USER_APP_SETTINGS.sharing, allowEveryone: true }
      }),
    sentCall: () => saveUserAppSettings.mock.calls.at(-1),
    sent: [{ sharing: { allowEveryone: true } }]
  },
  {
    name: 'AdminUserPromptsTab (settings)',
    render: () => render(<MemoryRouter>{<AdminUserPromptsTab />}</MemoryRouter>),
    mock: () =>
      makeAdminApiCall.mockImplementation(async url =>
        url === '/admin/prompts?scope=user' ? { data: { items: [] } } : { data: PROMPT_SETTINGS }
      ),
    ready: () => screen.findByRole('checkbox', { name: 'Everyone signed in' }),
    field: () => screen.getByRole('checkbox', { name: 'Everyone signed in' }),
    edit: field => fireEvent.click(field),
    original: false,
    changed: true,
    read: field => field.checked,
    error: 'API error: no storage',
    fail: () => {
      makeAdminApiCall.mockImplementation(async (url, options) => {
        if (options?.method === 'PUT') throw new Error('no storage');
        if (url === '/admin/prompts?scope=user') return { data: { items: [] } };
        return { data: PROMPT_SETTINGS };
      });
    },
    ok: () => {
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
    sentCall: () => makeAdminApiCall.mock.calls.filter(call => call[1]?.method === 'PUT').at(-1),
    sent: [
      '/admin/prompts/user-settings',
      {
        method: 'PUT',
        body: {
          ...PROMPT_SETTINGS.settings,
          sharing: { ...PROMPT_SETTINGS.settings.sharing, allowEveryone: true }
        }
      }
    ]
  },
  {
    name: 'AdminUserSkillsTab (settings)',
    render: () => render(<MemoryRouter>{<AdminUserSkillsTab />}</MemoryRouter>),
    mock: () => {
      fetchUserSkillSettings.mockResolvedValue(SKILL_SETTINGS);
      fetchAdminUserSkills.mockResolvedValue({ skills: [] });
    },
    ready: () => screen.findByRole('checkbox', { name: 'Everyone signed in' }),
    field: () => screen.getByRole('checkbox', { name: 'Everyone signed in' }),
    edit: field => fireEvent.click(field),
    original: false,
    changed: true,
    read: field => field.checked,
    error: 'no storage',
    fail: () => saveUserSkillSettings.mockRejectedValueOnce(new Error('no storage')),
    ok: () =>
      saveUserSkillSettings.mockImplementationOnce(async draft => ({
        settings: draft,
        storageAvailable: true
      })),
    sentCall: () => saveUserSkillSettings.mock.calls.at(-1),
    sent: [
      {
        ...SKILL_SETTINGS.settings,
        sharing: { ...SKILL_SETTINGS.settings.sharing, allowEveryone: true }
      }
    ]
  }
];

beforeEach(() => {
  jest.resetAllMocks();
  fetchAdminGroups.mockResolvedValue({ groups: {} });
  fetchUsageLimitSettings.mockResolvedValue(USAGE_SETTINGS);
  fetchAdminUsageMeta.mockResolvedValue({ trackingMode: 'pseudonymous' });
  const empty = { items: [], nextCursor: null, total: 0 };
  const usage = require('../../../client/src/api/usageLimitsAdminApi');
  usage.fetchUsageLimitModels.mockResolvedValue(empty);
  usage.fetchUsageLimitGroups.mockResolvedValue(empty);
  usage.fetchUsageLimitNear.mockResolvedValue(empty);
  usage.fetchUsageLimitUsers.mockResolvedValue(empty);
  require('../../../client/src/api/integrationsAdminApi').fetchInstalledIntegrations.mockResolvedValue(
    { items: [] }
  );
});

describe.each(CARDS)('$name and the page bar', card => {
  const open = async () => {
    card.mock();
    card.render();
    await card.ready();
  };
  const valueOf = () => (card.read ? card.read(card.field()) : card.field().value);

  it('has no bar until a value changed, and no Save of its own', async () => {
    await open();

    expect(bar()).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
  });

  it('shows the bar for a change of a nested value, and Discard puts it back', async () => {
    await open();
    const before = valueOf();

    card.edit(card.field());

    expect(bar()).toBeInTheDocument();
    expect(valueOf()).not.toEqual(before);

    fireEvent.click(discardButton());

    expect(bar()).toBeNull();
    expect(valueOf()).toEqual(before);
  });

  it('keeps the bar and names the error when the save fails, and the retry sends the edit', async () => {
    await open();
    card.edit(card.field());
    card.fail();

    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(await screen.findByTestId('save-bar-message')).toHaveTextContent(card.error);
    expect(bar()).toBeInTheDocument();
    // The edit is still there to retry.
    expect(saveButton()).toBeEnabled();

    card.ok();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(bar()).toBeNull());

    expect(card.sentCall()).toEqual(card.sent);
  });
});

describe('the Usage page keeps the bar while the limits tab is hidden', () => {
  it('shows the bar of an unsaved limits edit on every tab', async () => {
    // The page itself is covered by admin-usage-reports-limits-tab; here only the provider and
    // bar placement of the real page matter, with the other tabs stubbed out.
    render(
      <MemoryRouter initialEntries={['/admin/usage?tab=limits']}>
        <AdminUsageReports />
      </MemoryRouter>
    );
    await screen.findByTestId('usage-limit-settings');
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Europe/Berlin' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Overview/ }));

    // The limits panel is hidden, its edit is still unsaved: the bar stays.
    expect(screen.getByLabelText('Time zone')).not.toBeVisible();
    expect(bar()).toBeInTheDocument();
  });
});
