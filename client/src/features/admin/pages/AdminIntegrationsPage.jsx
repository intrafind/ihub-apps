import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AdminIntegrationHubPage from '../components/AdminIntegrationHubPage';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import { makeAdminApiCall } from '../../../api/adminApi';

/**
 * Integrations landing page — single entry point for every external system
 * iHub talks to. Renders the AdminIntegrationHubPage shell with status pills,
 * category grouping, and search. Each card links to the dedicated subpage where
 * the admin actually configures the integration.
 *
 * Status detection looks at platform.json:
 *   - Cloud storage provider entries → cloudStorage.providers[id].enabled
 *   - Jira → jira.clientId present
 *   - Outlook / Nextcloud Embed → corresponding feature flag in platform.features
 *
 * If platform config can't be loaded the cards still render but show "Available".
 */
function AdminIntegrationsPage() {
  const { t } = useTranslation();
  const featureFlags = useFeatureFlags();
  const integrationsEnabled = featureFlags.isEnabled('integrations', true);
  const [platform, setPlatform] = useState(null);

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
    if (!platform) return 'available';
    switch (kind) {
      case 'cloud': {
        const p = cloudProvider(id);
        if (!p) return 'available';
        if (p.enabled === false) return 'disabled';
        return p.clientId || p.clientSecret ? 'connected' : 'available';
      }
      case 'jira':
        if (platform.jira?.enabled === false) return 'disabled';
        return platform.jira?.clientId ? 'connected' : 'available';
      case 'outlook':
        return platform.features?.outlookAddIn || platform.officeIntegration?.enabled
          ? 'connected'
          : 'available';
      case 'browserExtension':
        return platform.features?.browserExtension ? 'connected' : 'available';
      case 'nextcloudEmbed':
        return platform.nextcloudEmbed?.enabled ? 'connected' : 'available';
      default:
        return 'available';
    }
  };

  const productivity = t('admin.integrations.categories.productivity', 'Productivity');
  const storage = t('admin.integrations.categories.storage', 'Cloud Storage');
  const ticketing = t('admin.integrations.categories.ticketing', 'Ticketing');

  const integrations = [
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
      color: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400',
      href: '/admin/browser-extension',
      status: statusFor('browserExtension'),
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
      color: 'bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400',
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
      color: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-600 dark:text-yellow-400',
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
      color: 'bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400',
      href: '/admin/nextcloud-embed',
      status: statusFor('nextcloudEmbed'),
      category: storage
    },
    {
      id: 'jira',
      title: t('admin.integrations.cards.jira.title', 'Atlassian Jira'),
      description: t(
        'admin.integrations.cards.jira.description',
        'OAuth credentials so iHub apps can read and create Jira tickets on behalf of the signed-in user.'
      ),
      icon: 'ticket',
      color: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400',
      href: '/admin/integrations/jira',
      status: statusFor('jira'),
      category: ticketing
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
        categoryOrder={[productivity, storage, ticketing]}
        searchPlaceholder={t('admin.integrations.searchPlaceholder', 'Search integrations…')}
      />
    </>
  );
}

export default AdminIntegrationsPage;
