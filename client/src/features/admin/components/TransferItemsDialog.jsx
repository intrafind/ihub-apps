// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import {
  fetchAdminProjects,
  getAdminApiErrorMessage,
  transferAdminProjectItems
} from '../../../api/adminApi';
import { localizedText } from '../../projects/utils/projectItems';
import {
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON
} from '../../projects/components/item-dialog/dialogStyles';

/** A project's display name: localized, the id when it has none. */
const projectLabel = (entry, language) => localizedText(entry.name, language) || entry.id;

/**
 * Moves or copies items of an admin project into another one. Mount it only
 * while open.
 *
 * Items go one by one: one that cannot (still being extracted, over the
 * target's quota) is listed after the others went, and the dialog stays open
 * so the admin can read why.
 *
 * @param {Object} props
 * @param {Object} props.project - The project the items are in.
 * @param {Array<{id: string, name: string}>} props.items - The items to transfer.
 * @param {'move'|'copy'} [props.initialMode='move']
 * @param {() => void} props.onClose
 * @param {(result: Object) => void} props.onDone - Called with the server's answer
 *   when at least one item went, as the dialog closes or is closed.
 * @returns {JSX.Element}
 */
function TransferItemsDialog({ project, items, initialMode = 'move', onClose, onDone }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const [projects, setProjects] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState(initialMode);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchAdminProjects()
      .then(list => {
        if (!cancelled) setProjects(list);
      })
      .catch(err => {
        if (!cancelled) setLoadError(getAdminApiErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const nameOf = entry => projectLabel(entry, language);
  const targets = useMemo(
    () =>
      (projects || [])
        .filter(entry => entry.id !== project.id)
        .sort((a, b) =>
          projectLabel(a, language).localeCompare(projectLabel(b, language), language)
        ),
    [projects, project.id, language]
  );

  const handleSubmit = async event => {
    event.preventDefault();
    if (!targetId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const answer = await transferAdminProjectItems(project.id, {
        itemIds: items.map(item => item.id),
        targetProjectId: targetId,
        mode
      });
      if (answer.failed.length === 0) {
        onDone(answer);
        onClose();
        return;
      }
      setResult(answer);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (result && result.transferred.length > 0) onDone(result);
    onClose();
  };

  const targetName = result ? nameOf(result.target) : '';

  return (
    <Modal
      isOpen
      onClose={close}
      labelledBy="transfer-items-title"
      maxWidthClassName="max-w-xl"
      closeOnBackdropClick={false}
    >
      {result ? (
        <div className="flex flex-col min-h-0">
          <div className="px-6 pt-5 pb-4 space-y-3 overflow-y-auto" data-testid="transfer-result">
            <h2
              id="transfer-items-title"
              className="text-lg font-semibold text-gray-900 dark:text-gray-100"
            >
              {t('admin.projects.transfer.resultTitle', 'Some items could not be transferred')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.projects.transfer.resultSummary',
                '{{done}} of {{total}} items went to "{{target}}". The others stay where they are.',
                { done: result.transferred.length, total: items.length, target: targetName }
              )}
            </p>
            <ul className="space-y-1 text-sm">
              {result.failed.map(failure => (
                <li key={failure.itemId} className="flex items-start gap-2">
                  <Icon name="exclamation-triangle" className="h-4 w-4 mt-0.5 text-amber-500" />
                  <span className="min-w-0 break-words">
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {failure.name || failure.itemId}
                    </span>
                    <span className="text-gray-600 dark:text-gray-400"> — {failure.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end">
            <button type="button" onClick={close} className={PRIMARY_BUTTON}>
              {t('common.close', 'Close')}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col min-h-0">
          <div className="px-6 pt-5 pb-4 space-y-4 overflow-y-auto">
            <div>
              <h2
                id="transfer-items-title"
                className="text-lg font-semibold text-gray-900 dark:text-gray-100"
              >
                {t('admin.projects.transfer.title', 'Move or copy items')}
              </h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {t('admin.projects.transfer.subtitle', '{{count}} items of "{{project}}"', {
                  count: items.length,
                  project: nameOf(project)
                })}
              </p>
            </div>

            <fieldset>
              <legend className={LABEL_CLASS}>
                {t('admin.projects.transfer.mode', 'What to do')}
              </legend>
              <div className="space-y-2">
                {[
                  [
                    'move',
                    t('admin.projects.transfer.move', 'Move'),
                    t(
                      'admin.projects.transfer.moveHint',
                      'The items leave this project and are in the other one.'
                    )
                  ],
                  [
                    'copy',
                    t('admin.projects.transfer.copy', 'Copy'),
                    t(
                      'admin.projects.transfer.copyHint',
                      'The items stay here and the other project gets its own copy.'
                    )
                  ]
                ].map(([value, label, hint]) => (
                  <label key={value} className="grid grid-cols-[auto_1fr] gap-x-2 text-sm">
                    <input
                      type="radio"
                      name="transfer-mode"
                      value={value}
                      checked={mode === value}
                      onChange={() => setMode(value)}
                      className="mt-1 h-4 w-4 text-indigo-600"
                    />
                    <span className="font-medium text-gray-900 dark:text-gray-100">{label}</span>
                    <span className="col-start-2 text-gray-500 dark:text-gray-400">{hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label htmlFor="transfer-target" className={LABEL_CLASS}>
                {t('admin.projects.transfer.target', 'Target project')}
              </label>
              <select
                id="transfer-target"
                value={targetId}
                disabled={!projects}
                onChange={e => setTargetId(e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">
                  {projects
                    ? t('admin.projects.transfer.chooseTarget', 'Choose a project…')
                    : t('common.loading', 'Loading...')}
                </option>
                {targets.map(entry => (
                  <option key={entry.id} value={entry.id}>
                    {nameOf(entry)} ({entry.id}) ·{' '}
                    {t('admin.projects.itemCount', '{{count}} items', {
                      count: (entry.items || []).length
                    })}
                  </option>
                ))}
              </select>
              {projects && targets.length === 0 && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.projects.transfer.noTargets',
                    'There is no other project yet. Create one first.'
                  )}
                </p>
              )}
              {loadError && (
                <p role="alert" className="mt-1 text-sm text-red-600">
                  {loadError}
                </p>
              )}
            </div>

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
            <button type="submit" disabled={!targetId || submitting} className={PRIMARY_BUTTON}>
              {submitting && <Icon name="arrow-path" className="animate-spin h-4 w-4 mr-2" />}
              {mode === 'move'
                ? t('admin.projects.transfer.confirmMove', 'Move items')
                : t('admin.projects.transfer.confirmCopy', 'Copy items')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default TransferItemsDialog;
