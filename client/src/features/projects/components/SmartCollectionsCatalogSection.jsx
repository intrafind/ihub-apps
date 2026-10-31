// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { addSmartCollection, fetchSmartCollections } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';

const ROW_BUTTON =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50';

/**
 * The catalog's section of the viewer's own iFinder smart collections: add one
 * to your projects, and it becomes a project that keeps a default app,
 * instructions and chats, while its documents stay in iFinder. One already added
 * links to its project.
 *
 * @param {Object} props
 * @param {string} props.query - The catalog's search, matched against name and description.
 * @param {() => void} props.onClose - Closes the catalog (after following a link).
 * @param {() => void} props.onChanged - Called after a collection was added.
 * @returns {JSX.Element|null}
 */
function SmartCollectionsCatalogSection({ query, onClose, onChanged }) {
  const { t } = useTranslation();
  const [listing, setListing] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    fetchSmartCollections()
      .then(result => active && setListing(result || { available: false, items: [] }))
      .catch(err => {
        if (!active) return;
        setListing({ available: true, items: [] });
        setError(projectErrorMessage(err, t));
      });
    return () => {
      active = false;
    };
  }, [t]);

  if (listing && !listing.available && !listing.warnings?.length) return null;

  const add = async entry => {
    setBusyId(entry.collectionId);
    setError(null);
    try {
      const project = await addSmartCollection({ collectionId: entry.collectionId });
      setListing(previous => ({
        ...previous,
        items: previous.items.map(item =>
          item.collectionId === entry.collectionId
            ? { ...item, added: true, projectId: project.id }
            : item
        )
      }));
      onChanged();
    } catch (err) {
      setError(projectErrorMessage(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const items = (listing?.items || []).filter(
    entry => !needle || `${entry.name} ${entry.description}`.toLowerCase().includes(needle)
  );

  return (
    <section aria-labelledby="catalog-smart-collections-title" className="space-y-2">
      <h3
        id="catalog-smart-collections-title"
        className="text-sm font-semibold text-gray-900 dark:text-gray-100"
      >
        {t('projects.catalog.collectionsTitle', 'Your iFinder smart collections')}
      </h3>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {t(
          'projects.catalog.collectionsHint',
          'Add a collection to your projects to chat with it, with a default app and instructions of its own. Its documents stay in iFinder.'
        )}
      </p>
      {listing === null ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('common.loading', 'Loading...')}
        </p>
      ) : listing.warnings?.length ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {t(
            'projects.catalog.collectionsUnavailable',
            'iFinder could not be reached, so your smart collections are missing from this list.'
          )}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {needle
            ? t('projects.catalog.noCollectionMatches', 'No smart collection matches.')
            : t('projects.catalog.noCollections', 'You have no smart collections in iFinder.')}
        </p>
      ) : (
        <ul
          className="max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md"
          data-testid="catalog-smart-collections"
        >
          {items.map(entry => (
            <li key={entry.collectionId} className="px-3 py-3 flex items-start gap-3">
              <Icon
                name="magnifying-glass"
                size="md"
                className="mt-0.5 text-teal-600 dark:text-teal-400 flex-none"
              />
              <div className="flex-1 min-w-0">
                {entry.added && entry.projectId ? (
                  <Link
                    to={`/projects/${encodeURIComponent(entry.projectId)}`}
                    onClick={onClose}
                    className="font-medium text-gray-900 dark:text-gray-100 hover:text-indigo-600 dark:hover:text-indigo-400"
                  >
                    {entry.name}
                  </Link>
                ) : (
                  <span className="font-medium text-gray-900 dark:text-gray-100">{entry.name}</span>
                )}
                {entry.description && (
                  <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                    {entry.description}
                  </p>
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('projects.ifinder.documentCount', '{{count}} documents', {
                    count: entry.documentCount ?? 0
                  })}
                </p>
              </div>
              {entry.added ? (
                <span className="text-xs text-gray-500 dark:text-gray-400 pt-1.5">
                  {t('projects.catalog.inYourList', 'In your projects')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => add(entry)}
                  disabled={busyId === entry.collectionId}
                  className={ROW_BUTTON}
                  aria-label={t('projects.catalog.addNamed', 'Add {{name}} to my projects', {
                    name: entry.name
                  })}
                >
                  <Icon name="plus" size="sm" />
                  {t('projects.catalog.addShort', 'Add')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}

export default SmartCollectionsCatalogSection;
