// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import {
  addCatalogProject,
  addSmartCollection,
  fetchProjectCatalog,
  fetchSmartCollections,
  removeCatalogProject
} from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';

const LOADING_CATALOG = { status: 'loading', items: [], error: null };
const LOADING_COLLECTIONS = { status: 'loading', items: [], warnings: [], error: null };

/**
 * The data of the project catalog dialog: the published projects and the
 * viewer's iFinder smart collections, each loaded on its own (one failing
 * does not hold up the other), with a retry for each and the add / remove
 * actions that update the loaded lists in place.
 *
 * @param {Object} options
 * @param {boolean} options.catalogEnabled - Load the published projects.
 * @param {boolean} options.collectionsEnabled - Load the smart collections.
 * @param {() => void} options.onChanged - Called after a project was added or removed.
 * @param {Function} options.t - Translation function, for error messages.
 * @returns {{
 *   catalog: {status: string, items: Object[], error: string|null},
 *   collections: {status: string, items: Object[], warnings: Object[], error: string|null},
 *   retryCatalog: () => void,
 *   retryCollections: () => void,
 *   toggle: (entry: import('../utils/catalogSources').CatalogEntry) => Promise<void>,
 *   busyKey: string|null,
 *   rowErrors: Object<string, string|null>
 * }}
 */
export default function useProjectCatalog({ catalogEnabled, collectionsEnabled, onChanged, t }) {
  const [catalog, setCatalog] = useState(LOADING_CATALOG);
  const [collections, setCollections] = useState(LOADING_COLLECTIONS);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [collectionsAttempt, setCollectionsAttempt] = useState(0);
  const [busyKey, setBusyKey] = useState(null);
  const [rowErrors, setRowErrors] = useState({});

  useEffect(() => {
    if (!catalogEnabled) return undefined;
    let active = true;
    fetchProjectCatalog()
      .then(result => {
        if (active) setCatalog({ status: 'ready', items: result?.items || [], error: null });
      })
      .catch(err => {
        if (active) setCatalog({ status: 'error', items: [], error: projectErrorMessage(err, t) });
      });
    return () => {
      active = false;
    };
  }, [catalogEnabled, catalogAttempt, t]);

  useEffect(() => {
    if (!collectionsEnabled) return undefined;
    let active = true;
    fetchSmartCollections()
      .then(result => {
        if (!active) return;
        setCollections({
          status: 'ready',
          items: result?.items || [],
          warnings: result?.warnings || [],
          error: null
        });
      })
      .catch(err => {
        if (active) {
          setCollections({
            ...LOADING_COLLECTIONS,
            status: 'error',
            error: projectErrorMessage(err, t)
          });
        }
      });
    return () => {
      active = false;
    };
  }, [collectionsEnabled, collectionsAttempt, t]);

  const retryCatalog = useCallback(() => {
    setCatalog(LOADING_CATALOG);
    setCatalogAttempt(n => n + 1);
  }, []);

  const retryCollections = useCallback(() => {
    setCollections(LOADING_COLLECTIONS);
    setCollectionsAttempt(n => n + 1);
  }, []);

  const toggle = useCallback(
    async entry => {
      setBusyKey(entry.key);
      setRowErrors(previous => ({ ...previous, [entry.key]: null }));
      try {
        if (entry.kind === 'collection') {
          const project = await addSmartCollection({ collectionId: entry.id });
          setCollections(previous => ({
            ...previous,
            items: previous.items.map(item =>
              item.collectionId === entry.id
                ? { ...item, added: true, projectId: project.id }
                : item
            )
          }));
        } else {
          const subscribed = entry.status === 'added';
          if (subscribed) await removeCatalogProject(entry.id);
          else await addCatalogProject(entry.id);
          setCatalog(previous => ({
            ...previous,
            items: previous.items.map(item =>
              item.id === entry.id ? { ...item, subscribed: !subscribed } : item
            )
          }));
        }
        onChanged();
      } catch (err) {
        setRowErrors(previous => ({ ...previous, [entry.key]: projectErrorMessage(err, t) }));
      } finally {
        setBusyKey(null);
      }
    },
    [onChanged, t]
  );

  return { catalog, collections, retryCatalog, retryCollections, toggle, busyKey, rowErrors };
}
