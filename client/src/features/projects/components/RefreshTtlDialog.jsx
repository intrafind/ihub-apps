// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import { projectErrorMessage } from '../utils/projectErrors';
import {
  REFRESH_MODES,
  REFRESH_NEVER,
  formatRefreshTime,
  parseRefreshMode,
  parseRefreshTtl,
  refreshModeLabel,
  refreshTtlChoices,
  refreshTtlLabel
} from '../utils/refreshTtl';
import {
  HINT_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON
} from './item-dialog/dialogStyles';

/**
 * Sets a refresh TTL (#3536) and a refresh mode (#3622): a project's default,
 * or one item's own. The first choice of each keeps the inherited one (the
 * platform's for a project, the project's for an item), shown with its value.
 * The mode says when an outdated snapshot is refreshed: automatically while
 * the project is used, or only when it is used; a TTL of `never` refreshes
 * only by hand, in either mode.
 *
 * For an item it also shows when the snapshot was taken, when its source was
 * last checked and when it is checked next.
 *
 * Mount it only while open.
 *
 * @param {Object} props
 * @param {'project'|'item'} props.scope
 * @param {number|'never'|null|undefined} props.value - The TTL set at this level, or null.
 * @param {number|'never'|null|undefined} [props.inherited] - What applies without one.
 * @param {'always'|'auto'|'onDemand'|null|undefined} [props.mode] - The mode set at this level, or null.
 * @param {'always'|'auto'|'onDemand'|null|undefined} [props.inheritedMode] - The mode without one.
 * @param {Object} [props.item] - The item (scope `item`), for its schedule.
 * @param {() => void} props.onClose
 * @param {(changes: {refreshTtl?: number|'never'|null, refreshMode?: string|null}) =>
 *   Promise<boolean>} props.onSave - Gets what changed; resolves `true` on success; a
 *   rejection is shown in the dialog.
 * @returns {JSX.Element}
 */
function RefreshTtlDialog({
  scope,
  value,
  inherited = null,
  mode = null,
  inheritedMode = null,
  item = null,
  onClose,
  onSave
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const current = value ?? null;
  const currentMode = mode ?? null;
  const [choice, setChoice] = useState(current === null ? '' : String(current));
  const [modeChoice, setModeChoice] = useState(currentMode ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const selectRef = useRef(null);
  const ttlChanged = parseRefreshTtl(choice) !== current;
  const modeChanged = parseRefreshMode(modeChoice) !== currentMode;
  const changed = ttlChanged || modeChanged;
  // `never` refreshes only by hand: the mode does not apply then.
  const effectiveTtl = parseRefreshTtl(choice) ?? inherited;
  const manualOnly = effectiveTtl === REFRESH_NEVER;
  const page = item?.kind === 'url';
  const schedule = item?.refresh;

  const handleSubmit = async event => {
    event.preventDefault();
    if (!changed) return;
    setSaving(true);
    setError(null);
    let ok = false;
    try {
      ok = await onSave({
        ...(ttlChanged ? { refreshTtl: parseRefreshTtl(choice) } : {}),
        ...(modeChanged ? { refreshMode: parseRefreshMode(modeChoice) } : {})
      });
    } catch (err) {
      setError(projectErrorMessage(err, t));
    }
    setSaving(false);
    if (ok) onClose();
  };

  const inheritedLabel = inherited ? refreshTtlLabel(inherited, t) : '';

  return (
    <Modal isOpen onClose={onClose} labelledBy="refresh-ttl-title" initialFocusRef={selectRef}>
      <form onSubmit={handleSubmit}>
        <div className="px-6 pt-5 pb-4 space-y-3">
          <h2
            id="refresh-ttl-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {scope === 'item'
              ? t('projects.refresh.itemTitle', 'Refresh schedule')
              : t('projects.refresh.projectTitle', 'Refresh of files and web pages')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {scope === 'item'
              ? page
                ? t(
                    'projects.refresh.itemPageHint',
                    'This web page is stored as a snapshot. It is read again when this time has passed; an unchanged page keeps its text.'
                  )
                : t(
                    'projects.refresh.itemFileHint',
                    'This file was downloaded from a website. It is downloaded again when this time has passed; an unchanged file keeps its text.'
                  )
              : t(
                  'projects.refresh.projectHint',
                  'How long files downloaded from websites and web pages are taken as current in this project. Each item can set its own.'
                )}
          </p>
          <div>
            <label htmlFor="refresh-mode-select" className={LABEL_CLASS}>
              {t('projects.refresh.modeLabel', 'Refresh')}
            </label>
            <select
              id="refresh-mode-select"
              value={modeChoice}
              onChange={e => setModeChoice(e.target.value)}
              disabled={manualOnly || saving}
              aria-describedby="refresh-mode-hint"
              className={INPUT_CLASS}
            >
              <option value="">
                {scope === 'item'
                  ? t('projects.refresh.inheritProject', 'Project setting ({{ttl}})', {
                      ttl: inheritedMode
                        ? refreshModeLabel(inheritedMode, t)
                        : t('projects.refresh.default', 'default')
                    })
                  : t(
                      'projects.refresh.inheritPlatform',
                      'Default of this installation ({{ttl}})',
                      {
                        ttl: inheritedMode
                          ? refreshModeLabel(inheritedMode, t)
                          : t('projects.refresh.default', 'default')
                      }
                    )}
              </option>
              {REFRESH_MODES.map(entry => (
                <option key={entry} value={entry}>
                  {refreshModeLabel(entry, t)}
                </option>
              ))}
            </select>
            <p id="refresh-mode-hint" className={HINT_CLASS}>
              {manualOnly
                ? t('projects.refresh.modeNeverHint', 'Set to never: refreshed only by hand.')
                : t(
                    'projects.refresh.modeHint',
                    'Always: refreshed in the background, used or not. Automatically: refreshed in the background while the project is used; a project nobody used for a while is refreshed when it is used again. When the project is used: refreshed then, by a chat or a search; answers use the stored text until it is done.'
                  )}
            </p>
          </div>
          <div>
            <label htmlFor="refresh-ttl-select" className={LABEL_CLASS}>
              {t('projects.refresh.label', 'Refresh after')}
            </label>
            <select
              id="refresh-ttl-select"
              ref={selectRef}
              value={choice}
              onChange={e => setChoice(e.target.value)}
              disabled={saving}
              className={INPUT_CLASS}
            >
              <option value="">
                {scope === 'item'
                  ? t('projects.refresh.inheritProject', 'Project setting ({{ttl}})', {
                      ttl: inheritedLabel || t('projects.refresh.default', 'default')
                    })
                  : t(
                      'projects.refresh.inheritPlatform',
                      'Default of this installation ({{ttl}})',
                      {
                        ttl: inheritedLabel || t('projects.refresh.default', 'default')
                      }
                    )}
              </option>
              {refreshTtlChoices(value).map(ttl => (
                <option key={ttl} value={String(ttl)}>
                  {refreshTtlLabel(ttl, t)}
                </option>
              ))}
            </select>
          </div>
          {scope === 'item' && schedule?.scheduled && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('projects.refresh.snapshotAt', 'Text taken')}
              </dt>
              <dd className="text-gray-800 dark:text-gray-200">
                {formatRefreshTime(item.snapshotAt, language) || '—'}
              </dd>
              <dt className="text-gray-500 dark:text-gray-400">
                {t('projects.refresh.checkedAt', 'Last checked')}
              </dt>
              <dd className="text-gray-800 dark:text-gray-200">
                {formatRefreshTime(schedule.checkedAt, language) || '—'}
              </dd>
              <dt className="text-gray-500 dark:text-gray-400">
                {t('projects.refresh.nextAtLabel', 'Next refresh')}
              </dt>
              <dd className="text-gray-800 dark:text-gray-200">
                {schedule.ttl === REFRESH_NEVER
                  ? t('projects.refresh.manualOnly', 'Refreshed only by hand')
                  : schedule.background === false
                    ? schedule.expired
                      ? t('projects.refresh.onUseNow', 'The next time the project is used')
                      : t('projects.refresh.onUseAfter', 'Refreshed when used after {{date}}', {
                          date: formatRefreshTime(schedule.outdatedAt, language) || '—'
                        })
                    : formatRefreshTime(schedule.nextAt, language) || '—'}
              </dd>
            </dl>
          )}
          <p className={HINT_CLASS}>
            {t('projects.refresh.nowHint', '"Refresh" in the item menu reads it again right away.')}
          </p>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-end gap-2">
          {error && (
            <p role="alert" className="mr-auto text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button type="submit" disabled={!changed || saving} className={PRIMARY_BUTTON}>
            {t('common.save', 'Save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default RefreshTtlDialog;
