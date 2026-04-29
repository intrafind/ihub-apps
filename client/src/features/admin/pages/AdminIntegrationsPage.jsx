import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import AdminSectionCard from '../components/AdminSectionCard';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';

/**
 * Integrations landing page — single entry point for every external system
 * iHub talks to (mail / docs / browser shells). Each card links to the
 * dedicated subpage where the admin actually configures the integration.
 *
 * The card list is rendered in an obvious "first‑class citizen" order
 * (Outlook + Browser Extension are end‑user surfaces, then docs storage,
 * then ticketing). Cards are gated behind the `integrations` feature flag
 * — the same flag that gates the matching server‑side routes.
 */
function AdminIntegrationsPage() {
  const { t } = useTranslation();
  const featureFlags = useFeatureFlags();
  const integrationsEnabled = featureFlags.isEnabled('integrations', true);

  // Each entry has its own `enabled` predicate so we can hide an integration
  // when its host (Office, Cloud Storage, Jira) feature flag is off without
  // hiding the rest of the page.
  const sections = [
    integrationsEnabled && {
      key: 'outlook',
      title: t('admin.integrations.cards.outlook.title', 'Outlook Add-in'),
      description: t(
        'admin.integrations.cards.outlook.description',
        'Embed iHub apps inside the Outlook task pane. Users sign in with their iHub account and run prompts against the currently selected email.'
      ),
      icon: 'envelope',
      color: 'bg-blue-500',
      href: '/admin/office-integration'
    },
    integrationsEnabled && {
      key: 'browser-extension',
      title: t('admin.integrations.cards.browserExtension.title', 'Browser Extension'),
      description: t(
        'admin.integrations.cards.browserExtension.description',
        'Side‑panel extension for Chrome / Edge / Firefox. Run any iHub app against the page the user is reading; admin downloads a customised, signed package per deployment.'
      ),
      icon: 'puzzle-piece',
      color: 'bg-emerald-500',
      href: '/admin/browser-extension'
    },
    integrationsEnabled && {
      key: 'office365',
      title: t('admin.integrations.cards.office365.title', 'Office 365 (OneDrive / SharePoint)'),
      description: t(
        'admin.integrations.cards.office365.description',
        "Let users browse and attach files from OneDrive / SharePoint via Microsoft Graph during a chat. Stored under the platform's `cloudStorage` config."
      ),
      icon: 'cloud',
      color: 'bg-sky-500',
      href: '/admin/integrations/office365'
    },
    integrationsEnabled && {
      key: 'google-drive',
      title: t('admin.integrations.cards.googleDrive.title', 'Google Drive'),
      description: t(
        'admin.integrations.cards.googleDrive.description',
        'Let users browse and attach files from Google Drive during a chat. Same `cloudStorage` config surface as Office 365.'
      ),
      icon: 'cloud',
      color: 'bg-yellow-500',
      href: '/admin/integrations/google-drive'
    },
    integrationsEnabled && {
      key: 'jira',
      title: t('admin.integrations.cards.jira.title', 'Atlassian Jira'),
      description: t(
        'admin.integrations.cards.jira.description',
        'OAuth credentials so iHub apps can read and create Jira tickets on behalf of the signed‑in user.'
      ),
      icon: 'ticket',
      color: 'bg-indigo-500',
      href: '/admin/integrations/jira'
    }
  ].filter(Boolean);

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {t('admin.integrations.title', 'Integrations')}
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-2">
              {t(
                'admin.integrations.subtitle',
                'Connect iHub to the systems your users already work with — mail, docs, ticketing — and ship the iHub UI inside their browser.'
              )}
            </p>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {!integrationsEnabled && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 mb-6 text-sm text-amber-800 dark:text-amber-200">
              {t(
                'admin.integrations.featureFlagOff',
                'The "integrations" feature flag is off. Enable it under Admin → Features to surface integration endpoints to clients.'
              )}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {sections.map(section => (
              <AdminSectionCard key={section.key} section={section} />
            ))}
          </div>
        </div>
      </div>
    </AdminAuth>
  );
}

export default AdminIntegrationsPage;
