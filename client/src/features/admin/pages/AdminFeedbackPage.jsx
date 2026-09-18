import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  makeAdminApiCall,
  fetchAdminApps,
  fetchAdminUsageData,
  fetchAdminUsageMeta,
  updateAdminUsageTrackingMode,
  setAppFeedbackEnabled,
  getAdminApiErrorMessage
} from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import Icon from '../../../shared/components/Icon';
import FeedbackReview from '../components/feedback/FeedbackReview';

const TRACKING_MODES = ['anonymous', 'pseudonymous', 'identified'];

function ToggleSwitch({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      } ${checked ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-600'}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function SettingRow({ title, description, children }) {
  return (
    <div className="flex items-start justify-between px-6 py-4 gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

/**
 * Admin → Feedback.
 *
 * One page for the whole feature: whether responses can be rated at all
 * (platform-wide and per app), how what is submitted gets stored and
 * identified, and the submitted feedback itself.
 *
 * The switches are the existing stores, not a second copy of them:
 *   - collection  → the `feedback` flag in features.json (also in Admin → Features)
 *   - per app     → `features.feedback` in the app's own config file
 *   - storage     → `features.feedbackTracking` in platform.json
 *   - identity    → `features.usageTrackingMode` in platform.json (shared with usage tracking)
 */
function AdminFeedbackPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { refreshConfig } = usePlatformConfig();

  const [activeTab, setActiveTab] = useState('settings');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  // Saved state, as it came from the server
  const [saved, setSaved] = useState({
    collectionEnabled: true,
    storageEnabled: true,
    trackingMode: 'pseudonymous'
  });
  // Edited state
  const [draft, setDraft] = useState(saved);
  const [apps, setApps] = useState([]);
  const [appSaving, setAppSaving] = useState(null);
  const [usage, setUsage] = useState(null);

  const load = async () => {
    try {
      setLoading(true);
      const [featuresResponse, platformResponse, meta, appList, usageData] = await Promise.all([
        makeAdminApiCall('/admin/features', { method: 'GET' }),
        makeAdminApiCall('/admin/configs/platform', { method: 'GET' }),
        fetchAdminUsageMeta().catch(() => null),
        fetchAdminApps().catch(() => []),
        fetchAdminUsageData().catch(() => null)
      ]);

      const feedbackFeature = (featuresResponse.data?.features || []).find(
        f => f.id === 'feedback'
      );
      const platform = platformResponse.data || {};
      const next = {
        collectionEnabled: feedbackFeature ? feedbackFeature.enabled !== false : true,
        storageEnabled: platform.features?.feedbackTracking !== false,
        trackingMode: meta?.trackingMode || platform.features?.usageTrackingMode || 'pseudonymous'
      };
      setSaved(next);
      setDraft(next);
      setApps(
        (Array.isArray(appList) ? appList : []).map(app => ({
          id: app.id,
          name: getLocalizedContent(app.name, lang) || app.id,
          appEnabled: app.enabled !== false,
          feedbackEnabled: app.features?.feedback !== false
        }))
      );
      setUsage(usageData);
      setMessage(null);
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          getAdminApiErrorMessage(error) ||
          t('admin.feedback.loadError', 'Failed to load feedback settings')
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const hasChanges = useMemo(
    () =>
      draft.collectionEnabled !== saved.collectionEnabled ||
      draft.storageEnabled !== saved.storageEnabled ||
      draft.trackingMode !== saved.trackingMode,
    [draft, saved]
  );

  const handleSave = async () => {
    try {
      setSaving(true);
      setMessage(null);

      if (draft.collectionEnabled !== saved.collectionEnabled) {
        await makeAdminApiCall('/admin/features', {
          method: 'PUT',
          body: { feedback: draft.collectionEnabled }
        });
      }

      if (draft.storageEnabled !== saved.storageEnabled) {
        // Read-modify-write, like every other page that owns one platform.json
        // key: the file carries settings this page does not show.
        const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
        const platform = response.data || {};
        platform.features = {
          ...(platform.features || {}),
          feedbackTracking: draft.storageEnabled
        };
        await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: platform });
      }

      if (draft.trackingMode !== saved.trackingMode) {
        await updateAdminUsageTrackingMode(draft.trackingMode);
      }

      setSaved(draft);
      setMessage({ type: 'success', text: t('admin.feedback.saved', 'Feedback settings saved') });
      refreshConfig();
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          getAdminApiErrorMessage(error) ||
          t('admin.feedback.saveError', 'Failed to save feedback settings')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleAppToggle = async (appId, enabled) => {
    const previous = apps;
    setAppSaving(appId);
    setApps(prev => prev.map(a => (a.id === appId ? { ...a, feedbackEnabled: enabled } : a)));
    try {
      await setAppFeedbackEnabled(appId, enabled);
      setMessage(null);
    } catch (error) {
      setApps(previous);
      setMessage({
        type: 'error',
        text:
          getAdminApiErrorMessage(error) ||
          t('admin.feedback.appSaveError', 'Failed to update the app')
      });
    } finally {
      setAppSaving(null);
    }
  };

  const tabs = [
    {
      id: 'settings',
      label: t('admin.feedback.tabs.settings', 'Settings'),
      icon: <Icon name="settings" size="md" />
    },
    {
      id: 'review',
      label: t('admin.feedback.tabs.review', 'Feedback'),
      icon: <Icon name="star" size="md" />
    }
  ];

  const renderSettings = () => (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('admin.feedback.sections.collection', 'Collection')}
        </h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
          <SettingRow
            title={t('admin.feedback.collect.title', 'Collect feedback')}
            description={t(
              'admin.feedback.collect.description',
              'Show the star rating under AI responses and accept submissions. Off hides it in every chat surface and answers POST /api/feedback with 403. The same switch appears in Admin → Features → Content.'
            )}
          >
            <ToggleSwitch
              checked={draft.collectionEnabled}
              onChange={value => setDraft(prev => ({ ...prev, collectionEnabled: value }))}
              label={t('admin.feedback.collect.title', 'Collect feedback')}
            />
          </SettingRow>
          <SettingRow
            title={t('admin.feedback.store.title', 'Store feedback')}
            description={t(
              'admin.feedback.store.description',
              'Write submitted feedback to contents/data/feedback.jsonl and the usage statistics. Off keeps the rating control visible but nothing is kept — iAssistant feedback still reaches iFinder.'
            )}
          >
            <ToggleSwitch
              checked={draft.storageEnabled}
              onChange={value => setDraft(prev => ({ ...prev, storageEnabled: value }))}
              label={t('admin.feedback.store.title', 'Store feedback')}
            />
          </SettingRow>
          <SettingRow
            title={t('admin.feedback.identity.title', 'Identification mode')}
            description={t(
              'admin.feedback.identity.description',
              'How the person who gave the feedback is recorded. Shared with usage tracking — changing it here changes it there too, and only for entries written from now on.'
            )}
          >
            <select
              value={draft.trackingMode}
              onChange={e => setDraft(prev => ({ ...prev, trackingMode: e.target.value }))}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 px-3 py-1.5"
            >
              {TRACKING_MODES.map(mode => (
                <option key={mode} value={mode}>
                  {t(`admin.feedback.identity.modes.${mode}`, mode)}
                </option>
              ))}
            </select>
          </SettingRow>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
          {t('admin.feedback.sections.perApp', 'Per-app overrides')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t(
            'admin.feedback.perApp.description',
            'Switch feedback off for single apps. An app can never switch it back on while collection is off platform-wide. Saved immediately in the app’s own configuration.'
          )}
        </p>
        {!draft.collectionEnabled && (
          <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
            {t(
              'admin.feedback.perApp.globalOff',
              'Collection is off platform-wide, so feedback is hidden in every app regardless of these switches.'
            )}
          </div>
        )}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
          {apps.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('admin.feedback.perApp.noApps', 'No apps configured.')}
            </div>
          ) : (
            apps.map(app => (
              <div key={app.id} className="flex items-center justify-between px-6 py-3 gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/admin/apps/${app.id}`}
                      className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-indigo-600 dark:hover:text-indigo-400 truncate"
                    >
                      {app.name}
                    </Link>
                    {!app.appEnabled && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                        {t('admin.feedback.perApp.appDisabled', 'App disabled')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{app.id}</div>
                </div>
                <ToggleSwitch
                  checked={app.feedbackEnabled}
                  disabled={appSaving === app.id}
                  onChange={value => handleAppToggle(app.id, value)}
                  label={app.name}
                />
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex items-center justify-between pt-2">
        <div>
          {message && (
            <p
              className={`text-sm ${
                message.type === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-green-600 dark:text-green-400'
              }`}
            >
              {message.text}
            </p>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          className={`px-6 py-2 rounded-lg text-sm font-medium text-white transition-colors ${
            hasChanges && !saving
              ? 'bg-indigo-600 hover:bg-indigo-700 cursor-pointer'
              : 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed'
          }`}
        >
          {saving ? t('common.saving', 'Saving...') : t('common.saveChanges', 'Save Changes')}
        </button>
      </div>
    </div>
  );

  const renderReview = () => {
    if (!usage?.feedback) {
      return (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-8 text-center text-gray-500 dark:text-gray-400">
          {t('admin.feedback.review.unavailable', 'Feedback statistics are not available.')}
        </div>
      );
    }
    return <FeedbackReview feedback={usage.feedback} />;
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="bg-white dark:bg-gray-800 shadow-xs border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.feedback.title', 'Feedback')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            {t(
              'admin.feedback.description',
              'Configure how users rate AI responses and review what they submitted.'
            )}
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading ? (
          <LoadingSpinner />
        ) : (
          <>
            <div className="border-b border-gray-200 dark:border-gray-700 mb-6">
              <nav className="-mb-px flex space-x-6" aria-label="Tabs">
                {tabs.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    aria-current={activeTab === tab.id ? 'page' : undefined}
                    className={`flex items-center gap-2 whitespace-nowrap border-b-2 py-3 px-1 text-sm font-medium transition-colors ${
                      activeTab === tab.id
                        ? 'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400'
                        : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                    }`}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                ))}
              </nav>
            </div>

            {activeTab === 'settings' ? renderSettings() : renderReview()}
          </>
        )}
      </div>
    </div>
  );
}

export default AdminFeedbackPage;
