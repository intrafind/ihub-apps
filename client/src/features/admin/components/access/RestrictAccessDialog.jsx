// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../../shared/components/Modal';
import Icon from '../../../../shared/components/Icon';
import {
  getAdminApiErrorMessage,
  previewAccessRestriction,
  restrictItemAccess
} from '../../../../api/adminApi';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../formStyles';
import {
  ITEM_KEYS,
  defaultModelGroupNames,
  formatSentence,
  groupNamer,
  primaryRoute,
  routeSentence
} from './accessExplanation';

const LIST_SEPARATOR = ', ';

/**
 * The plan's groups, split by what happens to them: still able to use the
 * item, and no longer able to. Implicit groups (every signed-in user, the
 * anonymous group) are left out; the audience line speaks for them.
 *
 * @param {object|null} plan
 * @returns {{keep: object[], lose: object[]}}
 */
export function splitOutcome(plan) {
  const rows = Array.isArray(plan?.groupsAfter) ? plan.groupsAfter : [];
  const teams = rows.filter(row => !row.implicit);
  return {
    keep: teams.filter(row => row.after),
    lose: teams.filter(row => row.before && !row.after)
  };
}

/**
 * W3 "Restrict access": takes one item out of the groups that grant it to
 * everyone through a wildcard.
 *
 * Step by step on one screen: which groups hold “all …” and whom they pass it
 * on to (each can be kept), which groups get the item by name afterwards
 * (optional), and a preview of who can and cannot use it then. The server
 * computes the preview (`_preview-restrict`) and applies the same plan
 * (`_restrict`), which writes change history and audit entries per group.
 *
 * Converting a wildcard means items added later are no longer visible by
 * default in that group; the dialog says so before anything is applied.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {'apps'|'models'|'prompts'} props.type
 * @param {string} props.id - The item id
 * @param {string} props.itemName - The item's name as the admin reads it
 * @param {Array<{id: string, name: string, implicit?: boolean}>} props.groups - All groups,
 *   from the item's access view
 * @param {() => void} props.onClose
 * @param {(view: object) => void} props.onApplied - Called with the access view after the change
 * @returns {JSX.Element|null}
 */
function RestrictAccessDialog({ isOpen, onClose, ...props }) {
  const titleId = useId();
  // The body mounts with the dialog, so every opening starts from the defaults.
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      labelledBy={titleId}
      maxWidthClassName="max-w-2xl"
      panelClassName="overflow-y-auto"
    >
      <RestrictAccessBody {...props} titleId={titleId} onClose={onClose} />
    </Modal>
  );
}

/**
 * The open dialog. See {@link RestrictAccessDialog} for the props.
 *
 * @param {object} props
 * @returns {JSX.Element}
 */
function RestrictAccessBody({ type, id, itemName, groups, onClose, onApplied, titleId }) {
  const { t } = useTranslation();
  // `null`: every wildcard group, the server's default.
  const [selected, setSelected] = useState(null);
  const [grants, setGrants] = useState(() => new Set());
  // The newest preview that answered, and for which request; the plan of before
  // stays on screen while the next one is on its way.
  const [answer, setAnswer] = useState({ key: null, plan: null, error: null });
  const [applyError, setApplyError] = useState(null);
  const [applying, setApplying] = useState(false);

  const items = t(ITEM_KEYS[type] || ITEM_KEYS.apps);
  const nameOf = useMemo(() => groupNamer(groups), [groups]);
  const grantIds = useMemo(() => [...grants], [grants]);
  const previewBody = useMemo(
    () => ({ ...(selected ? { groupIds: [...selected] } : {}), grantGroupIds: grantIds }),
    [selected, grantIds]
  );
  const previewKey = JSON.stringify(previewBody);
  const plan = answer.plan;
  const loading = answer.key !== previewKey;
  const error = applyError || (answer.key === previewKey ? answer.error : null);

  useEffect(() => {
    let current = true;
    const key = JSON.stringify(previewBody);
    previewAccessRestriction(type, id, previewBody)
      .then(next => {
        if (current) setAnswer({ key, plan: next, error: null });
      })
      .catch(err => {
        if (current) {
          setAnswer(held => ({ key, plan: held.plan, error: getAdminApiErrorMessage(err) }));
        }
      });
    return () => {
      current = false;
    };
  }, [type, id, previewBody]);

  const candidates = Array.isArray(plan?.candidates) ? plan.candidates : [];
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  const selectedIds = selected || new Set(candidates.map(candidate => candidate.id));
  // Groups that can get the item by name: teams that do not hold `*` themselves.
  const grantable = (Array.isArray(groups) ? groups : []).filter(
    group => !group.implicit && !candidateIds.has(group.id)
  );
  const { keep, lose } = splitOutcome(plan);
  // Why everyone who signs in still gets it: the routes of the implicit groups.
  const stillGranting = (Array.isArray(plan?.groupsAfter) ? plan.groupsAfter : [])
    .filter(row => row.implicit && row.after)
    .map(row => ({ row, route: primaryRoute(row) }))
    .filter(({ route }) => route);
  const changes = Array.isArray(plan?.changes) ? plan.changes : [];
  // Groups that keep the model as "the default model" (`@default`): the
  // restrict leaves that entry alone.
  const defaultModelGroups = defaultModelGroupNames(plan);

  const toggleCandidate = groupId => {
    const next = new Set(selectedIds);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setSelected(next);
  };
  const toggleGrant = groupId => {
    setGrants(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const view = await restrictItemAccess(type, id, {
        groupIds: [...selectedIds],
        grantGroupIds: grantIds
      });
      onApplied?.(view);
      onClose();
    } catch (err) {
      setApplyError(getAdminApiErrorMessage(err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="p-6 space-y-5" data-testid="restrict-access-dialog">
      <div className="flex items-start justify-between gap-4">
        <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.access.restrict.title', { name: itemName })}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          aria-label={t('common.close')}
        >
          <Icon name="x" size="md" />
        </button>
      </div>

      <p className="text-sm text-gray-700 dark:text-gray-300">
        {t('admin.access.restrict.intro', { items, name: itemName })}
      </p>

      {/* Step 1 + 2: the wildcard groups, each converted or kept */}
      <fieldset>
        <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.access.restrict.convertLegend', { items })}
        </legend>
        <ul className="mt-2 space-y-3">
          {candidates.map(candidate => {
            const inputId = `${titleId}-convert-${candidate.id}`;
            const checked = selectedIds.has(candidate.id);
            return (
              <li key={candidate.id} className="flex items-start gap-2">
                <input
                  id={inputId}
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleCandidate(candidate.id)}
                  className={`${CHECKBOX_CLASS} mt-0.5`}
                />
                <label htmlFor={inputId} className="text-sm text-gray-800 dark:text-gray-200">
                  <span className="font-medium">{candidate.name}</span>
                  <span className="block text-gray-600 dark:text-gray-400">
                    {checked
                      ? t('admin.access.restrict.convertRow', {
                          items,
                          count: candidate.itemCount
                        })
                      : t('admin.access.restrict.keepRow', { items })}
                  </span>
                  {candidate.passesTo?.length > 0 && (
                    <span className="block text-gray-600 dark:text-gray-400">
                      {t('admin.access.restrict.passesTo', {
                        groups: candidate.passesTo.map(nameOf).join(LIST_SEPARATOR)
                      })}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {/* Optional: who gets the item by name afterwards */}
      {grantable.length > 0 && (
        <fieldset>
          <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.access.restrict.grantLegend')}
          </legend>
          <p className={HELP_CLASS}>{t('admin.access.restrict.grantHelp', { name: itemName })}</p>
          <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {grantable.map(group => {
              const inputId = `${titleId}-grant-${group.id}`;
              return (
                <li key={group.id} className="flex items-center gap-2">
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={grants.has(group.id)}
                    onChange={() => toggleGrant(group.id)}
                    className={CHECKBOX_CLASS}
                  />
                  <label htmlFor={inputId} className="text-sm text-gray-800 dark:text-gray-200">
                    {group.name}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      {/* Step 3: preview */}
      <section aria-live="polite" data-testid="restrict-preview">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.access.restrict.previewTitle')}
        </h3>
        {loading && !plan ? (
          <p className={HELP_CLASS}>{t('admin.access.restrict.previewLoading')}</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm text-gray-800 dark:text-gray-200">
            <li data-testid="restrict-keep">
              {keep.length > 0
                ? t('admin.access.restrict.keeps', {
                    groups: keep.map(row => row.name).join(LIST_SEPARATOR)
                  })
                : t('admin.access.restrict.keepsNone')}
            </li>
            {lose.length > 0 && (
              <li data-testid="restrict-lose">
                {t('admin.access.restrict.loses', {
                  groups: lose.map(row => row.name).join(LIST_SEPARATOR)
                })}
              </li>
            )}
            {plan?.audienceAfter?.allSignedIn && (
              <li data-testid="restrict-still-everyone">
                {t('admin.access.restrict.stillEveryone')}
                <ul className="ml-4 list-disc text-gray-600 dark:text-gray-400">
                  {stillGranting.map(({ row, route }) => (
                    <li key={row.id}>
                      {formatSentence(
                        routeSentence({ groupName: row.name, route, type, nameOf }),
                        t
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            )}
            {defaultModelGroups.length > 0 && (
              <li data-testid="restrict-still-default-model">
                {t('admin.access.restrict.stillDefaultModel', {
                  name: itemName,
                  groups: defaultModelGroups.join(LIST_SEPARATOR)
                })}
              </li>
            )}
          </ul>
        )}
      </section>

      <div className={CALLOUT_CLASS.warning} data-testid="restrict-new-items-warning">
        <p className="flex items-start">
          <Icon name="exclamation-triangle" className="h-4 w-4 mr-1.5 mt-0.5 shrink-0" />
          <span>{t('admin.access.restrict.newItemsWarning', { items })}</span>
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {t('admin.access.restrict.error')} {error}
        </p>
      )}

      <div className="flex justify-end gap-3">
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASS}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={
            applying ||
            loading ||
            changes.length === 0 ||
            // No preview of the current choice: never apply one that was not shown.
            (answer.key === previewKey && Boolean(answer.error))
          }
          className={PRIMARY_BUTTON_CLASS}
        >
          {applying && <Icon name="refresh" className="h-4 w-4 animate-spin" />}
          {t('admin.access.restrict.apply')}
        </button>
      </div>
    </div>
  );
}

export default RestrictAccessDialog;
