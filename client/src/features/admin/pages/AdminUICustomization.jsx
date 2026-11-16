// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import BrandingCustomization from '../components/BrandingCustomization';
import HeaderCustomization from '../components/HeaderCustomization';
import FooterCustomization from '../components/FooterCustomization';
import AppsListCustomization from '../components/AppsListCustomization';
import AssetManager from '../components/AssetManager';
import StyleEditor from '../components/StyleEditor';
import StartPageCustomization from '../components/StartPageCustomization';
import ErrorPagesCustomization from '../components/ErrorPagesCustomization';
import EuAiActCard from '../components/euAiAct/EuAiActCard';
import AdminTabs from '../components/AdminTabs';
import AdminSaveBar from '../components/AdminSaveBar';
import AdminLoadError from '../components/AdminLoadError';
import AdminLoadGate from '../components/AdminLoadGate';
import { useAdminConfigLoad } from '../hooks/useAdminConfigLoad';
import { CALLOUT_CLASS, SECONDARY_BUTTON_CLASS } from '../components/formStyles';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { PRODUCT_NAME_REF } from '../../../../../shared/translationRefs.js';

/** What the server requires of every saved configuration (server/routes/admin/ui.js). */
const REQUIRED_SECTIONS = ['title', 'header', 'footer'];

const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object?.[key]]));
const without = (object, keys) =>
  Object.fromEntries(Object.entries(object || {}).filter(([key]) => !keys.includes(key)));

/**
 * The part of the configuration each tab edits. A tab with unsaved changes shows
 * a dot; a field has exactly one tab.
 */
const TAB_SLICES = {
  branding: config => [config.title, without(config.header, ['links', 'defaultColor']), config.pwa],
  navigation: config => [pick(config.header, ['links', 'defaultColor']), config.footer],
  startPage: config => [config.startPage, config.appsList, config.icons],
  styles: config => [config.theme, config.customStyles],
  errorPages: config => [config.errorPages],
  assets: () => []
};

/**
 * The configuration as it is stored: a site title or PWA name left empty follows
 * the product name instead of saving as nothing, so a save never blanks them.
 */
export function normalizeUIConfig(config) {
  const next = { ...config };
  if (!next.title || Object.values(next.title).every(text => !String(text || '').trim())) {
    next.title = { en: PRODUCT_NAME_REF };
  }
  if (next.pwa && !String(next.pwa.name || '').trim()) {
    next.pwa = { ...next.pwa, name: PRODUCT_NAME_REF };
  }
  return next;
}

const TAB_ICONS = {
  branding: 'sparkles',
  navigation: 'menu',
  startPage: 'home',
  styles: 'sun',
  errorPages: 'exclamationTriangle',
  assets: 'photograph'
};

function AdminUICustomization() {
  const { t } = useTranslation();
  const { refreshUIConfig } = useUIConfig();
  const [searchParams, setSearchParams] = useSearchParams();
  const [savedConfig, setSavedConfig] = useState(null);
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const { isDirty, blocker, markSaved } = useUnsavedChanges(savedConfig, config);

  // The tab is part of the address, so a reload or a shared link keeps it.
  // Unknown values (the removed `content`, `pwa` tabs) land on the first tab.
  const requestedTab = searchParams.get('tab');
  const activeTab = Object.hasOwn(TAB_SLICES, requestedTab) ? requestedTab : 'branding';
  const setActiveTab = useCallback(
    id => setSearchParams(id === 'branding' ? {} : { tab: id }, { replace: true }),
    [setSearchParams]
  );

  // Load the configuration once. A save replaces the form with what was saved;
  // reloading after `refreshUIConfig()` would overwrite edits made meanwhile.
  // Until it loaded there is no form and no Save (CU-B5); a failed load shows
  // the error with Retry (UX-N4).
  const load = useAdminConfigLoad({
    sources: {
      ui: {
        load: async () => (await makeAdminApiCall('/admin/ui/config')).data,
        onLoad: data => {
          setSavedConfig(data);
          setConfig(data);
        }
      }
    }
  });
  const ready = load.status === 'ready';

  const handleSave = async () => {
    if (!ready || !config) return;
    const toSave = normalizeUIConfig(config);
    const missing = REQUIRED_SECTIONS.find(section => !Object.hasOwn(toSave, section));
    if (missing) {
      // Never send a configuration the server must reject: the edit that lost a
      // section is a bug of the page, not something to report as "400".
      setError(
        t('admin.ui.missingSection', 'The configuration lacks the section "{{section}}".', {
          section: missing
        })
      );
      return;
    }
    try {
      setSaving(true);
      setError(null);
      setSuccessMessage('');

      await makeAdminApiCall('/admin/ui/config', {
        method: 'POST',
        body: { config: toSave },
        headers: { 'Content-Type': 'application/json' }
      });
      markSaved();
      setSavedConfig(toSave);
      setConfig(toSave);
      setSuccessMessage(t('admin.ui.saved', 'UI configuration saved successfully'));
      // Apply the change in this browser right away.
      await refreshUIConfig();
      setTimeout(() => setSuccessMessage(''), 4000);
    } catch (err) {
      console.error('Failed to save UI config:', err);
      setError(err.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setConfig(savedConfig);
    setError(null);
  };

  const handleBackup = async () => {
    try {
      const response = await makeAdminApiCall('/admin/ui/backup', { method: 'POST' });
      setSuccessMessage(
        t('admin.ui.backedUp', 'Configuration backed up to: {{path}}', {
          path: response.data?.backupPath
        })
      );
      setTimeout(() => setSuccessMessage(''), 5000);
    } catch (err) {
      console.error('Failed to backup config:', err);
      setError(err.message || 'Failed to create backup');
    }
  };

  // Every editor changes the configuration through one of these two, so no edit
  // can replace the whole configuration by accident.
  const updateConfig = useCallback((section, updates) => {
    setConfig(prev => ({ ...prev, [section]: { ...prev?.[section], ...updates } }));
  }, []);
  const setConfigValue = useCallback((key, value) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  }, []);

  const dirtyTabs = useMemo(() => {
    if (!savedConfig || !config) return {};
    return Object.fromEntries(
      Object.entries(TAB_SLICES).map(([id, slice]) => [
        id,
        JSON.stringify(slice(config)) !== JSON.stringify(slice(savedConfig))
      ])
    );
  }, [savedConfig, config]);

  const tabs = [
    { id: 'branding', label: t('admin.ui.tabs.branding', 'Branding') },
    { id: 'navigation', label: t('admin.ui.tabs.navigation', 'Navigation') },
    { id: 'startPage', label: t('admin.ui.tabs.startAndApps', 'Start & apps page') },
    { id: 'styles', label: t('admin.ui.tabs.themeAndStyles', 'Theme & styles') },
    { id: 'errorPages', label: t('admin.ui.tabs.errorPages', 'Error Pages') },
    { id: 'assets', label: t('admin.ui.tabs.assets', 'Assets') }
  ].map(tab => ({
    ...tab,
    dirty: Boolean(dirtyTabs[tab.id]),
    icon: <Icon name={TAB_ICONS[tab.id]} size="sm" aria-hidden="true" />
  }));

  if (load.status === 'loading') {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            {t('admin.ui.loading', 'Loading UI configuration...')}
          </p>
        </div>
      </div>
    );
  }

  if (!ready || !config) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {t('admin.ui.title', 'UI Customization')}
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {t('admin.ui.description', 'Customize the appearance and branding of your iHub Apps')}
            </p>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <AdminLoadGate load={load} resourceLabel={t('admin.ui.resource', 'UI settings')} />
        </div>
      </div>
    );
  }

  const legacyCard = children => (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700">
      {children}
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="sm:flex sm:items-center sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.ui.title', 'UI Customization')}
              </h1>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {t(
                  'admin.ui.description',
                  'Customize the appearance and branding of your iHub Apps'
                )}
              </p>
            </div>
            <div className="mt-4 sm:mt-0">
              <button type="button" onClick={handleBackup} className={SECONDARY_BUTTON_CLASS}>
                {t('admin.ui.backup', 'Backup Config')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {error && (
          <div role="alert">
            <AdminLoadError
              message={error}
              framed={false}
              action={{ label: t('common.dismiss', 'Dismiss'), onClick: () => setError(null) }}
            />
          </div>
        )}
        {successMessage && (
          <p role="status" className={CALLOUT_CLASS.success}>
            {successMessage}
          </p>
        )}

        <AdminTabs
          tabs={tabs}
          activeId={activeTab}
          onChange={setActiveTab}
          ariaLabel={t('admin.ui.tabs.label', 'UI customization sections')}
        />

        <div
          role="tabpanel"
          id={`tabpanel-${activeTab}`}
          aria-labelledby={`tab-${activeTab}`}
          className="space-y-6"
        >
          {activeTab === 'branding' && (
            <BrandingCustomization
              config={config}
              onUpdate={updateConfig}
              onSet={setConfigValue}
              t={t}
            />
          )}
          {activeTab === 'navigation' && (
            <>
              <EuAiActCard
                id="header-navigation"
                title={t('admin.ui.header.title', 'Header')}
                description={t(
                  'admin.ui.header.description',
                  'The navigation links and the color of the classic top header.'
                )}
              >
                <HeaderCustomization
                  config={config.header || {}}
                  onUpdate={updates => updateConfig('header', updates)}
                  t={t}
                />
              </EuAiActCard>
              <EuAiActCard
                id="footer-navigation"
                title={t('admin.ui.footer.title', 'Footer')}
                description={t('admin.ui.footer.description', 'The footer text and its links.')}
              >
                <FooterCustomization
                  config={config.footer || {}}
                  onUpdate={updates => updateConfig('footer', updates)}
                  t={t}
                />
              </EuAiActCard>
            </>
          )}
          {activeTab === 'startPage' && (
            <>
              {legacyCard(
                <StartPageCustomization
                  config={config.startPage || {}}
                  pages={config.pages || {}}
                  onUpdate={updates => updateConfig('startPage', updates)}
                  t={t}
                />
              )}
              <EuAiActCard
                id="apps-page"
                title={t('admin.ui.content.appsListPage', 'Apps List Page')}
                description={t(
                  'admin.ui.content.pagesDescription',
                  'Title, subtitle and logo of the apps browser (/apps), and whether it offers search and categories.'
                )}
              >
                <AppsListCustomization config={config} onUpdate={updateConfig} t={t} />
              </EuAiActCard>
            </>
          )}
          {activeTab === 'styles' &&
            legacyCard(<StyleEditor config={config} onUpdate={setConfig} t={t} />)}
          {activeTab === 'errorPages' &&
            legacyCard(
              <ErrorPagesCustomization
                config={config.errorPages || {}}
                onUpdate={updates => updateConfig('errorPages', updates)}
                t={t}
              />
            )}
          {activeTab === 'assets' && (
            <>
              <p className={CALLOUT_CLASS.info}>
                {t(
                  'admin.ui.assets.savedNotice',
                  'Uploads and deletions here take effect immediately; they are not part of the unsaved changes. Use the path of an uploaded file in the other tabs.'
                )}
              </p>
              {legacyCard(<AssetManager t={t} />)}
            </>
          )}
        </div>
      </div>

      <AdminSaveBar dirty={isDirty} saving={saving} onSave={handleSave} onDiscard={handleDiscard} />

      <ConfirmDialog
        isOpen={blocker.state === 'blocked'}
        title={t('admin.ui.unsaved.title', 'Unsaved changes')}
        message={t('admin.ui.unsaved.message', 'You have unsaved changes. Leave anyway?')}
        confirmLabel={t('admin.ui.unsaved.leave', 'Leave')}
        denyLabel={t('admin.ui.unsaved.stay', 'Stay')}
        danger={false}
        onConfirm={() => blocker.proceed?.()}
        onDeny={() => blocker.reset?.()}
      />
    </div>
  );
}

export default AdminUICustomization;
