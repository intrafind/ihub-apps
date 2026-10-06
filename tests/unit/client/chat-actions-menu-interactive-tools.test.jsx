import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * Interactive clarification tools are hidden from the `+` actions menu.
 *
 * `ask_user` (and any tool flagged `requiresUserInput`) is a system channel the
 * agent loop drives to ask the user a question — the model always has it when
 * the app grants it (server-side getToolsForApp keeps it whatever `enabledTools`
 * says). Surfacing it as a toggle only let a user disable the model's ability to
 * ask, which made interviews loop. These tests pin that the menu never renders a
 * row for it, while ordinary tools still appear.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => defaultValue || key,
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`}>{name}</span>;
  };
});

jest.mock('../../../client/src/shared/components/MagicPromptLoader', () => {
  return function MagicPromptLoader() {
    return <span>loading</span>;
  };
});

jest.mock('../../../client/src/features/chat/components/ImageGenerationControls', () => {
  return function ImageGenerationControls() {
    return <div />;
  };
});

jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: function VoiceInputComponent() {
    return <button type="button">voice</button>;
  }
}));

const mockFetchToolsBasic = jest.fn();
jest.mock('../../../client/src/api', () => ({
  fetchToolsBasic: (...args) => mockFetchToolsBasic(...args)
}));

jest.mock('../../../client/src/utils/toolUsageTracker', () => ({
  trackToolUsage: jest.fn()
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({
    platformConfig: { cloudStorage: { enabled: false, providers: [] } }
  })
}));

jest.mock('../../../client/src/features/office/contexts/EmbeddedHostContext', () => ({
  useEmbeddedHost: () => null
}));

const ChatInputActionsMenu =
  require('../../../client/src/features/chat/components/ChatInputActionsMenu').default;

const ASK_USER = {
  id: 'ask_user',
  requiresUserInput: true,
  name: 'Ask User for Clarification',
  description: 'Ask the user a clarifying question.'
};
const BRAVE = { id: 'braveSearch', name: 'Brave Search', description: 'Search the web.' };

async function openMenu(props = {}) {
  const utils = render(
    <ChatInputActionsMenu
      app={{ id: 'demo', tools: ['ask_user', 'braveSearch'] }}
      enabledTools={['ask_user', 'braveSearch']}
      uploadConfig={{}}
      {...props}
    />
  );
  // Tools load asynchronously via the mocked fetchToolsBasic.
  await waitFor(() => expect(mockFetchToolsBasic).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Actions menu' }));
  return utils;
}

describe('ChatInputActionsMenu interactive tools', () => {
  beforeEach(() => {
    mockFetchToolsBasic.mockReset();
    mockFetchToolsBasic.mockResolvedValue([ASK_USER, BRAVE]);
  });

  it('renders ordinary tools but never the ask_user clarification row', async () => {
    await openMenu();

    // The ordinary tool shows up once its metadata resolves.
    expect(await screen.findByText('Brave Search')).toBeInTheDocument();
    // The interactive clarification tool is filtered out entirely.
    expect(screen.queryByText('Ask User for Clarification')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitemcheckbox', { name: /Ask User for Clarification/ })
    ).not.toBeInTheDocument();
  });

  it('hides any requiresUserInput tool, not only the literal ask_user id', async () => {
    mockFetchToolsBasic.mockResolvedValue([
      { id: 'custom_prompt', requiresUserInput: true, name: 'Custom Prompt', description: '' },
      BRAVE
    ]);

    await openMenu({ app: { id: 'demo', tools: ['custom_prompt', 'braveSearch'] } });

    expect(await screen.findByText('Brave Search')).toBeInTheDocument();
    expect(screen.queryByText('Custom Prompt')).not.toBeInTheDocument();
  });

  it('shows no actions menu when the only tool is the clarification channel', async () => {
    mockFetchToolsBasic.mockResolvedValue([ASK_USER]);

    render(
      <ChatInputActionsMenu
        app={{ id: 'demo', tools: ['ask_user'] }}
        enabledTools={['ask_user']}
        uploadConfig={{}}
      />
    );
    // Let the async tool load settle so the assertion holds after re-render.
    await waitFor(() => expect(mockFetchToolsBasic).toHaveBeenCalled());

    // No selectable tool and no other action, so the `+` button never renders.
    expect(screen.queryByRole('button', { name: 'Actions menu' })).not.toBeInTheDocument();
  });
});
