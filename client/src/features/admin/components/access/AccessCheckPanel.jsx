// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { fetchAccessVerdict, getAdminApiErrorMessage } from '../../../../api/adminApi';
import {
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON_CLASS,
  RADIO_CLASS
} from '../formStyles';
import { formatSentence, groupNamer, reasonSentence } from './accessExplanation';

/** How each status of a reason looks. */
const STATUS_STYLE = {
  ok: { icon: 'check-circle', className: 'text-green-700 dark:text-green-400' },
  blocked: { icon: 'x-circle', className: 'text-red-700 dark:text-red-400' },
  warning: { icon: 'exclamation-triangle', className: 'text-amber-700 dark:text-amber-400' }
};

/** The headline of a verdict, by subject kind. Written out for the i18n test. */
const VERDICT_KEYS = {
  group: {
    available: 'admin.access.check.verdict.availableGroup',
    unavailable: 'admin.access.check.verdict.unavailableGroup'
  },
  user: {
    available: 'admin.access.check.verdict.availableUser',
    unavailable: 'admin.access.check.verdict.unavailableUser'
  },
  anonymous: {
    available: 'admin.access.check.verdict.availableAnonymous',
    unavailable: 'admin.access.check.verdict.unavailableAnonymous'
  }
};

/**
 * The group a check starts with: the group of all regular users when there is
 * one, else the first group that is a team rather than an implicit group.
 */
function defaultGroupId(groups) {
  const rows = Array.isArray(groups) ? groups : [];
  if (rows.some(row => row.id === 'users')) return 'users';
  return (rows.find(row => !row.implicit) || rows[0])?.id || '';
}

/**
 * "Why can't someone see this?": pick a group (or type a user) and get the
 * server's verdict with its reasons — switched off, a feature off, not granted,
 * granted through a wildcard and from which group, no usable model, …
 *
 * The verdict comes from `GET /api/admin/access/{type}/{id}/verdict`; this
 * component only words it.
 *
 * @param {object} props
 * @param {'apps'|'models'} props.type
 * @param {string} props.id - The app or model id
 * @param {Array<{id: string, name: string, implicit?: boolean}>} props.groups - The
 *   groups to offer, from the item's access view
 * @param {string} [props.className]
 * @returns {JSX.Element}
 */
function AccessCheckPanel({ type, id, groups, className = '' }) {
  const { t } = useTranslation();
  const baseId = useId();
  const [mode, setMode] = useState('group');
  const [groupId, setGroupId] = useState(() => defaultGroupId(groups));
  const [userId, setUserId] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);
  const requestRef = useRef(0);

  const rows = useMemo(() => (Array.isArray(groups) ? groups : []), [groups]);
  const nameOf = useMemo(() => groupNamer(rows), [rows]);
  const selectedGroup = rows.some(row => row.id === groupId) ? groupId : defaultGroupId(rows);
  const canCheck = mode === 'group' ? Boolean(selectedGroup) : userId.trim().length > 0;

  const runCheck = async () => {
    if (!canCheck) return;
    const request = ++requestRef.current;
    setChecking(true);
    setError(null);
    try {
      const subject = mode === 'group' ? { groupId: selectedGroup } : { userId: userId.trim() };
      const verdict = await fetchAccessVerdict(type, id, subject);
      if (request === requestRef.current) setResult(verdict);
    } catch (err) {
      if (request === requestRef.current) {
        setResult(null);
        setError(getAdminApiErrorMessage(err));
      }
    } finally {
      if (request === requestRef.current) setChecking(false);
    }
  };

  const verdictKey = result
    ? VERDICT_KEYS[result.subject?.kind]?.[result.verdict] || VERDICT_KEYS.group[result.verdict]
    : null;

  return (
    <section
      className={`rounded-md border border-gray-200 dark:border-gray-700 p-4 ${className}`.trim()}
      aria-labelledby={`${baseId}-title`}
      data-testid="access-check"
    >
      <h4 id={`${baseId}-title`} className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t('admin.access.check.title')}
      </h4>
      <p className={HELP_CLASS}>{t('admin.access.check.description')}</p>

      <fieldset className="mt-3">
        <legend className="sr-only">{t('admin.access.check.subjectLegend')}</legend>
        <div className="flex flex-wrap gap-4 text-sm text-gray-700 dark:text-gray-300">
          {['group', 'user'].map(option => (
            <label key={option} className="inline-flex items-center gap-2">
              <input
                type="radio"
                name={`${baseId}-mode`}
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
                className={RADIO_CLASS}
              />
              {option === 'group'
                ? t('admin.access.check.byGroup')
                : t('admin.access.check.byUser')}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-3 flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1 min-w-0">
          {mode === 'group' ? (
            <>
              <label htmlFor={`${baseId}-group`} className={LABEL_CLASS}>
                {t('admin.access.check.groupLabel')}
              </label>
              <select
                id={`${baseId}-group`}
                value={selectedGroup}
                onChange={event => setGroupId(event.target.value)}
                className={INPUT_CLASS}
              >
                {rows.map(row => (
                  <option key={row.id} value={row.id}>
                    {row.name && row.name !== row.id ? `${row.name} (${row.id})` : row.id}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label htmlFor={`${baseId}-user`} className={LABEL_CLASS}>
                {t('admin.access.check.userLabel')}
              </label>
              <input
                id={`${baseId}-user`}
                type="text"
                value={userId}
                autoComplete="off"
                onChange={event => setUserId(event.target.value)}
                onKeyDown={event => {
                  // The model editor is a form: Enter checks here, it does not save the model.
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void runCheck();
                  }
                }}
                placeholder={t('admin.access.check.userPlaceholder')}
                className={INPUT_CLASS}
              />
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => void runCheck()}
          disabled={!canCheck || checking}
          className={PRIMARY_BUTTON_CLASS}
        >
          {checking && <Icon name="refresh" className="h-4 w-4 animate-spin" />}
          {t('admin.access.check.run')}
        </button>
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-700 dark:text-red-300" role="alert">
          {t('admin.access.check.error')} {error}
        </p>
      )}

      {result && verdictKey && (
        <div className="mt-4" aria-live="polite" data-testid="access-verdict">
          <p
            className={`flex items-center text-sm font-semibold ${
              result.verdict === 'available'
                ? STATUS_STYLE.ok.className
                : STATUS_STYLE.blocked.className
            }`}
            data-verdict={result.verdict}
          >
            <Icon
              name={result.verdict === 'available' ? 'check-circle' : 'x-circle'}
              className="h-5 w-5 mr-1.5 shrink-0"
            />
            {t(verdictKey, { name: result.subject?.name || result.subject?.id })}
          </p>
          {Array.isArray(result.subject?.groups) && result.subject.groups.length > 0 && (
            <p className={HELP_CLASS}>
              {t('admin.access.check.subjectGroups', {
                groups: result.subject.groups.map(nameOf).join(', ')
              })}
            </p>
          )}
          {result.subject?.notes?.includes('identityProviderGroupsUnknown') && (
            <p className={HELP_CLASS}>{t('admin.access.check.identityProviderNote')}</p>
          )}
          <ul className="mt-2 space-y-1.5">
            {(result.reasons || []).map(reason => {
              const sentence = reasonSentence(reason, { type, nameOf });
              if (!sentence) return null;
              const style = STATUS_STYLE[reason.status] || STATUS_STYLE.ok;
              return (
                <li
                  // A code repeats only for features that are off, one per feature.
                  key={`${reason.code}-${reason.featureId || ''}`}
                  className="flex items-start text-sm text-gray-800 dark:text-gray-200"
                  data-reason={reason.code}
                >
                  <Icon
                    name={style.icon}
                    className={`h-4 w-4 mr-1.5 mt-0.5 shrink-0 ${style.className}`}
                    aria-hidden="true"
                  />
                  <div>
                    <span>{formatSentence(sentence, t)}</span>
                    {sentence.details.length > 0 && (
                      <ul className="mt-0.5 ml-4 list-disc text-gray-600 dark:text-gray-400">
                        {sentence.details.map(detail => (
                          <li key={`${detail.key}-${JSON.stringify(detail.values)}`}>
                            {formatSentence(detail, t)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

export default AccessCheckPanel;
