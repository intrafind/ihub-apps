// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { addCatalogProject, publishProject, removeCatalogProject } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';
import { formatSnapshotDate } from '../utils/projectProvenance';

const BUTTON =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50';

/**
 * The project catalog on a project page. Owners and editors publish the
 * project there for everyone signed in to find, or take it out; someone who
 * reaches it through the catalog adds it to their projects or removes it.
 * Nothing is shown to anyone else.
 *
 * @param {Object} props
 * @param {Object} props.project
 * @param {Object|null} props.config - `_config`; `sharing.allowCatalog` says the catalog is on.
 * @param {() => void} props.onChanged - Called after a change, for the page to read the project again.
 * @returns {JSX.Element|null}
 */
function ProjectCatalogCard({ project, config, onChanged }) {
  const { t, i18n } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const permissions = project.permissions || {};
  const catalogOn = config?.sharing?.allowCatalog === true;
  const published = Boolean(project.catalog?.publishedAt);
  const curator = permissions.canShare === true && (catalogOn || published);
  const fromCatalog = project.role === 'catalog';
  if (!curator && !fromCatalog) return null;

  const run = async action => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(projectErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  const publish = () => {
    setConfirming(false);
    run(() => publishProject(project.id, true));
  };

  return (
    <section
      className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5"
      aria-labelledby="project-catalog-title"
    >
      <h2
        id="project-catalog-title"
        className="text-base font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2"
      >
        <Icon name="globe" size="sm" className="text-gray-500" />
        {t('projects.catalog.title', 'Catalog')}
      </h2>
      {fromCatalog ? (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {project.subscribed
            ? t(
                'projects.catalog.addedHint',
                'You added this project from the catalog. Its owner and editors keep it up to date; you see only your own chats in it.'
              )
            : t(
                'projects.catalog.notAddedHint',
                'This project is in the catalog. Add it to your projects to find it in your list and in chats.'
              )}
        </p>
      ) : (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {published
            ? t(
                'projects.catalog.publishedHint',
                'Published on {{date}}. Everyone signed in can find it in the catalog and use it.',
                { date: formatSnapshotDate(project.catalog.publishedAt, i18n?.language) || '' }
              )
            : t(
                'projects.catalog.unpublishedHint',
                'Publish the project so that everyone signed in can find it in the catalog and add it.'
              )}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {fromCatalog &&
          (project.subscribed ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => removeCatalogProject(project.id))}
              className={BUTTON}
            >
              <Icon name="x" size="sm" />
              {t('projects.catalog.remove', 'Remove from my projects')}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => addCatalogProject(project.id))}
              className={BUTTON}
            >
              <Icon name="plus" size="sm" />
              {t('projects.catalog.add', 'Add to my projects')}
            </button>
          ))}
        {curator &&
          (published ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => publishProject(project.id, false))}
              className={BUTTON}
            >
              {t('projects.catalog.unpublish', 'Take out of the catalog')}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !catalogOn}
              onClick={() => setConfirming(true)}
              className={BUTTON}
            >
              <Icon name="globe" size="sm" />
              {t('projects.catalog.publish', 'Publish to the catalog')}
            </button>
          ))}
      </div>
      <ConfirmDialog
        isOpen={confirming}
        title={t('projects.catalog.confirmTitle', 'Publish to the catalog?')}
        message={t(
          'projects.catalog.confirmMessage',
          'Everyone signed in can then find this project in the catalog, read its documents and instructions, and chat with it. They do not become members: they cannot change it and do not see the members’ chats. You can take it out again at any time.'
        )}
        confirmLabel={t('projects.catalog.publish', 'Publish to the catalog')}
        onConfirm={publish}
        onDeny={() => setConfirming(false)}
      />
    </section>
  );
}

export default ProjectCatalogCard;
