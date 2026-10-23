// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { addCatalogProject, publishProject, removeCatalogProject } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';
import { formatSnapshotDate } from '../utils/projectProvenance';
import ProjectPanelRow, { ROW_ACTION } from './ProjectPanelRow';

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
  // Publishing also takes the `projectSharing` permission; taking a project
  // out does not, and a full admin may take out anyone's (an owner who left).
  const mayPublish = permissions.canShare === true && config?.userProjects?.canShare === true;
  const mayUnpublish = permissions.canShare === true || project.role === 'admin';
  const curator = published ? mayUnpublish : mayPublish && catalogOn;
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

  // One action, on the right of the row.
  let action = null;
  if (fromCatalog) {
    action = project.subscribed ? (
      <button
        type="button"
        disabled={busy}
        onClick={() => run(() => removeCatalogProject(project.id))}
        className={ROW_ACTION}
      >
        {t('projects.catalog.remove', 'Remove from my projects')}
      </button>
    ) : (
      <button
        type="button"
        disabled={busy}
        onClick={() => run(() => addCatalogProject(project.id))}
        className={ROW_ACTION}
      >
        {t('projects.catalog.add', 'Add to my projects')}
      </button>
    );
  } else if (curator) {
    action = published ? (
      <button
        type="button"
        disabled={busy}
        onClick={() => run(() => publishProject(project.id, false))}
        className={ROW_ACTION}
      >
        {t('projects.catalog.unpublish', 'Take out of the catalog')}
      </button>
    ) : (
      <button
        type="button"
        disabled={busy || !catalogOn}
        onClick={() => setConfirming(true)}
        className={ROW_ACTION}
      >
        {t('projects.catalog.publish', 'Publish to the catalog')}
      </button>
    );
  }

  return (
    <>
      <ProjectPanelRow
        icon="globe"
        title={t('projects.catalog.title', 'Catalog')}
        titleId="project-catalog-title"
        action={action}
      >
        <p className="text-gray-600 dark:text-gray-400">
          {fromCatalog
            ? project.subscribed
              ? t(
                  'projects.catalog.addedHint',
                  'You added this project from the catalog; its owner and editors keep it up to date. New chat starts a chat with the project attached. Your chats stay yours: its members do not see them.'
                )
              : t(
                  'projects.catalog.notAddedHint',
                  'This project is in the catalog. Add it to your projects to find it in your list and in chats.'
                )
            : published && !catalogOn
              ? t(
                  'projects.catalog.publishedOffHint',
                  'Published, but the catalog is switched off: nobody finds or uses it through the catalog until an administrator turns it on again.'
                )
              : published
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
        {error && (
          <p role="alert" className="mt-2 text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </ProjectPanelRow>
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
    </>
  );
}

export default ProjectCatalogCard;
