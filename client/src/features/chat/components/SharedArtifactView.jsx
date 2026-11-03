// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ArtifactPreview from './ArtifactPreview';
import { fetchSharedArtifact } from '../../../api';
import { artifactDisplayName, saveName } from '../utils/artifactFiles';
import { saveBlobAs } from '../../../utils/externalNavigation';

/**
 * A shared single artifact: the page behind `/share/:shareId` when the link
 * carries one generated file instead of a conversation.
 *
 * It renders with the same preview the chat uses (HTML in a sandboxed frame
 * with a locked-down CSP, sanitized SVG, images, PDF, CSV, text), so a public
 * viewer gets no more than an in-app one, and nothing here runs on the iHub
 * origin. Shown outside the app shell, like the shared chat.
 *
 * @param {Object} props - Component properties.
 * @param {Object} props.share - Viewer's view of the share (`artifact`, `title`, …).
 * @param {(value: string, language?: string) => string} props.formatDate - Date formatter.
 * @returns {JSX.Element}
 */
export default function SharedArtifactView({ share, formatDate }) {
  const { t, i18n } = useTranslation();
  const [failed, setFailed] = useState(false);
  const artifact = share.artifact || {};
  const name = artifactDisplayName(artifact);

  const getBlob = useCallback(id => fetchSharedArtifact(share.id, id), [share.id]);

  const handleDownload = async () => {
    setFailed(false);
    try {
      const blob = await getBlob(artifact.id);
      if (!saveBlobAs(blob, saveName(name))) throw new Error('save');
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      {share.mode === 'public' && (
        <div
          role="note"
          className="flex items-center justify-center gap-2 px-4 py-2 text-sm bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-100 border-b border-amber-200 dark:border-amber-800"
        >
          <Icon name="globe-alt" size="sm" />
          <span>
            {t(
              'chatSharing.artifact.publicBanner',
              'This file is publicly accessible. Anyone with the link can open it.'
            )}
          </span>
        </div>
      )}

      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
          <span className="w-11 h-11 rounded-xl flex items-center justify-center flex-none text-white bg-indigo-600">
            <Icon name="document" size="md" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">
                {share.title || name}
              </h1>
              <span className="inline-flex items-center gap-1 text-[0.6875rem] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                <Icon name="eye" size="xs" />
                {t('chatSharing.viewer.readOnly', 'Read-only')}
              </span>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
              {[
                share.sharedBy
                  ? t('chatSharing.viewer.sharedBy', {
                      name: share.sharedBy,
                      defaultValue: 'Shared by {{name}}'
                    })
                  : t('chatSharing.viewer.sharedAnonymously', 'Shared with you'),
                formatDate(share.createdAt, i18n.language)
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <button
            type="button"
            onClick={handleDownload}
            data-testid="shared-artifact-download"
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
          >
            <Icon name="download" size="sm" />
            {t('chatSharing.viewer.download', 'Download')}
          </button>
          <Link
            to="/"
            className="hidden sm:inline-flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap"
          >
            {t('chatSharing.viewer.openApp', 'Open iHub Apps')}
            <Icon name="arrow-right" size="sm" />
          </Link>
        </div>
      </header>

      <main className="flex-1 flex flex-col max-w-5xl w-full mx-auto px-2 sm:px-6 py-4">
        {failed && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-2">
            {t('chatSharing.viewer.artifactFailed', 'The file could not be loaded.')}
          </p>
        )}
        <ArtifactPreview artifact={artifact} getBlob={getBlob} />
        {share.expiresAt && (
          <p className="text-xs text-gray-500 dark:text-gray-400 text-center mt-4">
            {t('chatSharing.viewer.expires', {
              date: formatDate(share.expiresAt, i18n.language),
              defaultValue: 'This link expires on {{date}}.'
            })}
          </p>
        )}
      </main>
    </div>
  );
}
