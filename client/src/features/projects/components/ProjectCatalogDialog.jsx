// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { addCatalogProject, fetchProjectCatalog, removeCatalogProject } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';
import { localizedText } from '../utils/projectItems';
import { projectDisplayName } from '../utils/projectView';
import { INPUT_CLASS, SECONDARY_BUTTON } from './item-dialog/dialogStyles';

const ROW_BUTTON =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50';

/**
 * The project catalog: projects their owners published for everyone signed
 * in, and admin projects available to everyone signed in. Search it, open a project, and add one to your projects (or remove it
 * again). A project you own or are a member of is in your list already.
 *
 * Mount it only while open.
 *
 * @param {Object} props
 * @param {() => void} props.onClose
 * @param {() => void} props.onChanged - Called after a project was added or removed.
 * @returns {JSX.Element}
 */
function ProjectCatalogDialog({ onClose, onChanged }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const [query, setQuery] = useState('');
  const [items, setItems] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const searchRef = useRef(null);

  useEffect(() => {
    let active = true;
    const handle = setTimeout(() => {
      fetchProjectCatalog(query.trim())
        .then(result => active && setItems(result?.items || []))
        .catch(err => {
          if (!active) return;
          setItems([]);
          setError(projectErrorMessage(err, t));
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [query, t]);

  const toggle = async project => {
    setBusyId(project.id);
    setError(null);
    try {
      if (project.subscribed) await removeCatalogProject(project.id);
      else await addCatalogProject(project.id);
      setItems(previous =>
        previous.map(entry =>
          entry.id === project.id ? { ...entry, subscribed: !project.subscribed } : entry
        )
      );
      onChanged();
    } catch (err) {
      setError(projectErrorMessage(err, t));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidthClassName="max-w-2xl"
      labelledBy="project-catalog-dialog-title"
      initialFocusRef={searchRef}
    >
      <div className="px-6 pt-5 pb-4 space-y-3">
        <h2
          id="project-catalog-dialog-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('projects.catalog.dialogTitle', 'Project catalog')}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t(
            'projects.catalog.dialogHint',
            'Projects their owners published for everyone, and projects administrators made available to everyone. Add one to your projects to use it in your chats; its owner and editors keep it up to date.'
          )}
        </p>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('projects.catalog.search', 'Search the catalog')}
          aria-label={t('projects.catalog.search', 'Search the catalog')}
          className={INPUT_CLASS}
        />
        {items === null ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('common.loading', 'Loading...')}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {query.trim()
              ? t('projects.catalog.noMatches', 'No published project matches.')
              : t('projects.catalog.empty', 'Nothing has been published yet.')}
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
            {items.map(project => {
              const description = localizedText(project.description, language);
              // An admin project available to everyone is in everyone's list already.
              const inList = project.ownership === 'admin' || project.role !== 'catalog';
              return (
                <li key={project.id} className="px-3 py-3 flex items-start gap-3">
                  <Icon name="folder" size="md" className="mt-0.5 text-indigo-500 flex-none" />
                  <div className="flex-1 min-w-0">
                    <Link
                      to={`/projects/${encodeURIComponent(project.id)}`}
                      onClick={onClose}
                      className="font-medium text-gray-900 dark:text-gray-100 hover:text-indigo-600 dark:hover:text-indigo-400"
                    >
                      {projectDisplayName(project, language)}
                    </Link>
                    {description && (
                      <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                        {description}
                      </p>
                    )}
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {project.ownership === 'admin'
                        ? t('projects.catalog.byAdmins', 'From the administrators')
                        : t('projects.catalog.byOwner', 'By {{name}}', {
                            name:
                              project.owner?.name || t('projects.members.unknownOwner', 'Unknown')
                          })}
                      {' · '}
                      {t('projects.list.itemCount', '{{count}} items', {
                        count: project.usage?.items ?? 0
                      })}
                    </p>
                  </div>
                  {inList ? (
                    <span className="text-xs text-gray-500 dark:text-gray-400 pt-1.5">
                      {t('projects.catalog.inYourList', 'In your projects')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggle(project)}
                      disabled={busyId === project.id}
                      className={ROW_BUTTON}
                      aria-label={
                        project.subscribed
                          ? t('projects.catalog.removeNamed', 'Remove {{name}} from my projects', {
                              name: projectDisplayName(project, language)
                            })
                          : t('projects.catalog.addNamed', 'Add {{name}} to my projects', {
                              name: projectDisplayName(project, language)
                            })
                      }
                    >
                      <Icon name={project.subscribed ? 'check' : 'plus'} size="sm" />
                      {project.subscribed
                        ? t('projects.catalog.added', 'Added')
                        : t('projects.catalog.addShort', 'Add')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end">
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          {t('common.close', 'Close')}
        </button>
      </div>
    </Modal>
  );
}

export default ProjectCatalogDialog;
