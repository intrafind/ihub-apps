// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import StreamingMarkdown from '../../../chat/components/StreamingMarkdown';

/** The order the note categories are shown in, with their labels. */
const CATEGORIES = ['breaking', 'features', 'fixes'];

/**
 * A localized release summary: the catalog carries `{ en, de }`, the admin
 * API of installed definitions already picked the language.
 */
export function releaseSummary(summary, lang) {
  if (!summary) return '';
  if (typeof summary === 'string') return summary;
  return summary[lang] || summary.en || Object.values(summary)[0] || '';
}

/**
 * Is `version` newer than `than`? Plain numeric semver compare (prereleases
 * compare by their numeric prefix), enough to pick the releases between an
 * installed and the latest version.
 */
export function isNewerVersion(version, than) {
  if (!version || !than) return false;
  const a = String(version).split('-')[0].split('.').map(Number);
  const b = String(than).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The releases between an installed version (exclusive) and the latest one
 * (inclusive), newest first, from a history that is already newest first.
 */
export function releasesBetween(releases, installedVersion, latestVersion) {
  return (releases || []).filter(
    r =>
      (!installedVersion || isNewerVersion(r.version, installedVersion)) &&
      (!latestVersion || !isNewerVersion(r.version, latestVersion))
  );
}

function NoteFile({ path, load }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ status: 'idle', text: null, error: null });

  const toggle = async () => {
    if (state.status === 'open') {
      setState(s => ({ ...s, status: 'closed' }));
      return;
    }
    if (state.text !== null) {
      setState(s => ({ ...s, status: 'open' }));
      return;
    }
    setState({ status: 'loading', text: null, error: null });
    try {
      const text = await load(path);
      setState({ status: 'open', text, error: null });
    } catch (err) {
      setState({
        status: 'error',
        text: null,
        error:
          err?.message || t('admin.integrationReleases.loadFailed', 'Could not load the notes.')
      });
    }
  };

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={state.status === 'open'}
        className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
      >
        {state.status === 'loading'
          ? t('admin.integrationReleases.loading', 'Loading…')
          : state.status === 'open'
            ? t('admin.integrationReleases.hideNotes', 'Hide notes')
            : t('admin.integrationReleases.showNotes', 'Show notes')}
      </button>
      {state.status === 'error' && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}
      {state.status === 'open' && state.text !== null && (
        <div className="mt-2 prose prose-sm dark:prose-invert max-w-none text-sm border-l-2 border-gray-200 dark:border-gray-700 pl-3">
          <StreamingMarkdown content={state.text} />
        </div>
      )}
    </div>
  );
}

/**
 * The release history of an integration definition: one entry per version
 * with its date, one-line summary and, per note category, a control that
 * fetches and renders the Markdown note file on demand through `loadFile`.
 *
 * @param {object} props
 * @param {Array<{ version: string, date?: string, summary?: object|string, notes?: object }>} props.releases
 * @param {(path: string) => Promise<string>} props.loadFile - fetches one note file by its companion path
 * @param {string} [props.installedVersion] - marked in the list when given
 * @param {string} [props.emptyText]
 */
function IntegrationReleaseNotes({ releases, loadFile, installedVersion, emptyText }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language?.split('-')[0] || 'en';
  if (!releases || releases.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {emptyText || t('admin.integrationReleases.empty', 'No release notes yet.')}
      </p>
    );
  }
  const categoryLabel = category =>
    ({
      breaking: t('admin.integrationReleases.category.breaking', 'Breaking changes'),
      features: t('admin.integrationReleases.category.features', 'Features'),
      fixes: t('admin.integrationReleases.category.fixes', 'Fixes')
    })[category] || category;

  return (
    <ol className="space-y-4" data-testid="integration-releases">
      {releases.map(release => (
        <li key={release.version} className="text-sm">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">
              v{release.version}
            </span>
            {release.date && (
              <span className="text-xs text-gray-500 dark:text-gray-400">{release.date}</span>
            )}
            {installedVersion && release.version === installedVersion && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                {t('admin.integrationReleases.installed', 'installed')}
              </span>
            )}
            {release.notes?.breaking && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">
                {t('admin.integrationReleases.category.breaking', 'Breaking changes')}
              </span>
            )}
          </div>
          {releaseSummary(release.summary, lang) && (
            <p className="mt-0.5 text-gray-700 dark:text-gray-300">
              {releaseSummary(release.summary, lang)}
            </p>
          )}
          {CATEGORIES.filter(category => release.notes?.[category]).map(category => (
            <div key={category} className="mt-1 flex items-baseline gap-2">
              <span className="text-xs text-gray-500 dark:text-gray-400 w-28 shrink-0">
                {categoryLabel(category)}
              </span>
              <NoteFile path={release.notes[category]} load={loadFile} />
            </div>
          ))}
        </li>
      ))}
    </ol>
  );
}

export default IntegrationReleaseNotes;
