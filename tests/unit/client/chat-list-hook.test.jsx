import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('../../../client/src/api', () => ({ fetchChats: jest.fn() }));
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: jest.fn()
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: jest.fn()
}));

import { fetchChats } from '../../../client/src/api';
import { useAuth } from '../../../client/src/shared/contexts/AuthContext';
import { usePlatformConfig } from '../../../client/src/shared/contexts/PlatformConfigContext';
import useChats, {
  CHATS_PAGE_SIZE,
  invalidateChatsCache,
  useChatPersistence
} from '../../../client/src/shared/hooks/useChats';

/**
 * `useChats` backs three surfaces at once — the sidebar's Recents, the start
 * page chips and `/chats` — so it has to serve them from one request, and it
 * has to stay completely quiet for the viewers who have no stored chats at
 * all. Calling `/api/chats` as an anonymous viewer 401s, and the API client
 * turns a 401 into `authTokenExpired`, which signs the person out of the
 * session they are sitting in. These tests pin both halves.
 */

const CHATS = [
  { id: 'chat-a', appId: 'chat', lastMessageAt: '2026-03-15T09:00:00.000Z' },
  { id: 'chat-b', appId: 'translator', lastMessageAt: '2026-03-14T09:00:00.000Z' }
];

const authed = { user: { id: 'u1' }, isAuthenticated: true, isLoading: false };
const anonymous = { user: { id: 'anonymous' }, isAuthenticated: false, isLoading: false };
const persistenceOn = { platformConfig: { chats: { persistence: true } }, isLoading: false };

const page = (items, nextCursor = null) => ({ items, nextCursor });

beforeEach(() => {
  invalidateChatsCache();
  fetchChats.mockReset();
  useAuth.mockReturnValue(authed);
  usePlatformConfig.mockReturnValue(persistenceOn);
});

describe('useChatPersistence', () => {
  test('is on only for a signed-in viewer of an installation that stores chats', () => {
    const { result } = renderHook(() => useChatPersistence());
    expect(result.current).toBe(true);
  });

  test('is off for an anonymous viewer, who never owns a stored chat', () => {
    useAuth.mockReturnValue(anonymous);
    const { result } = renderHook(() => useChatPersistence());
    expect(result.current).toBe(false);
  });

  test('is off when the platform is not storing chats, absent block included', () => {
    usePlatformConfig.mockReturnValue({ platformConfig: {}, isLoading: false });
    expect(renderHook(() => useChatPersistence()).result.current).toBe(false);

    usePlatformConfig.mockReturnValue({
      platformConfig: { chats: { persistence: false } },
      isLoading: false
    });
    expect(renderHook(() => useChatPersistence()).result.current).toBe(false);
  });

  test('is off while the platform config is still loading', () => {
    usePlatformConfig.mockReturnValue({ platformConfig: null, isLoading: true });
    expect(renderHook(() => useChatPersistence()).result.current).toBe(false);
  });
});

describe('useChats', () => {
  test('three consumers mounted together issue a single request', async () => {
    fetchChats.mockResolvedValue(page(CHATS));
    const sidebar = renderHook(() => useChats());
    const startPage = renderHook(() => useChats());
    const historyPage = renderHook(() => useChats());

    await waitFor(() => expect(sidebar.result.current.loading).toBe(false));
    await waitFor(() => expect(historyPage.result.current.loading).toBe(false));

    expect(fetchChats).toHaveBeenCalledTimes(1);
    expect(fetchChats).toHaveBeenCalledWith({ limit: CHATS_PAGE_SIZE });
    expect(sidebar.result.current.chats).toEqual(CHATS);
    expect(startPage.result.current.chats).toEqual(CHATS);
    expect(historyPage.result.current.chats).toEqual(CHATS);
  });

  test('an anonymous viewer never reaches the endpoint and is not left loading', async () => {
    useAuth.mockReturnValue(anonymous);
    const { result } = renderHook(() => useChats());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchChats).not.toHaveBeenCalled();
    expect(result.current.chats).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.hasMore).toBe(false);
  });

  test('an installation that does not store chats never reaches the endpoint', async () => {
    usePlatformConfig.mockReturnValue({ platformConfig: {}, isLoading: false });
    const { result } = renderHook(() => useChats());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchChats).not.toHaveBeenCalled();
    expect(result.current.chats).toEqual([]);
  });

  test('waits for authentication and the platform config to resolve', async () => {
    useAuth.mockReturnValue({ user: null, isAuthenticated: false, isLoading: true });
    usePlatformConfig.mockReturnValue({ platformConfig: null, isLoading: true });
    fetchChats.mockResolvedValue(page(CHATS));
    const { result, rerender } = renderHook(() => useChats());

    expect(fetchChats).not.toHaveBeenCalled();

    useAuth.mockReturnValue(authed);
    usePlatformConfig.mockReturnValue(persistenceOn);
    rerender();

    await waitFor(() => expect(result.current.chats).toEqual(CHATS));
    expect(fetchChats).toHaveBeenCalledTimes(1);
  });

  test('signing out stops the hook without another request', async () => {
    fetchChats.mockResolvedValue(page(CHATS));
    const { result, rerender } = renderHook(() => useChats());
    await waitFor(() => expect(result.current.chats).toEqual(CHATS));

    useAuth.mockReturnValue(anonymous);
    rerender();

    expect(result.current.chats).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(fetchChats).toHaveBeenCalledTimes(1);
  });

  test('invalidating the cache refetches once and updates every mounted consumer', async () => {
    fetchChats
      .mockResolvedValueOnce(page(CHATS))
      .mockResolvedValueOnce(page([{ id: 'chat-new' }, ...CHATS]));
    const sidebar = renderHook(() => useChats());
    const historyPage = renderHook(() => useChats());
    await waitFor(() => expect(historyPage.result.current.chats).toEqual(CHATS));

    act(() => {
      invalidateChatsCache();
    });

    await waitFor(() => expect(sidebar.result.current.chats).toHaveLength(3));
    expect(historyPage.result.current.chats).toHaveLength(3);
    expect(fetchChats).toHaveBeenCalledTimes(2);
  });

  test('a failed request surfaces the error and the next consumer tries again', async () => {
    fetchChats.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(page(CHATS));
    const first = renderHook(() => useChats());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.error).toBeInstanceOf(Error);
    expect(first.result.current.chats).toEqual([]);

    const second = renderHook(() => useChats());
    await waitFor(() => expect(second.result.current.chats).toEqual(CHATS));
    expect(fetchChats).toHaveBeenCalledTimes(2);
  });

  test('loadMore appends the cursor page and stops when the cursor runs out', async () => {
    fetchChats
      .mockResolvedValueOnce(page(CHATS, 'cursor-1'))
      // The overlap is what a concurrently-appended chat looks like: it must
      // not be listed twice.
      .mockResolvedValueOnce(page([CHATS[1], { id: 'chat-c' }], null));
    const { result } = renderHook(() => useChats());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(fetchChats).toHaveBeenLastCalledWith({ limit: CHATS_PAGE_SIZE, cursor: 'cursor-1' });
    expect(result.current.chats.map(c => c.id)).toEqual(['chat-a', 'chat-b', 'chat-c']);
    expect(result.current.hasMore).toBe(false);
  });

  test('loadMore on the last page is a no-op', async () => {
    fetchChats.mockResolvedValue(page(CHATS));
    const { result } = renderHook(() => useChats());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(fetchChats).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
  });

  test('a different viewer gets their own list', async () => {
    fetchChats.mockResolvedValueOnce(page(CHATS)).mockResolvedValueOnce(page([{ id: 'other' }]));
    const { result, rerender } = renderHook(() => useChats());
    await waitFor(() => expect(result.current.chats).toEqual(CHATS));

    useAuth.mockReturnValue({ user: { id: 'u2' }, isAuthenticated: true, isLoading: false });
    rerender();

    await waitFor(() => expect(result.current.chats).toEqual([{ id: 'other' }]));
    expect(fetchChats).toHaveBeenCalledTimes(2);
  });
});
