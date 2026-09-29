import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The chat history in the Outlook task pane (issue #2598): the user's stored
 * chats — started in the pane or in the browser — so an earlier conversation
 * can be picked up while answering or writing an email.
 *
 * Pinned here: which chats the pane lists (only those it can continue, i.e.
 * whose app it offers), how they are grouped and searched, and the page's
 * contract with OfficeApp — which row it hands over when one is picked.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
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
const mockFetchChats = jest.fn();
jest.mock('../../../client/src/api', () => ({
  fetchApps: (...args) => mockFetchApps(...args),
  fetchChats: (...args) => mockFetchChats(...args)
}));

jest.mock('../../../client/src/features/office/components/settings-dialog', () => ({
  __esModule: true,
  default: () => null
}));

const {
  resolveOfficeChats,
  filterOfficeChats,
  groupOfficeChats,
  formatOfficeChatTime,
  officeChatsKey
} = require('../../../client/src/features/office/utilities/officeChatHistory');
const OfficeChatHistoryPage =
  require('../../../client/src/features/office/components/chat-history').default;
const {
  OFFICE_CHATS_AUTO_PAGES
} = require('../../../client/src/features/office/hooks/useOfficeChats');
const { invalidateChatsCache } = require('../../../client/src/shared/hooks/chatListStore');

const apps = [
  { id: 'mail', name: { en: 'Mail Assistant', de: 'Mail-Assistent' }, color: '#123456' },
  { id: 'translator', name: { en: 'Translator' } }
];

// Local noon, so "today" and "yesterday" do not depend on the hour the suite runs.
const NOW = new Date(2026, 8, 29, 12, 0, 0);
const daysAgo = days => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const chats = [
  { id: 'c1', appId: 'mail', title: 'Reply to ACME', lastMessageAt: daysAgo(0), messageCount: 4 },
  { id: 'c2', appId: 'gone', title: 'App was deleted', lastMessageAt: daysAgo(0) },
  { id: 'c3', appId: 'translator', title: '  ', lastMessageAt: daysAgo(1) },
  { id: 'c4', appId: 'mail', title: 'Offer for Globex', lastMessageAt: daysAgo(3) },
  { id: 'c5', appId: 'translator', title: 'Contract terms', lastMessageAt: daysAgo(30) }
];

describe('officeChatHistory', () => {
  test('joins each chat with its app and leaves out chats the pane cannot open', () => {
    const rows = resolveOfficeChats(chats, apps, 'de');
    expect(rows.map(row => row.id)).toEqual(['c1', 'c3', 'c4', 'c5']);
    expect(rows[0]).toMatchObject({
      app: apps[0],
      appName: 'Mail-Assistent',
      title: 'Reply to ACME'
    });
    // A blank title is no title: the row falls back to "Untitled chat".
    expect(rows[1].title).toBe('');
    expect(resolveOfficeChats(null, apps, 'en')).toEqual([]);
    expect(resolveOfficeChats(chats, null, 'en')).toEqual([]);
  });

  test('search matches the title or the app name, ignoring case', () => {
    const rows = resolveOfficeChats(chats, apps, 'en');
    expect(filterOfficeChats(rows, 'globex').map(row => row.id)).toEqual(['c4']);
    expect(filterOfficeChats(rows, 'TRANSLATOR').map(row => row.id)).toEqual(['c3', 'c5']);
    expect(filterOfficeChats(rows, '   ')).toBe(rows);
  });

  test('groups by recency in a fixed order, keeping the list order inside a group', () => {
    const groups = groupOfficeChats(resolveOfficeChats(chats, apps, 'en'), NOW);
    expect(groups.map(({ group, rows }) => [group, rows.map(row => row.id)])).toEqual([
      ['today', ['c1']],
      ['yesterday', ['c3']],
      ['last7days', ['c4']],
      ['older', ['c5']]
    ]);
  });

  test('a chat from today shows its time, an older one its date', () => {
    const today = new Date(2026, 8, 29, 9, 5).toISOString();
    expect(formatOfficeChatTime(today, 'en', NOW)).toMatch(/9|09/);
    expect(formatOfficeChatTime(daysAgo(30), 'en', NOW)).toMatch(/Aug/);
    expect(formatOfficeChatTime('not a date', 'en', NOW)).toBe('');
    expect(formatOfficeChatTime(undefined, 'en', NOW)).toBe('');
  });

  test('the list is keyed by the signed-in user (the userinfo `sub`)', () => {
    expect(officeChatsKey({ sub: 'ada', name: 'Ada' })).toBe('office:ada');
    expect(officeChatsKey({ id: 'ada' })).toBe('office:ada');
    expect(officeChatsKey(null)).toBe('office:');
  });
});

describe('<OfficeChatHistoryPage />', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'setInterval', 'queueMicrotask'] });
    mockFetchApps.mockReset();
    mockFetchChats.mockReset();
    invalidateChatsCache();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const renderPage = () => {
    const handlers = { onBack: jest.fn(), onOpenChat: jest.fn(), onLogout: jest.fn() };
    render(
      <OfficeChatHistoryPage user={{ id: 'ada' }} backLabel="Back to start page" {...handlers} />
    );
    return handlers;
  };

  test('lists the chats by recency and opens the one picked', async () => {
    mockFetchApps.mockResolvedValue(apps);
    mockFetchChats.mockResolvedValue({ items: chats, nextCursor: null });
    const { onOpenChat, onBack } = renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    const today = await screen.findByRole('region', { name: 'Today' });
    expect(within(today).getByText('Reply to ACME')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Yesterday' })).toHaveTextContent('Untitled chat');
    expect(screen.getByRole('region', { name: 'Last 7 days' })).toHaveTextContent(
      'Offer for Globex'
    );
    expect(screen.getByRole('region', { name: 'Older' })).toHaveTextContent('Contract terms');
    expect(screen.queryByText('App was deleted')).not.toBeInTheDocument();
    expect(mockFetchChats).toHaveBeenCalledWith(expect.objectContaining({ limit: 30 }));

    fireEvent.click(screen.getByRole('button', { name: /Offer for Globex/ }));
    expect(onOpenChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c4', chat: chats[3], app: apps[0] })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back to start page' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test('search narrows the loaded chats, and says so when nothing matches', async () => {
    mockFetchApps.mockResolvedValue(apps);
    mockFetchChats.mockResolvedValue({ items: chats, nextCursor: null });
    renderPage();
    await screen.findByRole('region', { name: 'Today' });

    const search = screen.getByRole('searchbox', { name: 'Search your chats…' });
    fireEvent.change(search, { target: { value: 'contract' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Contract terms')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'nothing like this' } });
    expect(screen.getByText('No chats match your search')).toBeInTheDocument();
  });

  test('reads older pages on its own while the loaded ones hold no chat it can open', async () => {
    mockFetchApps.mockResolvedValue(apps);
    const elsewhere = id => ({ id, appId: 'web-only', title: id, lastMessageAt: daysAgo(0) });
    mockFetchChats
      .mockResolvedValueOnce({ items: [elsewhere('w1'), elsewhere('w2')], nextCursor: 'p2' })
      .mockResolvedValueOnce({ items: [chats[3]], nextCursor: 'p3' });
    renderPage();

    expect(await screen.findByText('Offer for Globex')).toBeInTheDocument();
    expect(mockFetchChats).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'p2' }));
    // One row is enough: the rest waits for "Show older chats".
    expect(mockFetchChats).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('No chats yet')).not.toBeInTheDocument();
  });

  test('stops paging on its own after a few pages, and does not call that empty', async () => {
    mockFetchApps.mockResolvedValue(apps);
    let n = 0;
    mockFetchChats.mockImplementation(async () => {
      n += 1;
      return {
        items: [{ id: `w${n}`, appId: 'web-only', lastMessageAt: daysAgo(0) }],
        nextCursor: `p${n + 1}`
      };
    });
    renderPage();

    expect(
      await screen.findByText('None of your latest chats is in an app available here.')
    ).toBeInTheDocument();
    // The first page plus the automatic ones, then it is the user's call.
    expect(mockFetchChats).toHaveBeenCalledTimes(1 + OFFICE_CHATS_AUTO_PAGES);
    expect(screen.queryByText('No chats yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show older chats' })).toBeInTheDocument();
  });

  test('pages further back with "Show older chats"', async () => {
    mockFetchApps.mockResolvedValue(apps);
    mockFetchChats
      .mockResolvedValueOnce({ items: chats.slice(0, 2), nextCursor: 'next' })
      .mockResolvedValueOnce({ items: chats.slice(2), nextCursor: null });
    renderPage();
    await screen.findByText('Reply to ACME');

    fireEvent.click(screen.getByRole('button', { name: 'Show older chats' }));
    expect(await screen.findByText('Contract terms')).toBeInTheDocument();
    expect(mockFetchChats).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 30, cursor: 'next' })
    );
    expect(screen.queryByRole('button', { name: 'Show older chats' })).not.toBeInTheDocument();
  });

  test('an empty history explains itself', async () => {
    mockFetchApps.mockResolvedValue(apps);
    mockFetchChats.mockResolvedValue({ items: [], nextCursor: null });
    renderPage();
    expect(await screen.findByText('No chats yet')).toBeInTheDocument();
  });

  test('failed apps read as a failure with a retry, not as an empty history', async () => {
    mockFetchApps.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(apps);
    mockFetchChats.mockResolvedValue({ items: chats, nextCursor: null });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Your chats could not be loaded');
    expect(screen.queryByText('No chats yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Reply to ACME')).toBeInTheDocument();
    expect(mockFetchApps).toHaveBeenCalledTimes(2);
  });

  test('a failed "Show older chats" says so and keeps the rows', async () => {
    mockFetchApps.mockResolvedValue(apps);
    mockFetchChats
      .mockResolvedValueOnce({ items: chats.slice(0, 2), nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: chats.slice(2), nextCursor: null });
    renderPage();
    await screen.findByText('Reply to ACME');

    fireEvent.click(screen.getByRole('button', { name: 'Show older chats' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your chats could not be loaded');
    expect(screen.getByText('Reply to ACME')).toBeInTheDocument();

    // The button is the retry; a page that arrives clears the error.
    fireEvent.click(screen.getByRole('button', { name: 'Show older chats' }));
    expect(await screen.findByText('Contract terms')).toBeInTheDocument();
    expect(screen.getByText('Reply to ACME')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a failed load offers a retry that asks again', async () => {
    mockFetchApps.mockResolvedValue(apps);
    mockFetchChats
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ items: chats, nextCursor: null });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Your chats could not be loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Reply to ACME')).toBeInTheDocument());
  });
});
