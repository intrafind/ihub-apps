// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchAdminApps,
  fetchAdminProjects,
  fetchAdminPrompts,
  makeAdminApiCall
} from '../../../api/adminApi';

/**
 * Fetches and computes data for the admin Overview dashboard.
 * Uses Promise.allSettled so individual endpoint failures don't block others.
 *
 * Every endpoint below is server-local. Nothing that reaches the internet
 * belongs in this batch: `allSettled` only settles once the slowest request
 * does, so one unreachable host holds the whole dashboard on its loading
 * skeletons. The GitHub update check lives in `useUpdateCheck` for exactly that
 * reason (issue #2150).
 *
 * @param {Object} [options]
 * @param {boolean} [options.contentAdminOnly] - When true, the caller is a
 *   content-admin-only user (no full admin access). Only content endpoints
 *   (apps/prompts/projects) are queried; the platform/usage/audit endpoints are
 *   skipped because they require full admin and would return 403 (issue #1923).
 */
export function useOverviewData({ contentAdminOnly = false } = {}) {
  const { t } = useTranslation();
  const [stats, setStats] = useState(null);
  const [platformInfo, setPlatformInfo] = useState(null);
  const [recentActivity, setRecentActivity] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFreshInstance, setIsFreshInstance] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Content-admin-only view: fetch just the resources they manage. These all
    // pass contentAdminAuth on the server, so no 403s are triggered.
    const loadContentAdmin = async () => {
      const [appsResult, promptsResult, projectsResult] = await Promise.allSettled([
        fetchAdminApps(),
        fetchAdminPrompts(),
        fetchAdminProjects()
      ]);

      if (cancelled) return;

      const apps = appsResult.status === 'fulfilled' ? appsResult.value : [];
      const prompts = promptsResult.status === 'fulfilled' ? promptsResult.value : [];
      const projects = projectsResult.status === 'fulfilled' ? projectsResult.value : [];

      const appCount = Array.isArray(apps) ? apps.length : 0;
      const enabledApps = Array.isArray(apps) ? apps.filter(a => a.enabled !== false).length : 0;

      setStats({
        apps: {
          value: appCount,
          sub: t('admin.overview.apps.enabledCount', '{{count}} enabled', { count: enabledApps }),
          href: '/admin/apps'
        },
        prompts: {
          value: Array.isArray(prompts) ? prompts.length : 0,
          sub: t('admin.overview.prompts.label', 'prompts'),
          href: '/admin/prompts'
        },
        projects: {
          value: Array.isArray(projects) ? projects.length : 0,
          sub: t('admin.overview.projects.enabledCount', '{{count}} enabled', {
            count: Array.isArray(projects) ? projects.filter(p => p.enabled !== false).length : 0
          }),
          href: '/admin/projects'
        }
      });

      setPlatformInfo(null);
      setRecentActivity(null);
      setIsFreshInstance(appCount === 0);
      setIsLoading(false);
    };

    const load = async () => {
      const [appsResult, usageResult, versionResult, overviewResult, auditResult] =
        await Promise.allSettled([
          fetchAdminApps(),
          makeAdminApiCall('/admin/usage/summary?range=30d'),
          makeAdminApiCall('/admin/version'),
          makeAdminApiCall('/admin/overview/stats'),
          makeAdminApiCall('/admin/audit-log?limit=8')
        ]);

      if (cancelled) return;

      const apps = appsResult.status === 'fulfilled' ? appsResult.value : [];
      const usageTotals =
        usageResult.status === 'fulfilled' ? usageResult.value?.data?.totals || null : null;
      const versionData = versionResult.status === 'fulfilled' ? versionResult.value?.data : null;
      const overview = overviewResult.status === 'fulfilled' ? overviewResult.value?.data : null;

      const appCount = Array.isArray(apps) ? apps.length : 0;
      const enabledApps = Array.isArray(apps) ? apps.filter(a => a.enabled !== false).length : 0;

      // Actual registered users from overview stats
      const userCount = overview?.users ?? null;

      // Users with model calls in the last 30 days (usage reports; in
      // pseudonymous mode each conversation counts as a user).
      const activeUsers = usageTotals ? usageTotals.activeUsers : null;

      // Model calls of every surface in the last 30 days
      const totalCalls = usageTotals ? usageTotals.requests : null;

      setStats({
        apps: {
          value: appCount,
          sub: t('admin.overview.apps.enabledCount', '{{count}} enabled', { count: enabledApps }),
          href: '/admin/apps'
        },
        users: {
          value: userCount !== null ? userCount : '—',
          sub:
            activeUsers !== null
              ? t('admin.overview.users.active', '{{count}} active (30d)', {
                  count: activeUsers
                })
              : t('admin.overview.users.noSessions', 'no session data'),
          href: '/admin/users'
        },
        chats: {
          value: totalCalls !== null ? totalCalls : '—',
          sub: t('admin.overview.chats.period', 'last 30d'),
          href: '/admin/usage'
        },
        version: {
          value: versionData?.app ?? '—',
          sub: t('admin.overview.version.node', 'Node {{version}}', {
            version: versionData?.node ?? '—'
          }),
          href: '/admin/updates'
        }
      });

      // Store platform info for the overview page
      if (overview) {
        setPlatformInfo(overview);
      }

      // Recent activity from the audit log (top 8 entries already sorted newest-first)
      if (auditResult.status === 'fulfilled') {
        const entries = auditResult.value?.data?.items;
        if (Array.isArray(entries)) {
          setRecentActivity(entries);
        }
      }

      // Fresh instance: no apps created
      setIsFreshInstance(appCount === 0);
      setIsLoading(false);
    };

    if (contentAdminOnly) {
      void loadContentAdmin();
    } else {
      void load();
    }
    return () => {
      cancelled = true;
    };
  }, [t, contentAdminOnly]);

  return { stats, platformInfo, recentActivity, isLoading, isFreshInstance };
}
