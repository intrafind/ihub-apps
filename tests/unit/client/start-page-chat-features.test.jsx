import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
  useNavigate: () => mockNavigate
}));

const mockApp = {
  id: 'chat',
  name: { en: 'Chat' },
  description: { en: 'General chat' },
  color: '#4f46e5',
  icon: 'chat',
  tools: ['braveSearch', 'jira'],
  websearch: { enabled: true, enabledByDefault: false },
  transcription: { enabled: true, defaultEnabled: true },
  features: { magicPrompt: { enabled: true } }
};

const mockModelList = [{ id: 'gpt', name: { en: 'GPT' } }];

jest.mock('../../../client/src/api', () => ({
  fetchAppDetails: jest.fn(() => Promise.resolve(mockApp)),
  fetchModels: jest.fn(() => Promise.resolve(mockModelList)),
  // The server localizes tool metadata, so names arrive as plain strings.
  fetchToolsBasic: jest.fn(() =>
    Promise.resolve([
      { id: 'braveSearch', name: 'Brave Search' },
      { id: 'jira', name: 'Jira' }
    ])
  ),
  generateMagicPrompt: jest.fn(() => Promise.resolve({ prompt: 'enhanced' }))
}));

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

/** The switch belonging to the menu row labelled `text`. */
function switchFor(text) {
  let node = screen.getByText(text);
  while (node && !node.querySelector?.('input[type="checkbox"]')) node = node.parentElement;
  return node?.querySelector('input[type="checkbox"]');
}

/** The tool row labelled `text` (role=menuitemcheckbox carries its state). */
function toolRow(text) {
  return screen.getByText(text).closest('[role="menuitemcheckbox"]');
}

describe('start page chat input features', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    sessionStorage.clear();
    consumePendingChatStart('chat'); // drop any handoff a previous case left
  });

  it('offers the web search and transcription toggles', async () => {
    await renderStartPage();
    openActionsMenu();

    expect(switchFor('Web Search')).not.toBeChecked();
    expect(switchFor('Transcription')).toBeChecked();

    fireEvent.click(switchFor('Web Search'));
    expect(switchFor('Web Search')).toBeChecked();
  });

  it("starts the app's tools switched on and lets them be toggled", async () => {
    await renderStartPage();
    openActionsMenu();

    await screen.findByText('Brave Search');
    expect(toolRow('Brave Search')).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toolRow('Brave Search'));
    expect(toolRow('Brave Search')).toHaveAttribute('aria-checked', 'false');
  });

  it('carries the picked features into the app when the chat starts', async () => {
    await renderStartPage();
    openActionsMenu();
    fireEvent.click(switchFor('Web Search'));

    await screen.findByText('Jira');
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

  it('seeds the toggles from settings the viewer already chose for the app', async () => {
    sessionStorage.setItem(
      'ai_hub_app_settings_chat',
      JSON.stringify({ websearchEnabled: true, enabledTools: ['jira'] })
    );

    await renderStartPage();
    openActionsMenu();

    expect(switchFor('Web Search')).toBeChecked();
    await screen.findByText('Brave Search');
    expect(toolRow('Brave Search')).toHaveAttribute('aria-checked', 'false');
    expect(toolRow('Jira')).toHaveAttribute('aria-checked', 'true');
  });
});
