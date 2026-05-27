import { useState, useEffect } from 'react';
import { fetchAdminApps, makeAdminApiCall } from '../../../api/adminApi';

/**
 * Fetches and computes data for the admin Overview dashboard.
 * Uses Promise.allSettled so individual endpoint failures don't block others.
 */
export function useOverviewData() {
  const [stats, setStats] = useState(null);
  const [attentionItems, setAttentionItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFreshInstance, setIsFreshInstance] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const [appsResult, usersResult, timelineResult, versionResult, updateResult] =
        await Promise.allSettled([
          fetchAdminApps(),
          makeAdminApiCall('/admin/usage/users'),
          makeAdminApiCall('/admin/usage/timeline'),
          makeAdminApiCall('/admin/version'),
          makeAdminApiCall('/admin/version/check-update')
        ]);

      if (cancelled) return;

      const apps = appsResult.status === 'fulfilled' ? appsResult.value : [];
      const usersData = usersResult.status === 'fulfilled' ? usersResult.value?.data : null;
      const timelineData =
        timelineResult.status === 'fulfilled' ? timelineResult.value?.data : null;
      const versionData = versionResult.status === 'fulfilled' ? versionResult.value?.data : null;
      const updateData = updateResult.status === 'fulfilled' ? updateResult.value?.data : null;

      const appCount = Array.isArray(apps) ? apps.length : 0;
      const enabledApps = Array.isArray(apps) ? apps.filter(a => a.enabled !== false).length : 0;

      // Unique users active in last 30d
      const totalUsers = usersData?.users != null ? Object.keys(usersData.users).length : null;

      // Total chat requests summed across all timeline rollups
      const totalChats = Array.isArray(timelineData?.data)
        ? timelineData.data.reduce((sum, d) => sum + (d.totals?.chatRequests ?? 0), 0)
        : null;

      setStats({
        apps: { value: appCount, sub: `${enabledApps} enabled`, href: '/admin/apps' },
        users: {
          value: totalUsers !== null ? totalUsers : '—',
          sub: totalUsers !== null ? 'active last 30d' : 'no data',
          href: '/admin/users'
        },
        chats: {
          value: totalChats !== null ? totalChats : '—',
          sub: 'last 30d',
          href: '/admin/usage'
        },
        version: {
          value: versionData?.app ?? '—',
          sub: `Node ${versionData?.node ?? '—'}`,
          href: '/admin/updates'
        }
      });

      // Compute "needs attention" items
      const items = [];

      if (updateData?.updateAvailable && !updateData?.error) {
        items.push({
          id: 'update-available',
          severity: 'info',
          message: `Update available: ${updateData.latestVersion}`,
          actionLabel: 'View',
          actionHref: '/admin/updates'
        });
      }

      if (appCount === 0) {
        items.push({
          id: 'no-apps',
          severity: 'info',
          message: 'No apps created yet — get started by creating your first app.',
          actionLabel: 'Create app',
          actionHref: '/admin/apps'
        });
      }

      setAttentionItems(items.slice(0, 5));

      // Fresh instance: no apps created
      setIsFreshInstance(appCount === 0);
      setIsLoading(false);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { stats, attentionItems, isLoading, isFreshInstance };
}
