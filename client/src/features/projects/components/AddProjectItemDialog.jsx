// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Suspense, lazy, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import {
  CLOUD_ITEM_KINDS,
  buildItemDialogTabs,
  kindIcon,
  localizedText,
  visibleItemDialogTabs
} from '../utils/projectItems';
import ItemFormBody from './item-dialog/ItemFormBody';
import ProjectUsageBar from './ProjectUsageBar';

// The cloud tab pulls in the cloud file browsers; load it only when a cloud
// tab is opened (the admin editor never offers one).
const CloudItemTab = lazy(() => import('./item-dialog/CloudItemTab'));

/**
 * @typedef {Object} ProjectItemApi
 * @property {(projectId: string, body: Object) => Promise<Object>} addItem - JSON item.
 * @property {(projectId: string, upload: {file: File, name?: string, pinned?: boolean})
 *   => Promise<Object>} uploadItem - Multipart upload.
 * @property {() => Promise<Array<Object>>} fetchPages - iHub pages.
 * @property {(query: string) => Promise<Array<Object>>} searchIFinder
 * @property {(url: string) => Promise<{ok: boolean, error?: string}>} checkUrl
 * @property {() => Promise<Array<Object>>} [fetchCloudProviders] - Cloud connections.
 * @property {(error: Error) => string} errorMessage
 */

/**
 * Dialog that adds items to a project, with one tab per item kind (#1036,
 * spec 1 §4.1): file upload (multipart), pasted text, web page (URL), iHub
 * page, iFinder document and search, and — where `cloud` is set — the cloud
 * kinds (OneDrive / SharePoint, Google Drive, Nextcloud) through the cloud
 * file browsers. The admin project editor and the user project page share
 * it, each with its own API (`api`).
 *
 * Mount it only while it is open (`{open && <AddProjectItemDialog … />}`):
 * every opening then starts from a clean draft. Pass a stable `api` object
 * (a module constant).
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {string} props.projectId
 * @param {Array<{id: string, name: Object, enabled?: boolean}>} props.kinds
 * @param {Object|null} props.config - `_config` (upload accept list, limits).
 * @param {(item: Object) => void} props.onAdded - Called with each item added.
 * @param {ProjectItemApi} props.api
 * @param {boolean} [props.cloud=false] - Offer the cloud kinds.
 * @param {boolean} [props.hideUnavailable=false] - Hide the tabs of kinds this
 *   installation does not offer instead of showing them disabled.
 * @param {boolean} [props.multipleUploads=false] - Allow several files at once.
 * @param {Object|null} [props.project] - The project, for the quota bar.
 * @returns {JSX.Element|null}
 */
function AddProjectItemDialog({
  isOpen,
  onClose,
  projectId,
  kinds,
  config,
  onAdded,
  api,
  cloud = false,
  hideUnavailable = false,
  multipleUploads = false,
  project = null
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const tabs = useMemo(() => {
    const all = buildItemDialogTabs(kinds, config, { cloud });
    const shown = hideUnavailable ? visibleItemDialogTabs(all) : all;
    return shown.length > 0 ? shown : all;
  }, [kinds, config, cloud, hideUnavailable]);
  const firstEnabled = tabs.find(tab => tab.enabled)?.id || tabs[0].id;
  // `null` until a tab is picked: follows the first usable one, which may
  // change while the kinds are still loading.
  const [chosenTab, setChosenTab] = useState(null);
  const tab = tabs.find(candidate => candidate.id === (chosenTab ?? firstEnabled)) || tabs[0];
  const isCloudTab = CLOUD_ITEM_KINDS.includes(tab.kind) && tab.enabled;

  const tabLabel = candidate => {
    if (candidate.id === 'upload') return t('projects.addItem.tabs.upload', 'Upload');
    if (candidate.id === 'text') return t('projects.addItem.tabs.text', 'Text');
    const entry = (kinds || []).find(kind => kind.id === candidate.kind);
    return entry ? localizedText(entry.name, language) || candidate.id : candidate.id;
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClassName="max-w-3xl"
      labelledBy="add-project-item-title"
    >
      <div className="px-6 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
        <h3
          id="add-project-item-title"
          className="text-lg font-medium text-gray-900 dark:text-gray-100"
        >
          {t('projects.addItem.title', 'Add item')}
        </h3>
        {project && config?.limits && (
          <ProjectUsageBar project={project} config={config} className="mt-3" />
        )}
        <div
          role="tablist"
          aria-label={t('projects.addItem.kinds', 'Item kinds')}
          className="mt-3 flex flex-wrap gap-1"
        >
          {tabs.map(candidate => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={candidate.id === tab.id}
              aria-disabled={!candidate.enabled || undefined}
              onClick={() => setChosenTab(candidate.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${
                candidate.id === tab.id
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              } ${candidate.enabled ? '' : 'opacity-50'}`}
            >
              <Icon name={kindIcon(candidate.id)} size="xs" />
              {tabLabel(candidate)}
            </button>
          ))}
        </div>
      </div>

      {isCloudTab ? (
        <Suspense
          fallback={
            <p className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
              {t('common.loading', 'Loading...')}
            </p>
          }
        >
          <CloudItemTab
            key={tab.id}
            kind={tab.kind}
            kindEntry={(kinds || []).find(kind => kind.id === tab.kind)}
            projectId={projectId}
            api={api}
            config={config}
            onAdded={onAdded}
            onClose={onClose}
          />
        </Suspense>
      ) : (
        <ItemFormBody
          tab={tab}
          projectId={projectId}
          config={config}
          api={api}
          multipleUploads={multipleUploads}
          usage={project?.usage || null}
          onAdded={onAdded}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

export default AddProjectItemDialog;
