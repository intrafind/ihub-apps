import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The Outlook task pane's start page (issue #2368): after sign-in the pane
 * lands on a greeting, the default app's chat input with the open email above
 * it, the app's starter prompts and a few app shortcuts — instead of the plain
 * app list. Everything configurable lives in `officeIntegration.startPage`,
 * which reaches the pane through the add-in config endpoint.
 *
 * These specs pin the pure helpers (where home is, which app answers, how the
 * shortcuts rank) and the component's contract with OfficeApp: what it hands
 * over when the user sends from the start page, opens an app, or asks for the
 * full list.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Interpolate `{{name}}` style placeholders so the greeting reads like it
    // does in the product.
    t: (key, defaultValue, options) => {
      const template = typeof defaultValue === 'string' ? defaultValue : key;
      const values = typeof defaultValue === 'object' ? defaultValue : options || {};
      return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => values[k] ?? '');
    },
    i18n: { language: 'en' }
  })
}));

// `runtimeBasePath` reads `import.meta.env`, which the CJS test transform
// cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: path => path,
  buildApiUrl: path => `/api/${path}`,
  getBasePath: () => '',
  KNOWN_ROUTES: []
}));

const mockFetchApps = jest.fn();
jest.mock('../../../client/src/api', () => ({
  fetchApps: (...args) => mockFetchApps(...args)
}));

let mockOfficeConfig = {};
jest.mock('../../../client/src/features/office/contexts/OfficeConfigContext', () => ({
  useOfficeConfig: () => mockOfficeConfig
}));

const mockSnapshotOverride = {
  available: true,
  itemId: 'ITEM-1',
  bodyText: 'Body',
  attachments: []
};
jest.mock('../../../client/src/features/office/hooks/useOutlookMailContextSnapshot', () => ({
  __esModule: true,
  default: () => ({
    loading: false,
    ctx: {
      available: true,
      itemId: 'ITEM-1',
      itemKind: 'message',
      bodyText: 'Body',
      attachments: []
    },
    visibleAttachments: [],
    removedAttachmentIds: new Set(),
    removeAttachment: jest.fn(),
    restoreAttachments: jest.fn(),
    buildSnapshotOverride: () => mockSnapshotOverride,
    includeBody: true,
    setIncludeBody: jest.fn(),
    generation: 0
  })
}));

const mockPinned = [{ itemId: 'ITEM-9', subject: 'Collected', bodyText: 'Hi', attachments: [] }];
jest.mock('../../../client/src/features/office/hooks/usePinnedEmails', () => ({
  __esModule: true,
  default: () => ({
    pinnedEmails: mockPinned,
    setPinnedEmails: jest.fn(),
    addEmails: jest.fn(),
    unpin: jest.fn(),
    clearPinned: jest.fn(),
    addEmailsLoading: false,
    multiSelectSupported: false
  })
}));

// The real input pulls in platform config, uploads and token estimation —
// none of which this page's contract depends on.
jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: ({ value, onChange, onSubmit, app }) => (
    <form data-testid="chat-input" data-app={app?.id} onSubmit={onSubmit}>
      <textarea aria-label="message" value={value} onChange={onChange} />
      <button type="submit">Send</button>
    </form>
  )
}));

jest.mock('../../../client/src/features/office/components/chat/OfficeContextStrip', () => ({
  __esModule: true,
  default: ({ pinned }) => <div data-testid="context-strip">{pinned?.length ?? 0} pinned</div>
}));

const {
  OFFICE_START_PAGE_PATH,
  OFFICE_APPS_PAGE_PATH,
  OFFICE_START_PAGE_APPS_COUNT,
  readOfficeStartPageConfig,
  resolveOfficeHomePath,
  pickOfficeDefaultApp,
  rankOfficeAppShortcuts
} = require('../../../client/src/features/office/utilities/officeStartPage');
const {
  buildOfficeStarterPrompts
} = require('../../../client/src/features/office/utilities/officeStarterPrompts');
const OfficeStartPage =
  require('../../../client/src/features/office/components/OfficeStartPage').default;

const apps = [
  { id: 'chat', name: { en: 'Chat' }, description: { en: 'General chat' }, order: 2, icon: 'chat' },
  { id: 'summarizer', name: { en: 'Summarizer' }, order: 1 },
  { id: 'translator', name: { en: 'Translator' }, order: 3 },
  { id: 'portal', name: { en: 'Portal' }, order: 0, type: 'iframe' },
  { id: 'writer', name: { en: 'Writer' }, order: 4 },
  { id: 'coder', name: { en: 'Coder' }, order: 5 }
];

const config = startPage => ({ startPage });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockOfficeConfig = {};
  mockFetchApps.mockReset();
});

describe('resolveOfficeHomePath', () => {
  test('the start page is home unless the admin picked the app list', () => {
    expect(OFFICE_START_PAGE_PATH).toBe('/start');
    expect(OFFICE_APPS_PAGE_PATH).toBe('/select');
    expect(resolveOfficeHomePath(undefined)).toBe('/start');
    expect(resolveOfficeHomePath({})).toBe('/start');
    expect(resolveOfficeHomePath(config({ defaultPage: 'start' }))).toBe('/start');
    expect(resolveOfficeHomePath(config({ defaultPage: 'apps' }))).toBe('/select');
    // A hand-edited value is not a dead end.
    expect(resolveOfficeHomePath(config({ defaultPage: 'page' }))).toBe('/start');
    expect(resolveOfficeHomePath(config('apps'))).toBe('/start');
  });
});

describe('readOfficeStartPageConfig', () => {
  test('normalizes every field', () => {
    expect(readOfficeStartPageConfig(undefined)).toEqual({
      defaultPage: 'start',
      defaultAppId: null,
      featuredAppIds: []
    });
    expect(
      readOfficeStartPageConfig(
        config({
          defaultPage: 'apps',
          defaultAppId: 'chat',
          featuredAppIds: ['a', '', 'b', 'a', 3]
        })
      )
    ).toEqual({ defaultPage: 'apps', defaultAppId: 'chat', featuredAppIds: ['a', 'b'] });
  });
});

describe('pickOfficeDefaultApp', () => {
  test('prefers the configured app, then falls back to the top-ranked chat app', () => {
    expect(pickOfficeDefaultApp(apps, [], config({ defaultAppId: 'translator' })).id).toBe(
      'translator'
    );
    // `portal` sorts first on order but has no chat to send a message to.
    expect(pickOfficeDefaultApp(apps, [], config({})).id).toBe('summarizer');
    // Favorites outrank the admin's order; the default apps outrank `order`.
    expect(pickOfficeDefaultApp(apps, ['writer'], config({})).id).toBe('writer');
    expect(pickOfficeDefaultApp(apps, [], config({ featuredAppIds: ['coder'] })).id).toBe('coder');
    // A configured app that is gone, not accessible or not a chat app falls back.
    expect(pickOfficeDefaultApp(apps, [], config({ defaultAppId: 'deleted' })).id).toBe(
      'summarizer'
    );
    expect(pickOfficeDefaultApp(apps, [], config({ defaultAppId: 'portal' })).id).toBe(
      'summarizer'
    );
    expect(pickOfficeDefaultApp([], [], config({}))).toBeNull();
  });
});

describe('rankOfficeAppShortcuts', () => {
  test('favorites, then the default apps in order, then the app order', () => {
    const ranked = rankOfficeAppShortcuts(apps, {
      favoriteAppIds: ['coder'],
      officeConfig: config({ featuredAppIds: ['writer', 'translator'] }),
      language: 'en'
    });
    expect(ranked.map(app => app.id)).toEqual([
      'coder',
      'writer',
      'translator',
      'portal',
      'summarizer',
      'chat'
    ]);
    // The input is left alone.
    expect(apps[0].id).toBe('chat');
  });
});

describe('buildOfficeStarterPrompts', () => {
  const officeConfig = {
    starterPrompts: [{ title: { en: 'Summarize' }, message: { en: 'Summarize this email' } }],
    calendarStarterPrompts: [{ title: { en: 'Agenda' }, message: { en: 'Draft an agenda' } }]
  };

  test("an app's own prompts win and only auto-send when they say so", () => {
    const app = {
      starterPrompts: [
        { id: 'p1', title: { en: 'Reply' }, message: { en: 'Reply politely' }, autoSend: true },
        { title: { en: 'Draft' }, message: { en: 'Draft an answer' } }
      ]
    };
    const prompts = buildOfficeStarterPrompts({ app, officeConfig, language: 'en' });
    expect(prompts.map(p => [p.key, p.label, p.message, p.autoSend])).toEqual([
      ['p1', 'Reply', 'Reply politely', true],
      ['1', 'Draft', 'Draft an answer', false]
    ]);
    expect(prompts[0].raw).toBe(app.starterPrompts[0]);
  });

  test('the Outlook defaults fill in and always auto-send; meetings get the calendar set', () => {
    const mail = buildOfficeStarterPrompts({ app: { id: 'chat' }, officeConfig, language: 'en' });
    expect(mail).toEqual([
      { key: 'office-0', label: 'Summarize', message: 'Summarize this email', autoSend: true }
    ]);
    const meeting = buildOfficeStarterPrompts({
      app: null,
      officeConfig,
      isAppointment: true,
      language: 'en'
    });
    expect(meeting.map(p => p.label)).toEqual(['Agenda']);
    expect(buildOfficeStarterPrompts({ app: null, officeConfig: {}, language: 'en' })).toEqual([]);
  });
});

describe('<OfficeStartPage />', () => {
  const user = { name: 'Ada Lovelace', email: 'ada@example.com' };

  const renderPage = (props = {}) => {
    const handlers = {
      onLogout: jest.fn(),
      onSelectApp: jest.fn(),
      onStartChat: jest.fn(),
      onBrowseApps: jest.fn(),
      ...props
    };
    render(<OfficeStartPage user={user} {...handlers} />);
    return handlers;
  };

  test('greets the user, shows the configured default app and the shortcuts', async () => {
    mockOfficeConfig = {
      displayName: { en: 'Mail Assistant' },
      startPage: { defaultAppId: 'chat', featuredAppIds: ['writer'] },
      starterPrompts: [{ title: { en: 'Summarize' }, message: { en: 'Summarize this email' } }]
    };
    mockFetchApps.mockResolvedValue(apps);
    localStorage.setItem('office_favoriteApps', JSON.stringify(['coder']));

    renderPage();

    // The pane title stays the h1; the greeting heads the content below it.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Mail Assistant');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/Ada Lovelace/);

    const input = await screen.findByTestId('chat-input');
    expect(input).toHaveAttribute('data-app', 'chat');
    // The email context sits above the input, with the collected emails.
    expect(screen.getByTestId('context-strip')).toHaveTextContent('1 pinned');
    // The default app's name is shown once, on its label — not again as a shortcut.
    expect(screen.getByText('Chat')).toBeInTheDocument();

    const shortcuts = screen.getByRole('list').querySelectorAll('li');
    const names = [...shortcuts].map(li => li.textContent);
    expect(shortcuts.length).toBeLessThanOrEqual(OFFICE_START_PAGE_APPS_COUNT);
    // Favorites first, then the admin's default apps, then the rest by order.
    expect(names[0]).toMatch(/^Coder/);
    expect(names[1]).toMatch(/^Writer/);
    expect(names.some(n => /^Chat/.test(n))).toBe(false);

    // Starter prompts of the Outlook defaults are offered under the input.
    expect(screen.getByRole('button', { name: 'Summarize' })).toBeInTheDocument();
  });

  test('sending from the start page hands the app the message, the collected emails and the edited email context', async () => {
    mockOfficeConfig = { startPage: { defaultAppId: 'chat' } };
    mockFetchApps.mockResolvedValue(apps);
    const { onStartChat } = renderPage();

    const input = await screen.findByTestId('chat-input');
    // Whitespace alone is not a message.
    fireEvent.change(screen.getByLabelText('message'), { target: { value: '   ' } });
    fireEvent.submit(input);
    expect(onStartChat).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('message'), { target: { value: '  Reply politely ' } });
    fireEvent.submit(input);

    expect(onStartChat).toHaveBeenCalledTimes(1);
    expect(onStartChat).toHaveBeenCalledWith({
      app: expect.objectContaining({ id: 'chat' }),
      text: 'Reply politely',
      pinnedEmails: mockPinned,
      hostContextOverride: mockSnapshotOverride,
      autoSend: true
    });
  });

  test('a default Outlook prompt fires; an app prompt without autoSend only prefills', async () => {
    mockOfficeConfig = {
      startPage: { defaultAppId: 'chat' },
      starterPrompts: [{ title: { en: 'Summarize' }, message: { en: 'Summarize this email' } }]
    };
    mockFetchApps.mockResolvedValue(apps);
    const { onStartChat } = renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect(onStartChat).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Summarize this email',
        autoSend: true,
        starterPrompt: null
      })
    );
  });

  test("an app's own prompt that does not auto-send opens the app with the text ready", async () => {
    const draftPrompt = { title: { en: 'Draft' }, message: { en: 'Draft an answer' } };
    mockOfficeConfig = { startPage: { defaultAppId: 'chat' } };
    mockFetchApps.mockResolvedValue([{ ...apps[0], starterPrompts: [draftPrompt] }]);
    const { onStartChat } = renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    expect(onStartChat).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Draft an answer',
        autoSend: false,
        starterPrompt: draftPrompt
      })
    );
  });

  test('shortcuts, "Open app" and "All apps" lead where they say', async () => {
    mockOfficeConfig = { startPage: { defaultAppId: 'chat' } };
    mockFetchApps.mockResolvedValue(apps);
    const { onSelectApp, onBrowseApps, onStartChat } = renderPage();

    await screen.findByTestId('chat-input');

    fireEvent.click(screen.getByRole('button', { name: /Open app/ }));
    expect(onSelectApp).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'chat' }));

    fireEvent.click(screen.getByRole('button', { name: /^Summarizer/ }));
    expect(onSelectApp).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'summarizer' }));

    fireEvent.click(screen.getByRole('button', { name: /All apps/ }));
    expect(onBrowseApps).toHaveBeenCalledTimes(1);
    expect(onStartChat).not.toHaveBeenCalled();
  });

  test('without a chat app there is no input; a failed load says so', async () => {
    mockOfficeConfig = {};
    mockFetchApps.mockResolvedValue([apps[3]]); // only the iframe app
    renderPage();
    await waitFor(() => expect(screen.getByRole('list')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument();

    mockFetchApps.mockRejectedValue(new Error('offline'));
    render(
      <OfficeStartPage
        user={user}
        onLogout={jest.fn()}
        onSelectApp={jest.fn()}
        onStartChat={jest.fn()}
        onBrowseApps={jest.fn()}
      />
    );
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
  });
});
