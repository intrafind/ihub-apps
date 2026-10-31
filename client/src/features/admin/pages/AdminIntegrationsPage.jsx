// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AdminIntegrationHubPage from '../components/AdminIntegrationHubPage';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import { makeAdminApiCall } from '../../../api/adminApi';
import { fetchInstalledIntegrations } from '../../../api/integrationsAdminApi';

/** The built-in definition of the LDAP people directories (one installation per directory). */
const LDAP_DIRECTORY_DEFINITION = 'com.intrafind/ldap-directory';

/**
 * Integrations landing page — single entry point for every external system
 * iHub talks to. Renders the AdminIntegrationHubPage shell with status pills,
 * category grouping, and search. Each card links to the dedicated subpage where
 * the admin actually configures the integration.
 *
 * Status detection looks at platform.json:
 *   - Cloud storage provider entries → cloudStorage.providers[id].enabled
 *   - Outlook / Nextcloud Embed → corresponding feature flag in platform.features
 *   - People directories → at least one enabled installation of the LDAP people
 *     directory definition (`GET /admin/integrations/installed`)
 *
 * If platform config can't be loaded the cards still render but show "Available".
 */
function AdminIntegrationsPage() {
  const { t } = useTranslation();
  const featureFlags = useFeatureFlags();
  const integrationsEnabled = featureFlags.isEnabled('integrations', true);
  const [platform, setPlatform] = useState(null);
  const [peopleDirectoriesOn, setPeopleDirectoriesOn] = useState(false);

  useEffect(() => {
    if (!integrationsEnabled) return;
    let cancelled = false;
    makeAdminApiCall('/admin/configs/platform')
      .then(res => {
        if (!cancelled) setPlatform(res.data ?? null);
      })
      .catch(() => {
        if (!cancelled) setPlatform(null);
      });
    fetchInstalledIntegrations()
      .then(res => {
        if (!cancelled) {
          setPeopleDirectoriesOn(
            (res?.items || []).some(
              item => item?.definition === LDAP_DIRECTORY_DEFINITION && item.enabled !== false
            )
          );
        }
      })
      .catch(() => {
        if (!cancelled) setPeopleDirectoriesOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [integrationsEnabled]);

  const cloudProvider = id => {
    const providers = platform?.cloudStorage?.providers;
    if (!providers) return null;
    if (Array.isArray(providers)) return providers.find(p => p?.id === id) ?? null;
    return providers[id] ?? null;
  };

  const statusFor = (kind, id) => {
    // Read from the installed integrations, not from platform.json.
    if (kind === 'peopleDirectories') return peopleDirectoriesOn ? 'connected' : 'available';
    if (!platform) return 'available';
    switch (kind) {
      case 'cloud': {
        const p = cloudProvider(id);
        if (!p) return 'available';
        if (p.enabled === false) return 'disabled';
        return p.clientId || p.clientSecret ? 'connected' : 'available';
      }
      case 'outlook':
        return platform.features?.outlookAddIn || platform.officeIntegration?.enabled
          ? 'connected'
          : 'available';
      case 'browserExtension':
        return platform.features?.browserExtension ? 'connected' : 'available';
      case 'nextcloudEmbed':
        return platform.nextcloudEmbed?.enabled ? 'connected' : 'available';
      case 'copilotAgent':
        return platform.copilotAgent?.enabled ? 'connected' : 'available';
      default:
        return 'available';
    }
  };

  const productivity = t('admin.integrations.categories.productivity', 'Productivity');
  const storage = t('admin.integrations.categories.storage', 'Cloud Storage');
  const directories = t('admin.integrations.categories.directories', 'Directories');

  const integrations = [
    {
      id: 'installed-integrations',
      title: t('admin.integrations.cards.installed.title', 'Installed integrations'),
      description: t(
        'admin.integrations.cards.installed.description',
        'Install integrations from the catalog or the marketplace (e.g. a CKAN open data portal), point them at your systems and bind their actions to apps.'
      ),
      icon: 'link',
      color: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-400',
      href: '/admin/integrations/installed',
      status: 'available',
      category: t('admin.integrations.categories.data', 'Data & APIs')
    },
    {
      id: 'outlook',
      title: t('admin.integrations.cards.outlook.title', 'Outlook Add-in'),
      description: t(
        'admin.integrations.cards.outlook.description',
        'Embed iHub apps inside the Outlook task pane. Users sign in with their iHub account and run prompts against the currently selected email.'
      ),
      icon: 'mail',
      color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400',
      href: '/admin/office-integration',
      status: statusFor('outlook'),
      category: productivity
    },
    {
      id: 'browser-extension',
      title: t('admin.integrations.cards.browserExtension.title', 'Browser Extension'),
      description: t(
        'admin.integrations.cards.browserExtension.description',
        'Side-panel extension for Chrome / Edge / Firefox. Run any iHub app against the page the user is reading.'
      ),
      icon: 'wrench',
      color: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400',
      href: '/admin/browser-extension',
      status: statusFor('browserExtension'),
      category: productivity
    },
    {
      id: 'copilot-agent',
      title: t('admin.integrations.cards.copilotAgent.title', 'Microsoft 365 Copilot'),
      description: t(
        'admin.integrations.cards.copilotAgent.description',
        "Make iHub an agent in Microsoft 365 Copilot. Copilot runs iHub's apps through the MCP gateway, signed in with the user's iHub account."
      ),
      icon: 'sparkles',
      color: 'bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400',
      href: '/admin/copilot-agent',
      status: statusFor('copilotAgent'),
      category: productivity
    },
    {
      id: 'office365',
      title: t('admin.integrations.cards.office365.title', 'Office 365 (OneDrive / SharePoint)'),
      description: t(
        'admin.integrations.cards.office365.description',
        'Let users browse and attach files from OneDrive / SharePoint via Microsoft Graph during a chat.'
      ),
      icon: 'cloud',
      color: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-400',
      href: '/admin/integrations/office365',
      status: statusFor('cloud', 'office365'),
      category: storage
    },
    {
      id: 'google-drive',
      title: t('admin.integrations.cards.googleDrive.title', 'Google Drive'),
      description: t(
        'admin.integrations.cards.googleDrive.description',
        'Let users browse and attach files from Google Drive during a chat.'
      ),
      icon: 'cloud',
      color: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400',
      href: '/admin/integrations/google-drive',
      status: statusFor('cloud', 'google-drive'),
      category: storage
    },
    {
      id: 'nextcloud',
      title: t('admin.integrations.cards.nextcloud.title', 'Nextcloud'),
      description: t(
        'admin.integrations.cards.nextcloud.description',
        'Let users browse and attach files from any Nextcloud instance during a chat.'
      ),
      icon: 'cloud',
      color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400',
      href: '/admin/integrations/nextcloud',
      status: statusFor('cloud', 'nextcloud'),
      category: storage
    },
    {
      id: 'nextcloudEmbed',
      title: t('admin.integrations.cards.nextcloudEmbed.title', 'Nextcloud Embed'),
      description: t(
        'admin.integrations.cards.nextcloudEmbed.description',
        'Embed iHub inside Nextcloud. Users start a chat from Nextcloud Files with documents pre-attached.'
      ),
      icon: 'cloud',
      color: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-400',
      href: '/admin/nextcloud-embed',
      status: statusFor('nextcloudEmbed'),
      category: storage
    },
    {
      id: 'people-directories',
      title: t('admin.integrations.cards.peopleDirectories.title', 'People directories'),
      description: t(
        'admin.integrations.cards.peopleDirectories.description',
        'Let the model look up people, their function and contact details in LDAP directories — your own and external ones such as x500.bund.de. Each directory is an installation of the LDAP people directory integration.'
      ),
      icon: 'user-group',
      color: 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300',
      href: '/admin/integrations/installed',
      status: statusFor('peopleDirectories'),
      category: directories
    }
  ];

  const featureFlagBanner = !integrationsEnabled && (
    <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 mb-6 text-sm text-amber-800 dark:text-amber-200">
      {t(
        'admin.integrations.featureFlagOff',
        'The "integrations" feature flag is off. Enable it under Admin → Features to surface integration endpoints to clients.'
      )}
    </div>
  );

  return (
    <>
      {featureFlagBanner && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">{featureFlagBanner}</div>
      )}
      <AdminIntegrationHubPage
        title={t('admin.integrations.title', 'Integrations')}
        description={t(
          'admin.integrations.subtitle',
          'Connect iHub to the systems your users already work with — mail, docs, ticketing — and ship the iHub UI inside their browser.'
        )}
        integrations={integrationsEnabled ? integrations : []}
        categoryOrder={[productivity, storage, directories]}
        searchPlaceholder={t('admin.integrations.searchPlaceholder', 'Search integrations…')}
      />
    </>
  );
}

export default AdminIntegrationsPage;
