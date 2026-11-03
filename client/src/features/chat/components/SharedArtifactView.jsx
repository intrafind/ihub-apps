// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ArtifactViewer from './ArtifactViewer';
import { fetchSharedArtifact } from '../../../api';

/**
 * A shared single artifact: the page behind `/share/:shareId` when the link
 * carries one generated file instead of a conversation.
 *
 * It is the immersive viewer as a whole page: one slim toolbar and the
 * artifact filling the rest of the window. HTML stays in a sandboxed frame with
 * a locked-down CSP, SVG is sanitized, so a public viewer gets no more than an
 * in-app one and nothing here runs on the iHub origin. With `?embed=1` (for an
 * `<iframe>` in another page) the toolbar is dropped and only the artifact
 * remains. Shown outside the app shell, like the shared chat.
 *
 * @param {Object} props - Component properties.
 * @param {Object} props.share - Viewer's view of the share (`artifact`, `title`, …).
 * @param {(value: string, language?: string) => string} props.formatDate - Date formatter.
 * @returns {JSX.Element}
 */
export default function SharedArtifactView({ share, formatDate }) {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  const embed = searchParams.get('embed') === '1';
  const artifact = share.artifact || {};

  const getBlob = useCallback(item => fetchSharedArtifact(share.id, item.id), [share.id]);

  const notes = [
    share.mode === 'public'
      ? t(
          'chatSharing.artifact.publicBanner',
          'This file is publicly accessible. Anyone with the link can open it.'
        )
      : null,
    share.sharedBy
      ? t('chatSharing.viewer.sharedBy', {
          name: share.sharedBy,
          defaultValue: 'Shared by {{name}}'
        })
      : t('chatSharing.viewer.sharedAnonymously', 'Shared with you'),
    share.expiresAt
      ? t('chatSharing.viewer.expires', {
          date: formatDate(share.expiresAt, i18n.language),
          defaultValue: 'This link expires on {{date}}.'
        })
      : null
  ].filter(Boolean);

  const extra = (
    <div className="flex min-w-0 items-center gap-2 pr-1">
      <span
        className="hidden md:inline-flex items-center gap-1 truncate text-xs text-gray-600 dark:text-gray-300"
        data-testid="shared-artifact-notes"
      >
        {share.mode === 'public' && <Icon name="globe-alt" size="xs" />}
        {notes.join(' · ')}
      </span>
      <span className="hidden sm:inline-flex items-center gap-1 text-[0.6875rem] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
        <Icon name="eye" size="xs" />
        {t('chatSharing.viewer.readOnly', 'Read-only')}
      </span>
      <Link
        to="/"
        className="hidden lg:inline-flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap"
      >
        {t('chatSharing.viewer.openApp', 'Open iHub Apps')}
        <Icon name="arrow-right" size="sm" />
      </Link>
    </div>
  );

  return (
    <ArtifactViewer
      mode="page"
      embed={embed}
      artifact={{ ...artifact, name: artifact.name || share.title }}
      artifacts={[]}
      getBlob={getBlob}
      toolbarExtra={extra}
    />
  );
}
