import { act, renderHook } from '@testing-library/react';
import { fetchScheduledTaskNotifications } from '../../../client/src/api';
import { useScheduledTaskNotifications } from '../../../client/src/features/tasks/hooks/useScheduledTasks';

/**
 * The unseen-run notifications live in one store shared by the sidebar badge
 * and the toast, for the life of the page. A sign-out and a sign-in as someone
 * else in the same page must not show the next account the previous one's
 * tasks — not even for the moment before the new list arrives.
 */

let mockViewer = { isAuthenticated: true, user: { id: 'user-a' } };

jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useOptionalAuth: () => mockViewer
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({
    isLoading: false,
    platformConfig: { scheduledTasks: { enabled: true } }
  })
}));

jest.mock('../../../client/src/api', () => ({
  fetchScheduledTaskNotifications: jest.fn(),
  markScheduledTaskNotificationsSeen: jest.fn()
}));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useScheduledTaskNotifications', () => {
  it("never shows the next account the previous one's unseen runs", async () => {
    fetchScheduledTaskNotifications.mockResolvedValueOnce({
      items: [{ id: 'r1', taskId: 'st-a', taskName: "A's digest" }]
    });
    const { result, rerender } = renderHook(() => useScheduledTaskNotifications());
    await flush();
    expect(result.current.items.map(item => item.taskName)).toEqual(["A's digest"]);

    // Signed out and back in as B, without a page load; B's list fails to load.
    fetchScheduledTaskNotifications.mockRejectedValueOnce(new Error('offline'));
    mockViewer = { isAuthenticated: true, user: { id: 'user-b' } };
    rerender();
    expect(result.current.items).toEqual([]);
    await flush();
    expect(result.current.items).toEqual([]);
    expect(fetchScheduledTaskNotifications).toHaveBeenCalledTimes(2);
  });
});
