import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * Regression coverage for issue #2322: the start page renders the default
 * app's real chat input, but it never passed the per-chat feature props, so
 * the `+` menu hid web search entirely and listed the app's tools with every
 * one switched off and no working toggle. The picks also have to reach the
 * app, because the first message is auto-sent there.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => defaultValue ?? key,
    i18n: { language: 'en' }
  })
}));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams()],
  Navigate: () => null
}));

const mockApp = {
  id: 'chat',
  name: { en: 'Chat' },
  description: { en: 'General chat' },
  color: '#4f46e5',
  icon: 'chat',
  integrations: { braveSearch: {}, jira: {} },
  websearch: { enabled: true, enabledByDefault: false },
  features: { magicPrompt: { enabled: true } }
};

const mockModelList = [{ id: 'gpt', name: { en: 'GPT' } }];

const mockPreferences = { current: null };
jest.mock('../../../client/src/api', () => ({
  fetchAppDetails: jest.fn(() => Promise.resolve(mockApp)),
  fetchModels: jest.fn(() => Promise.resolve(mockModelList)),
  // The picker rows come from the server (#2923), names localized there.
  fetchIntegrationPicker: jest.fn(() =>
    Promise.resolve([
      {
        id: 'tool:braveSearch',
        kind: 'tool',
        refs: ['braveSearch'],
        coveredBy: [],
        name: 'Brave Search',
        effects: ['read']
      },
      {
        id: 'integration:jira',
        kind: 'integration',
        integration: 'jira',
        refs: ['jira'],
        coveredBy: [],
        name: 'Jira',
        effects: ['read', 'write']
      }
    ])
  ),
  // The user's default for the app: none stored unless a case says so.
  fetchIntegrationPreferences: jest.fn(() =>
    Promise.resolve(
      mockPreferences.current || {
        stored: false,
        available: true,
        preferences: {
          enabledTools: ['braveSearch', 'jira'],
          websearchEnabled: false,
          integrationScopes: {}
        }
      }
    )
  ),
  saveIntegrationPreferences: jest.fn((_appId, preferences) =>
    Promise.resolve({ stored: true, available: true, preferences })
  ),
  generateMagicPrompt: jest.fn(() => Promise.resolve({ prompt: 'enhanced' }))
}));
const api = require('../../../client/src/api');

jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Ada' } })
}));

jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {}, resetHeaderColor: jest.fn(), setHeaderColor: jest.fn() })
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { features: {} } })
}));

jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => ({ apps: [{ id: 'chat', name: { en: 'Chat' }, icon: 'chat' }], loading: false })
}));

jest.mock('../../../client/src/shared/hooks/useAuthKey', () => ({
  __esModule: true,
  default: () => 'anon'
}));

jest.mock('../../../client/src/shared/hooks/useFavorites', () => ({
  __esModule: true,
  default: () => ({ favorites: [] })
}));

// `runtimeBasePath` reads `import.meta.env`, which the CJS test transform
// cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: path => path,
  getBasePath: () => '',
  KNOWN_ROUTES: []
}));

// Leaf components that reach for browser APIs jsdom does not provide.
jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: () => null
}));
jest.mock('../../../client/src/features/prompts/components/PromptSearch', () => () => null);
jest.mock('../../../client/src/features/chat/components/WorkflowMentionSearch', () => () => null);
jest.mock('../../../client/src/features/upload/components', () => ({
  UnifiedUploader: () => null,
  CloudStoragePicker: () => null,
  AttachedFilesList: () => null
}));

const StartPage = require('../../../client/src/features/apps/pages/StartPage').default;
const { consumePendingChatStart } = require('../../../client/src/features/chat/startChatHandoff');

/** Render the page and wait for the default app's config + models to land. */
async function renderStartPage() {
  const utils = render(<StartPage />);
  await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());
  return utils;
}

/** Open the chat input's `+` actions menu. */
function openActionsMenu() {
  fireEvent.click(screen.getByTitle('Actions menu'));
  return screen.getByRole('menu');
}

/** The row labelled `text` (role=menuitemcheckbox carries its state). */
function toolRow(text) {
  return within(screen.getByRole('menu')).getByText(text).closest('[role="menuitemcheckbox"]');
}

describe('start page chat input features', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockPreferences.current = null;
    api.saveIntegrationPreferences.mockClear();
    sessionStorage.clear();
    consumePendingChatStart('chat'); // drop any handoff a previous case left
  });

  it('offers the web search toggle', async () => {
    await renderStartPage();
    openActionsMenu();

    expect(toolRow('Web Search')).toHaveAttribute('aria-checked', 'false');
    // Transcription is a model to select now, not a toggle.
    expect(screen.queryByText('Transcription')).toBeNull();

    fireEvent.click(toolRow('Web Search'));
    expect(toolRow('Web Search')).toHaveAttribute('aria-checked', 'true');
  });

  it("starts the app's tools switched on and lets them be toggled", async () => {
    await renderStartPage();
    openActionsMenu();

    await within(screen.getByRole('menu')).findByText('Brave Search');
    expect(toolRow('Brave Search')).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toolRow('Brave Search'));
    expect(toolRow('Brave Search')).toHaveAttribute('aria-checked', 'false');
  });

  it('carries the picked features into the app when the chat starts', async () => {
    await renderStartPage();
    openActionsMenu();
    fireEvent.click(toolRow('Web Search'));

    await within(screen.getByRole('menu')).findByText('Jira');
    fireEvent.click(toolRow('Jira'));

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('textbox').closest('form'));
    });

    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining('/apps/chat?prefill=hello'));
    expect(consumePendingChatStart('chat')).toMatchObject({
      appId: 'chat',
      settings: { websearchEnabled: true, enabledTools: ['braveSearch'] }
    });
  });

  it("does not start the chat before the user's default is in, and keeps the draft", async () => {
    let answer;
    api.fetchIntegrationPreferences.mockImplementationOnce(
      () => new Promise(resolve => (answer = resolve))
    );
    await renderStartPage();
    await waitFor(() => expect(api.fetchIntegrationPreferences).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('textbox').closest('form'));
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('hello');

    await act(async () => {
      answer({
        stored: true,
        available: true,
        preferences: { enabledTools: ['jira'], websearchEnabled: true, integrationScopes: {} }
      });
    });
    await act(async () => {
      fireEvent.submit(screen.getByRole('textbox').closest('form'));
    });
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining('/apps/chat?prefill=hello'));
    expect(consumePendingChatStart('chat')).toMatchObject({
      settings: { websearchEnabled: true, enabledTools: ['jira'] }
    });
  });

  it("seeds the toggles from the user's default for the app, kept on the server", async () => {
    mockPreferences.current = {
      stored: true,
      available: true,
      preferences: { enabledTools: ['jira'], websearchEnabled: true, integrationScopes: {} }
    };

    await renderStartPage();
    await waitFor(() => expect(api.fetchIntegrationPreferences).toHaveBeenCalled());
    openActionsMenu();

    await within(screen.getByRole('menu')).findByText('Brave Search');
    await waitFor(() => expect(toolRow('Web Search')).toHaveAttribute('aria-checked', 'true'));
    expect(toolRow('Brave Search')).toHaveAttribute('aria-checked', 'false');
    expect(toolRow('Jira')).toHaveAttribute('aria-checked', 'true');
  });

  it('imports what this browser kept once, then forgets it', async () => {
    sessionStorage.setItem(
      'ai_hub_app_settings_chat',
      JSON.stringify({ websearchEnabled: true, enabledTools: ['jira'], selectedStyle: 'concise' })
    );

    await renderStartPage();
    await waitFor(() => expect(api.saveIntegrationPreferences).toHaveBeenCalled());
    expect(api.saveIntegrationPreferences).toHaveBeenCalledWith(
      'chat',
      { websearchEnabled: true, enabledTools: ['jira'] },
      { importOnce: true }
    );
    openActionsMenu();
    await within(screen.getByRole('menu')).findByText('Brave Search');
    await waitFor(() => expect(toolRow('Jira')).toHaveAttribute('aria-checked', 'true'));
    expect(toolRow('Brave Search')).toHaveAttribute('aria-checked', 'false');
    const kept = JSON.parse(sessionStorage.getItem('ai_hub_app_settings_chat'));
    expect(kept).toEqual({ selectedStyle: 'concise' });
  });
});
