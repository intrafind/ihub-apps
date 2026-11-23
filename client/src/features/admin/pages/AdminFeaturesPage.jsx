// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall } from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Badge from '../../../shared/components/Badge';
import Switch from '../../../shared/components/Switch';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import UnsavedChangesDialog from '../components/UnsavedChangesDialog';
import AdminSaveBar from '../components/AdminSaveBar';
import AppDraftModelSetting from '../components/AppDraftModelSetting';
import { useAdminConfigLoad } from '../hooks/useAdminConfigLoad';

/** The feature whose row carries the draft model setting. */
const APP_GENERATOR_FEATURE = 'appGenerator';

/**
 * The draft model setting as stored (`platform.appGenerator.modelId`) and the
 * models it can name. Rejects when either cannot be loaded: the load hook then
 * leaves the select hidden, so a save can never write over a value the page
 * never read.
 *
 * @returns {Promise<{ modelId: string, models: object[] }>}
 */
async function loadDraftModelSetting() {
  const [platform, models] = await Promise.all([
    makeAdminApiCall('/admin/configs/platform', { method: 'GET' }),
    makeAdminApiCall('/admin/models', { method: 'GET' })
  ]);
  const modelId = platform?.data?.appGenerator?.modelId;
  return {
    modelId: typeof modelId === 'string' ? modelId : '',
    models: Array.isArray(models?.data?.items) ? models.data.items : []
  };
}

function AdminFeaturesPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { refreshConfig } = usePlatformConfig();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  // The last save failed. Its outcome on the server can be unknown (a lost response), so the
  // bar stays until a save succeeds or the changes are discarded, even if the toggles were
  // put back: Save then sends the values the page shows.
  const [saveFailed, setSaveFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // The write of the draft model failed: the server may hold the new model although the page
  // still counts the old one as saved. The next save sends the model again, also when the
  // select was put back to what was loaded.
  const draftModelUncertainRef = useRef(false);
  const [features, setFeatures] = useState([]);
  const [categories, setCategories] = useState({});
  const [dirtyFlags, setDirtyFlags] = useState({});
  // The features as last loaded or saved; null until they loaded.
  const [savedFeatures, setSavedFeatures] = useState(null);
  // The draft model (`platform.appGenerator.modelId`): null until it loaded,
  // and while it cannot be loaded.
  const [draftModel, setDraftModel] = useState(null);
  const [savedDraftModelId, setSavedDraftModelId] = useState(null);
  // Optional: the features save without it; only the draft model select
  // waits for it and stays hidden when it cannot be loaded.
  const draftModelLoad = useAdminConfigLoad({
    sources: {
      draftModel: {
        load: loadDraftModelSetting,
        required: false,
        onLoad: setting => {
          setDraftModel(setting);
          setSavedDraftModelId(setting.modelId);
        }
      }
    }
  });
  const { blocker, isDirty } = useUnsavedChanges(
    savedFeatures ? { features: savedFeatures, draftModelId: savedDraftModelId } : null,
    { features, draftModelId: draftModel ? draftModel.modelId : null }
  );

  const loadFeatures = async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall('/admin/features', { method: 'GET' });
      setFeatures(response.data.items || []);
      setSavedFeatures(response.data.items || []);
      setCategories(response.data.categories || {});
      setDirtyFlags({});
    } catch (error) {
      console.error('Error loading features:', error);
      setLoadFailed(true);
      setMessage(t('admin.features.loadError', 'Failed to load features'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFeatures();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const handleToggle = (featureId, currentEnabled) => {
    const newEnabled = !currentEnabled;
    setFeatures(prev => prev.map(f => (f.id === featureId ? { ...f, enabled: newEnabled } : f)));
    setDirtyFlags(prev => ({ ...prev, [featureId]: newEnabled }));
  };

  const draftModelChanged =
    draftModelLoad.sourceStatus.draftModel === 'ready' &&
    !!draftModel &&
    draftModel.modelId !== savedDraftModelId;

  const handleSave = async () => {
    const writeDraftModel = (draftModelChanged || draftModelUncertainRef.current) && !!draftModel;
    if (Object.keys(dirtyFlags).length === 0 && !writeDraftModel) return;

    // Whether a write went through: then the shared configuration is re-read even
    // when the other write fails, and only the failed change stays unsaved.
    let wrote = false;
    let writingDraftModel = false;
    try {
      setSaving(true);
      setSaveFailed(false);
      setMessage('');

      if (Object.keys(dirtyFlags).length > 0) {
        await makeAdminApiCall('/admin/features', {
          method: 'PUT',
          body: dirtyFlags
        });
        wrote = true;
        setDirtyFlags({});
        setSavedFeatures(features);
      }

      if (writeDraftModel) {
        writingDraftModel = true;
        // A scoped merge patch of this one field: other sections of
        // platform.json are not touched. `null` removes the field, which
        // means the automatic choice.
        await makeAdminApiCall('/admin/configs/platform', {
          method: 'PATCH',
          body: { appGenerator: { modelId: draftModel.modelId || null } }
        });
        wrote = true;
        draftModelUncertainRef.current = false;
        setSavedDraftModelId(draftModel.modelId);
      }

      setMessage(t('admin.features.saved', 'Features updated successfully'));

      // Clear success message after a few seconds
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      console.error('Error saving features:', error);
      if (writingDraftModel) draftModelUncertainRef.current = true;
      setSaveFailed(true);
      setMessage(t('admin.features.saveError', 'Failed to save features'));
    } finally {
      if (wrote) refreshConfig();
      setSaving(false);
    }
  };

  // Group features by category and sort by category order
  const groupedFeatures = Object.entries(categories)
    .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
    .map(([categoryId, category]) => ({
      id: categoryId,
      name: getLocalizedContent(category.name, lang) || categoryId,
      features: features.filter(f => f.category === categoryId)
    }))
    .filter(group => group.features.length > 0);

  // Back to what was loaded or last saved: the toggles, the draft model and the message.
  const handleDiscard = () => {
    setFeatures(savedFeatures || []);
    setDirtyFlags({});
    setDraftModel(prev => (prev ? { ...prev, modelId: savedDraftModelId } : prev));
    draftModelUncertainRef.current = false;
    setSaveFailed(false);
    setMessage('');
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 shadow-xs border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.features.title', 'Features')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            {t('admin.features.description', 'Enable or disable platform features')}
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <span className="ml-3 text-gray-600 dark:text-gray-400">
              {t('common.loading', 'Loading...')}
            </span>
          </div>
        ) : (
          <div className="space-y-8">
            {message && (
              <p
                role={saveFailed || loadFailed ? 'alert' : 'status'}
                className={`text-sm ${saveFailed || loadFailed ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}
              >
                {message}
              </p>
            )}
            {groupedFeatures.map(group => (
              <div key={group.id}>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  {group.name}
                </h2>
                <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
                  {group.features.map(feature => (
                    <div key={feature.id} className="px-6 py-4">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0 pr-4">
                          <div className="flex items-center gap-2">
                            <span
                              id={`feature-name-${feature.id}`}
                              className="text-sm font-medium text-gray-900 dark:text-gray-100"
                            >
                              {getLocalizedContent(feature.name, lang)}
                            </span>
                            {feature.preview && (
                              <Badge tone="info" shape="rounded">
                                {t('admin.features.preview', 'Preview')}
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                            {getLocalizedContent(feature.description, lang)}
                          </p>
                        </div>
                        <Switch
                          checked={feature.enabled}
                          onChange={() => handleToggle(feature.id, feature.enabled)}
                          aria-labelledby={`feature-name-${feature.id}`}
                        />
                      </div>
                      {feature.id === APP_GENERATOR_FEATURE && draftModel && (
                        <AppDraftModelSetting
                          value={draftModel.modelId}
                          models={draftModel.models}
                          disabled={!feature.enabled}
                          onChange={modelId => setDraftModel(prev => ({ ...prev, modelId }))}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Nothing to save while loading or when the features could not be loaded. */}
      <AdminSaveBar
        dirty={savedFeatures !== null && (isDirty || saveFailed)}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={handleDiscard}
        message={saveFailed ? message : undefined}
      />
      <UnsavedChangesDialog blocker={blocker} />
    </div>
  );
}

export default AdminFeaturesPage;
