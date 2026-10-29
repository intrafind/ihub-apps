// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import AdminTabs from '../AdminTabs';
import { makeAdminApiCall } from '../../../../api/adminApi';
import { formatBytes } from './StagedUpdatePanel';

const RELEASES_URL = 'https://github.com/intrafind/ihub-apps/releases';
const ARCHIVE_ACCEPT = '.gz,.tgz,.zip,.txt';

/** Problem text for a failed staging request; an upload a proxy refused gets a hint. */
function describeError(error, t) {
  const status = error.response?.status;
  if (status === 413 || (!error.response && error.code !== 'ERR_CANCELED')) {
    return t(
      'admin.updates.uploadRejectedByProxy',
      'The upload did not reach the server (HTTP {{status}}). A reverse proxy in front of iHub may limit the request size or time. Copy the archive to the server and use "File on the server" instead.',
      { status: status || '–' }
    );
  }
  return error.response?.data?.error || error.message;
}

/**
 * "Install from file": an admin hands iHub a release archive obtained on
 * another machine — uploaded through the browser, or already on the server
 * (any absolute path, or the updates/ folder). The server verifies and stages
 * it; the result is shown by the staged-update panel.
 *
 * @param {Object} props
 * @param {Object} props.status - /admin/update/status
 * @param {string|null} props.latestVersion - Latest release if the online check knows it
 * @param {boolean} props.busy
 * @param {(busy: boolean) => void} props.setBusy
 * @param {(result: { summary?: Object, error?: string }) => void} props.onStaged
 */
function InstallFromFileCard({ status, latestVersion, busy, setBusy, onStaged }) {
  const { t } = useTranslation();
  const baseId = useId();
  const [tab, setTab] = useState('upload');
  const [archive, setArchive] = useState(null);
  const [checksums, setChecksums] = useState(null);
  const [checksumsSig, setChecksumsSig] = useState(null);
  const [progress, setProgress] = useState(null);
  const [serverPath, setServerPath] = useState('');
  const [candidates, setCandidates] = useState(null);
  const abortRef = useRef(null);

  const expectedName = latestVersion
    ? status.archiveNameExample.replace('<version>', latestVersion.replace(/^v/, ''))
    : status.archiveNameExample;

  const loadCandidates = useCallback(async () => {
    try {
      const response = await makeAdminApiCall('/admin/update/local-candidates');
      setCandidates(response.data);
    } catch {
      setCandidates({ files: [] });
    }
  }, []);

  useEffect(() => {
    if (tab === 'server' && candidates === null) void loadCandidates();
  }, [tab, candidates, loadCandidates]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const stage = async request => {
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await request(controller.signal);
      onStaged({ summary: response.data });
    } catch (error) {
      if (error.code === 'ERR_CANCELED') {
        onStaged({});
      } else if (error.response?.status === 422 && error.response.data?.summary) {
        onStaged({ summary: error.response.data.summary });
      } else {
        onStaged({ error: describeError(error, t) });
      }
    } finally {
      abortRef.current = null;
      setProgress(null);
      setBusy(false);
    }
  };

  const handleUpload = event => {
    event.preventDefault();
    if (!archive) return;
    const form = new FormData();
    form.append('archive', archive);
    if (checksums) form.append('checksums', checksums);
    if (checksumsSig) form.append('checksumsSig', checksumsSig);
    setProgress(0);
    void stage(signal =>
      makeAdminApiCall('/admin/update/stage-upload', {
        method: 'POST',
        body: form,
        signal,
        // Uploading and verifying a large archive takes longer than the default 30 s.
        timeout: 0,
        onUploadProgress: e => {
          if (e.total) setProgress(Math.round((e.loaded / e.total) * 100));
        }
      })
    );
  };

  const handleServerPath = (event, pathOverride) => {
    event?.preventDefault();
    const path = (pathOverride ?? serverPath).trim();
    if (!path) return;
    void stage(signal =>
      makeAdminApiCall('/admin/update/stage-local', {
        method: 'POST',
        body: { path },
        signal,
        timeout: 0
      })
    );
  };

  const fileInput = (id, label, accept, file, onChange, hint) => (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      <input
        id={id}
        type="file"
        accept={accept}
        disabled={busy}
        onChange={event => onChange(event.target.files?.[0] || null)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-1 block w-full text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 dark:file:bg-gray-700 file:px-3 file:py-1.5 file:text-sm file:font-medium"
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {hint}
        </p>
      )}
      {file && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {file.name} ({formatBytes(file.size)})
        </p>
      )}
    </div>
  );

  return (
    <section
      aria-labelledby={`${baseId}-title`}
      className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6"
    >
      <h3
        id={`${baseId}-title`}
        className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100"
      >
        <Icon name="upload" size="md" className="text-gray-500 dark:text-gray-400" />
        {t('admin.updates.installFromFileTitle', 'Install from file')}
      </h3>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {t(
          'admin.updates.installFromFileDesc',
          'For servers without internet access: download the release archive on another machine and hand it to iHub here. It is verified before anything is changed.'
        )}
      </p>
      <p className="mt-3 text-sm text-gray-800 dark:text-gray-200">
        {t('admin.updates.expectedArchive', 'This server needs')}{' '}
        <code className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-xs">
          {expectedName}
        </code>{' '}
        ({status.platform}, {status.arch}) ·{' '}
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-700 dark:text-blue-300 underline"
        >
          {t('admin.updates.releasesPage', 'Releases page')}
        </a>
      </p>

      <div className="mt-4">
        <AdminTabs
          ariaLabel={t('admin.updates.sourceTabs', 'Where the archive is')}
          activeId={tab}
          onChange={setTab}
          tabs={[
            { id: 'upload', label: t('admin.updates.tabUpload', 'Upload') },
            { id: 'server', label: t('admin.updates.tabServer', 'File on the server') }
          ]}
        />

        {tab === 'upload' && (
          <form
            id="tabpanel-upload"
            role="tabpanel"
            aria-labelledby="tab-upload"
            onSubmit={handleUpload}
            className="space-y-4"
          >
            {fileInput(
              `${baseId}-archive`,
              t('admin.updates.archiveLabel', 'Release archive'),
              ARCHIVE_ACCEPT,
              archive,
              setArchive,
              t(
                'admin.updates.archiveHint',
                '.tar.gz (Linux, macOS), .zip (Windows) or the .base64.txt variant. Up to {{size}} MB.',
                { size: status.maxUploadSizeMB }
              )
            )}
            <details className="text-sm">
              <summary className="cursor-pointer text-gray-700 dark:text-gray-300">
                {t('admin.updates.checksumFilesSummary', 'Checksum files (optional)')}
              </summary>
              <div className="mt-3 space-y-3">
                {fileInput(
                  `${baseId}-checksums`,
                  'checksums.sha256',
                  '.sha256,.txt',
                  checksums,
                  setChecksums,
                  t(
                    'admin.updates.checksumsHint',
                    'Published next to the archive on the releases page. Archives with a signed manifest do not need it.'
                  )
                )}
                {fileInput(
                  `${baseId}-checksums-sig`,
                  'checksums.sha256.sig',
                  '.sig',
                  checksumsSig,
                  setChecksumsSig
                )}
              </div>
            </details>
            {progress !== null && (
              <div>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                  aria-label={t('admin.updates.uploadProgress', 'Upload progress')}
                  className="h-2 w-full rounded bg-gray-200 dark:bg-gray-700 overflow-hidden"
                >
                  <div className="h-2 bg-blue-600" style={{ width: `${progress}%` }} />
                </div>
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                  {progress < 100
                    ? t('admin.updates.uploading', 'Uploading… {{percent}}%', { percent: progress })
                    : t('admin.updates.verifying', 'Verifying the archive…')}
                </p>
              </div>
            )}
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={!archive || busy}
                className="inline-flex items-center px-4 py-2 rounded-md text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Icon name="upload" size="sm" className="mr-1.5" />
                {t('admin.updates.uploadAndVerify', 'Upload and verify')}
              </button>
              {busy && progress !== null && progress < 100 && (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="inline-flex items-center px-4 py-2 rounded-md text-sm font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
              )}
            </div>
          </form>
        )}

        {tab === 'server' && (
          <div
            id="tabpanel-server"
            role="tabpanel"
            aria-labelledby="tab-server"
            className="space-y-4"
          >
            <form onSubmit={handleServerPath} className="space-y-2">
              <label
                htmlFor={`${baseId}-path`}
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t('admin.updates.serverPathLabel', 'Absolute path of the archive on the server')}
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  id={`${baseId}-path`}
                  type="text"
                  value={serverPath}
                  onChange={event => setServerPath(event.target.value)}
                  disabled={busy}
                  spellCheck={false}
                  placeholder={
                    status.platform === 'windows'
                      ? 'C:\\updates\\' + expectedName
                      : '/opt/updates/' + expectedName
                  }
                  aria-describedby={`${baseId}-path-hint`}
                  className="flex-1 rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-xs text-sm"
                />
                <button
                  type="submit"
                  disabled={!serverPath.trim() || busy}
                  className="inline-flex items-center justify-center px-4 py-2 rounded-md text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('admin.updates.verify', 'Verify')}
                </button>
              </div>
              <p id={`${baseId}-path-hint`} className="text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.updates.serverPathHint',
                  'checksums.sha256 and checksums.sha256.sig in the same folder are used when present. On Windows, mapped network drives are not visible to the service account; use a UNC path (\\\\server\\share\\…).'
                )}
              </p>
            </form>

            <div>
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.updates.updatesFolder', 'Archives in {{dir}}', {
                    dir: status.localUpdateDir
                  })}
                </h4>
                <button
                  type="button"
                  onClick={() => void loadCandidates()}
                  className="text-xs text-blue-700 dark:text-blue-300 underline"
                >
                  {t('admin.updates.refresh', 'Refresh')}
                </button>
              </div>
              {candidates?.files?.length ? (
                <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-700">
                  {candidates.files.map(file => (
                    <li key={file.path} className="flex items-center justify-between gap-3 py-2">
                      <span className="text-sm text-gray-800 dark:text-gray-200 break-all">
                        {file.name}{' '}
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          ({formatBytes(file.size)})
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setServerPath(file.path);
                          handleServerPath(null, file.path);
                        }}
                        className="shrink-0 inline-flex items-center px-3 py-1.5 rounded-md text-xs font-medium text-blue-700 dark:text-blue-200 bg-blue-50 dark:bg-blue-900/40 hover:bg-blue-100 disabled:opacity-50"
                      >
                        {t('admin.updates.verify', 'Verify')}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.updates.updatesFolderEmpty',
                    'No archives found. Copy a release archive into this folder, or enter its path above.'
                  )}
                </p>
              )}
            </div>
            {busy && (
              <p className="text-sm text-gray-600 dark:text-gray-400" role="status">
                {t('admin.updates.verifying', 'Verifying the archive…')}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export default InstallFromFileCard;
