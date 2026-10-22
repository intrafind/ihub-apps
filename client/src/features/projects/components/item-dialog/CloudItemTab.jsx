// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Office365FileBrowser from '../../../upload/components/Office365FileBrowser';
import GoogleDriveFileBrowser from '../../../upload/components/GoogleDriveFileBrowser';
import NextcloudFileBrowser from '../../../upload/components/NextcloudFileBrowser';
import {
  buildCloudItemRequests,
  cloudBrowserUploadConfig,
  cloudProvidersForKind
} from '../../utils/projectItems';
import { INPUT_CLASS, LABEL_CLASS } from './dialogStyles';

/** The cloud file browser of each cloud kind (the ones the chat upload uses). */
const BROWSERS = {
  office365: Office365FileBrowser,
  'google-drive': GoogleDriveFileBrowser,
  nextcloud: NextcloudFileBrowser
};

/**
 * Add each picked file as an item. A failure does not stop the others.
 *
 * @returns {Promise<{added: Array<Object>, failures: string[]}>}
 */
async function addAll(api, projectId, requests) {
  const added = [];
  const failures = [];
  for (const body of requests) {
    try {
      added.push(await api.addItem(projectId, body));
    } catch (err) {
      failures.push(`${body.name || body.ref?.name || ''}: ${api.errorMessage(err)}`);
    }
  }
  return { added, failures };
}

/**
 * A cloud tab of the "Add item" dialog (spec 1 §4, spec 3 §4): the cloud
 * storage connection to browse (`GET /api/projects/pickers/cloud`), the
 * existing cloud file browser, and the picked files added as references.
 * The server downloads each file with the caller's token, extracts its text
 * and keeps a snapshot; nothing is downloaded in the browser.
 *
 * @param {Object} props
 * @param {string} props.kind - `office365`, `google-drive` or `nextcloud`.
 * @param {{id: string, picker?: {provider?: string}}|undefined} props.kindEntry - From `_config.kinds`.
 * @param {string} props.projectId
 * @param {Object} props.api - See `AddProjectItemDialog`.
 * @param {Object|null} [props.config] - `_config`; its `limits.maxFileBytes`
 *   caps the files the browser lets the user pick.
 * @param {(item: Object) => void} props.onAdded
 * @param {() => void} props.onClose
 * @returns {JSX.Element}
 */
function CloudItemTab({ kind, kindEntry, projectId, api, config = null, onAdded, onClose }) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState(null);
  const [providerId, setProviderId] = useState('');
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    (api.fetchCloudProviders ? api.fetchCloudProviders() : Promise.resolve([]))
      .then(list => {
        if (active) setProviders(list);
      })
      .catch(err => {
        if (active) {
          setProviders([]);
          setError(api.errorMessage(err));
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  const matching = cloudProvidersForKind(providers, kindEntry || kind);
  const provider = matching.find(entry => entry.id === providerId) || matching[0] || null;
  const Browser = BROWSERS[kind];
  const uploadConfig = useMemo(() => cloudBrowserUploadConfig(config), [config]);

  const handlePick = async (files, drive) => {
    if (!provider) return;
    const requests = buildCloudItemRequests(kind, provider.id, files, drive, { pinned });
    if (requests.length === 0) return;
    setBusy(true);
    setError(null);
    const { added, failures } = await addAll(api, projectId, requests);
    added.forEach(item => onAdded(item));
    setBusy(false);
    if (failures.length > 0) setError(failures.join('\n'));
    else onClose();
  };

  if (providers === null) {
    return (
      <p className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
        {t('common.loading', 'Loading...')}
      </p>
    );
  }

  return (
    <div className="px-6 py-4 space-y-3 overflow-y-auto">
      {matching.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('projects.addItem.cloudNone', 'No connection of this kind is configured.')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4">
            {matching.length > 1 && (
              <div className="min-w-[12rem]">
                <label htmlFor="project-item-cloud-provider" className={LABEL_CLASS}>
                  {t('projects.addItem.cloudProvider', 'Connection')}
                </label>
                <select
                  id="project-item-cloud-provider"
                  value={provider?.id || ''}
                  onChange={e => setProviderId(e.target.value)}
                  className={INPUT_CLASS}
                >
                  {matching.map(entry => (
                    <option key={entry.id} value={entry.id}>
                      {entry.displayName || entry.id}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 pb-2">
              <input
                type="checkbox"
                checked={pinned}
                onChange={e => setPinned(e.target.checked)}
                className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
              />
              {t('projects.addItem.pinned', 'Pinned (always in the prompt)')}
            </label>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'projects.addItem.cloudHint',
              'The text of each picked file is taken now, with your account. Refresh an item later to take it again.'
            )}
          </p>
          {provider && Browser && (
            <div className={busy ? 'pointer-events-none opacity-60' : ''}>
              <Browser
                key={provider.id}
                provider={provider}
                uploadConfig={uploadConfig}
                onClose={onClose}
                onPick={handlePick}
                pickLabel={t('projects.addItem.cloudAdd', 'Add to project')}
              />
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400 whitespace-pre-line">
          {error}
        </p>
      )}
    </div>
  );
}

export default CloudItemTab;
