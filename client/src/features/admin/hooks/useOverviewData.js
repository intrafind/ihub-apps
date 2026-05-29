import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchAdminApps, makeAdminApiCall } from '../../../api/adminApi';

/**
 * Fetches and computes data for the admin Overview dashboard.
 * Uses Promise.allSettled so individual endpoint failures don't block others.
 */
export function useOverviewData() {
  const { t } = useTranslation();
  const [stats, setStats] = useState(null);
  const [platformInfo, setPlatformInfo] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFreshInstance, setIsFreshInstance] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const [
        appsResult,
        sessionsResult,
        timelineResult,
        versionResult,
        updateResult,
        overviewResult
      ] = await Promise.allSettled([
        fetchAdminApps(),
        makeAdminApiCall('/admin/usage/users'),
        makeAdminApiCall('/admin/usage/timeline'),
        makeAdminApiCall('/admin/version'),
        makeAdminApiCall('/admin/version/check-update'),
        makeAdminApiCall('/admin/overview/stats')
      ]);

      if (cancelled) return;

      const apps = appsResult.status === 'fulfilled' ? appsResult.value : [];
      const sessionsData =
        sessionsResult.status === 'fulfilled' ? sessionsResult.value?.data : null;
      const timelineData =
        timelineResult.status === 'fulfilled' ? timelineResult.value?.data : null;
      const versionData = versionResult.status === 'fulfilled' ? versionResult.value?.data : null;
      const updateData = updateResult.status === 'fulfilled' ? updateResult.value?.data : null;
      const overview = overviewResult.status === 'fulfilled' ? overviewResult.value?.data : null;

      const appCount = Array.isArray(apps) ? apps.length : 0;
      const enabledApps = Array.isArray(apps) ? apps.filter(a => a.enabled !== false).length : 0;

      // Actual registered users from overview stats
      const userCount = overview?.users ?? null;

      // Sessions active in last 30d (from usage tracking)
      const sessionCount =
        sessionsData?.users != null ? Object.keys(sessionsData.users).length : null;

      // Total chat requests summed across all timeline rollups
      const totalChats = Array.isArray(timelineData?.data)
        ? timelineData.data.reduce((sum, d) => sum + (d.totals?.chatRequests ?? 0), 0)
        : null;

      setStats({
        apps: {
          value: appCount,
          sub: t('admin.overview.apps.enabledCount', '{{count}} enabled', { count: enabledApps }),
          href: '/admin/apps'
        },
        users: {
          value: userCount !== null ? userCount : '—',
          sub:
            sessionCount !== null
              ? t('admin.overview.users.sessions', '{{count}} sessions (30d)', {
                  count: sessionCount
                })
              : t('admin.overview.users.noSessions', 'no session data'),
          href: '/admin/users'
        },
        chats: {
          value: totalChats !== null ? totalChats : '—',
          sub: t('admin.overview.chats.period', 'last 30d'),
          href: '/admin/usage'
        },
        version: {
          value: versionData?.app ?? '—',
          sub: t('admin.overview.version.node', 'Node {{version}}', {
            version: versionData?.node ?? '—'
          }),
          href: '/admin/updates',
          updateAvailable: updateData?.updateAvailable ?? false,
          latestVersion: updateData?.latestVersion
        }
      });

      // Store platform info for the overview page
      if (overview) {
        setPlatformInfo(overview);
      }

      // Fresh instance: no apps created
      setIsFreshInstance(appCount === 0);
      setIsLoading(false);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [t]);

  return { stats, platformInfo, isLoading, isFreshInstance };
}
