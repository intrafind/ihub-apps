// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import {
  fetchAdminProjectDependencies,
  getAdminApiErrorMessage,
  mergeAdminProjects
} from '../../../api/adminApi';
import { localizedText } from '../../projects/utils/projectItems';
import {
  HINT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON
} from '../../projects/components/item-dialog/dialogStyles';

/** The project with the most items, the natural home of the others. */
function defaultTarget(projects) {
  return projects.reduce(
    (best, entry) => ((entry.items || []).length > (best.items || []).length ? entry : best),
    projects[0]
  );
}

/**
 * Merges several admin projects into one. Mount it only while open.
 *
 * The admin picks which of the selected projects stays; the items of the
 * others move into it, the apps, workflows and agents that linked them link
 * the remaining project instead, and the emptied projects can be deleted. A
 * project whose items did not all move is kept, with its links, and listed.
 *
 * @param {Object} props
 * @param {Array<Object>} props.projects - The selected projects (at least two).
 * @param {() => void} props.onClose
 * @param {(result: Object) => void} props.onDone - Called with the server's
 *   answer once the merge ran, as the dialog is closed.
 * @returns {JSX.Element}
 */
function MergeProjectsDialog({ projects, onClose, onDone }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const [targetId, setTargetId] = useState(() => defaultTarget(projects).id);
  const [deleteSources, setDeleteSources] = useState(true);
  // Who links the projects that go away, for the target it was loaded for.
  const [loadedDependents, setLoadedDependents] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const nameOf = entry => localizedText(entry.name, language) || entry.id;
  const sources = useMemo(
    () => projects.filter(entry => entry.id !== targetId),
    [projects, targetId]
  );

  // Those links are re-pointed to the kept project.
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled(sources.map(entry => fetchAdminProjectDependencies(entry.id))).then(
      settled => {
        if (cancelled) return;
        const unique = new Map();
        for (const outcome of settled) {
          if (outcome.status !== 'fulfilled') continue;
          for (const dependency of outcome.value) {
            unique.set(`${dependency.type}:${dependency.id}`, dependency);
          }
        }
        setLoadedDependents({ targetId, list: [...unique.values()] });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [sources, targetId]);
  const dependents = loadedDependents?.targetId === targetId ? loadedDependents.list : null;

  const itemsToMove = sources.reduce((sum, entry) => sum + (entry.items || []).length, 0);
  const withInstructions = sources.filter(entry => (entry.instructions || '').trim());

  const handleSubmit = async event => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      setResult(
        await mergeAdminProjects({
          sourceIds: sources.map(entry => entry.id),
          targetId,
          deleteSources
        })
      );
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (result) onDone(result);
    onClose();
  };

  const sourceName = id => {
    const entry = projects.find(candidate => candidate.id === id);
    return entry ? nameOf(entry) : id;
  };

  if (result) {
    return (
      <Modal
        isOpen
        onClose={close}
        labelledBy="merge-projects-title"
        maxWidthClassName="max-w-xl"
        closeOnBackdropClick={false}
      >
        <div className="px-6 pt-5 pb-4 space-y-3 overflow-y-auto" data-testid="merge-result">
          <h2
            id="merge-projects-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('admin.projects.merge.resultTitle', 'Merge finished')}
          </h2>
          <ul className="space-y-3 text-sm">
            {result.sources.map(entry => (
              <li key={entry.id}>
                <div className="flex items-center gap-2">
                  <Icon
                    name={entry.merged && !entry.error ? 'check-circle' : 'exclamation-triangle'}
                    className={`h-4 w-4 ${
                      entry.merged && !entry.error ? 'text-green-500' : 'text-amber-500'
                    }`}
                  />
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {sourceName(entry.id)}
                  </span>
                  <span className="text-gray-600 dark:text-gray-400">
                    {t('admin.projects.merge.moved', '{{count}} items moved', {
                      count: entry.moved
                    })}
                    {entry.deleted ? ` · ${t('admin.projects.merge.deleted', 'deleted')}` : ''}
                    {entry.relinked.length > 0
                      ? ` · ${t('admin.projects.merge.relinked', '{{count}} links updated', {
                          count: entry.relinked.length
                        })}`
                      : ''}
                  </span>
                </div>
                {!entry.merged && (
                  <p className="mt-1 ml-6 text-amber-700 dark:text-amber-300">
                    {t(
                      'admin.projects.merge.kept',
                      'Kept with its links, because not every item could move:'
                    )}
                  </p>
                )}
                {entry.failed.map(failure => (
                  <p
                    key={failure.itemId}
                    className="ml-6 text-gray-600 dark:text-gray-400 break-words"
                  >
                    {failure.name || failure.itemId} — {failure.message}
                  </p>
                ))}
                {entry.error && <p className="mt-1 ml-6 text-red-600 break-words">{entry.error}</p>}
              </li>
            ))}
          </ul>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end">
          <button type="button" onClick={close} className={PRIMARY_BUTTON}>
            {t('common.close', 'Close')}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      isOpen
      onClose={close}
      labelledBy="merge-projects-title"
      maxWidthClassName="max-w-xl"
      closeOnBackdropClick={false}
    >
      <form onSubmit={handleSubmit} className="flex flex-col min-h-0">
        <div className="px-6 pt-5 pb-4 space-y-4 overflow-y-auto">
          <div>
            <h2
              id="merge-projects-title"
              className="text-lg font-semibold text-gray-900 dark:text-gray-100"
            >
              {t('admin.projects.merge.title', 'Merge projects')}
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.projects.merge.intro',
                'The items of the other projects move into the one you keep. Apps, workflows and agents that linked them link the kept project instead.'
              )}
            </p>
          </div>

          <fieldset>
            <legend className={LABEL_CLASS}>
              {t('admin.projects.merge.keep', 'Project to keep')}
            </legend>
            <div className="space-y-1">
              {projects.map(entry => (
                <label key={entry.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="merge-target"
                    value={entry.id}
                    checked={targetId === entry.id}
                    onChange={() => setTargetId(entry.id)}
                    className="h-4 w-4 text-indigo-600"
                  />
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {nameOf(entry)}
                  </span>
                  <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                    {entry.id}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400">
                    ·{' '}
                    {t('admin.projects.itemCount', '{{count}} items', {
                      count: (entry.items || []).length
                    })}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="merge-summary">
            {t(
              'admin.projects.merge.summary',
              '{{items}} items move from {{projects}} projects into "{{target}}".',
              {
                items: itemsToMove,
                projects: sources.length,
                target: nameOf(projects.find(entry => entry.id === targetId))
              }
            )}{' '}
            {dependents === null
              ? t('common.loading', 'Loading...')
              : t(
                  'admin.projects.merge.dependents',
                  '{{count}} apps, workflows or agents will link the kept project instead.',
                  { count: dependents.length }
                )}
          </p>

          {withInstructions.length > 0 && (
            <div
              role="status"
              className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-sm text-amber-800 dark:text-amber-200"
            >
              {t(
                'admin.projects.merge.instructionsWarning',
                'Instructions are not carried over. These projects have some: {{names}}.',
                { names: withInstructions.map(nameOf).join(', ') }
              )}
            </div>
          )}

          <label className="grid grid-cols-[auto_1fr] gap-x-2 text-sm">
            <input
              type="checkbox"
              checked={deleteSources}
              onChange={e => setDeleteSources(e.target.checked)}
              className="mt-1 h-4 w-4 text-indigo-600 border-gray-300 rounded-sm"
            />
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {t('admin.projects.merge.deleteSources', 'Delete the emptied projects')}
            </span>
            <span className={`col-start-2 ${HINT_CLASS}`}>
              {t(
                'admin.projects.merge.deleteHint',
                'Only a project whose items all moved is deleted.'
              )}
            </span>
          </label>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button type="button" onClick={close} className={SECONDARY_BUTTON}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button type="submit" disabled={submitting} className={PRIMARY_BUTTON}>
            {submitting && <Icon name="arrow-path" className="animate-spin h-4 w-4 mr-2" />}
            {t('admin.projects.merge.confirm', 'Merge projects')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default MergeProjectsDialog;
