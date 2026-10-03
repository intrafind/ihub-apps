import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { fetchPromptShareTargets, updatePromptShares } from '../../../api';
import { promptErrorMessage } from '../utils/promptErrors';

const inputClass =
  'block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-sm px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';

const keyOf = share => (share.type === 'everyone' ? 'everyone' : `${share.type}:${share.id}`);

function TargetIcon({ type }) {
  const name = type === 'everyone' ? 'globe' : type === 'group' ? 'user-group' : 'user';
  return <Icon name={name} size="sm" className="text-gray-500 dark:text-gray-400 shrink-0" />;
}

/**
 * Who a prompt is shared with, and how: specific users, groups or everyone
 * signed in, each as *can use* or *can edit*. Changes apply on save, and a
 * removed target loses the prompt right away.
 *
 * Personal skills share the same way, so the API calls, the error wording and
 * the few texts that name the kind of item can be swapped (see
 * `features/skills/components/SkillShareDialog`). Without those props it is
 * the prompt dialog it always was.
 *
 * @param {Object} props
 * @param {Object} props.prompt - The item to share (`id`, `name`, `shares`).
 * @param {() => void} props.onClose
 * @param {(prompt: Object) => void} props.onSaved
 * @param {(query: string) => Promise<Object>} [props.fetchTargets] - Loads the
 *   share targets; defaults to the prompt share targets.
 * @param {(id: string, shares: Object[]) => Promise<Object>} [props.saveShares] -
 *   Saves the share list; defaults to the prompt shares.
 * @param {(error: Error, t: Function) => string} [props.errorMessage] - Turns a
 *   failed call into a message; defaults to the prompt wording.
 * @param {{title?: string, private?: string, help?: string}} [props.labels] -
 *   Texts that name the kind of item; each defaults to the prompt text.
 */
function PromptShareDialog({
  prompt,
  onClose,
  onSaved,
  fetchTargets = fetchPromptShareTargets,
  saveShares = updatePromptShares,
  errorMessage = promptErrorMessage,
  labels = {}
}) {
  const { t } = useTranslation();
  const [shares, setShares] = useState(() => (prompt.shares || []).map(share => ({ ...share })));
  const [query, setQuery] = useState('');
  const [targets, setTargets] = useState({
    allowed: { user: true, group: true, everyone: true },
    users: [],
    groups: []
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const searchRef = useRef(null);

  useEffect(() => {
    let active = true;
    const handle = setTimeout(
      () => {
        fetchTargets(query)
          .then(result => {
            if (active && result) setTargets(result);
          })
          .catch(err => {
            if (active) setError(errorMessage(err, t));
          });
      },
      query ? 250 : 0
    );
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [query, t, fetchTargets, errorMessage]);

  const present = new Set(shares.map(keyOf));
  const everyoneShared = present.has('everyone');

  const add = share => {
    if (present.has(keyOf(share))) return;
    setShares(prev => [...prev, { permission: 'use', ...share }]);
    setQuery('');
    searchRef.current?.focus();
  };

  const setPermission = (key, permission) =>
    setShares(prev => prev.map(share => (keyOf(share) === key ? { ...share, permission } : share)));

  const remove = key => setShares(prev => prev.filter(share => keyOf(share) !== key));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveShares(
        prompt.id,
        shares.map(share => ({
          type: share.type,
          ...(share.type === 'everyone' ? {} : { id: share.id }),
          permission: share.permission
        }))
      );
      onSaved?.(saved);
    } catch (err) {
      setError(errorMessage(err, t));
      setSaving(false);
    }
  };

  const describe = share => {
    if (share.type === 'everyone') return t('prompts.share.everyone', 'Everyone signed in');
    return share.name || share.id;
  };

  const userResults = targets.users.filter(user => !present.has(`user:${user.id}`));
  const groupResults = targets.groups.filter(group => !present.has(`group:${group.id}`));

  return (
    <Modal isOpen onClose={onClose} maxWidthClassName="max-w-xl" initialFocusRef={searchRef}>
      <div className="flex items-start justify-between p-5 border-b border-gray-200 dark:border-gray-700">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {labels.title || t('prompts.share.title', 'Share prompt')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{prompt.name}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <Icon name="x" />
        </button>
      </div>

      <div className="p-5 overflow-y-auto space-y-4">
        {(targets.allowed.user || targets.allowed.group) && (
          <div>
            <label htmlFor="prompt-share-search" className="sr-only">
              {t('prompts.share.search', 'Add people or groups')}
            </label>
            <input
              id="prompt-share-search"
              ref={searchRef}
              className={inputClass}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('prompts.share.search', 'Add people or groups')}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
            />
            {(userResults.length > 0 || (query && groupResults.length > 0)) && (
              <ul
                className="mt-1 border border-gray-200 dark:border-gray-700 rounded-md max-h-48 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700"
                aria-label={t('prompts.share.results', 'Matching people and groups')}
              >
                {userResults.map(user => (
                  <li key={`user:${user.id}`}>
                    <button
                      type="button"
                      onClick={() => add({ type: 'user', id: user.id, name: user.name })}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
                    >
                      <TargetIcon type="user" />
                      <span className="text-sm text-gray-900 dark:text-gray-100">{user.name}</span>
                      {user.email && (
                        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {user.email}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
                {query &&
                  groupResults.map(group => (
                    <li key={`group:${group.id}`}>
                      <button
                        type="button"
                        onClick={() => add({ type: 'group', id: group.id, name: group.name })}
                        className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
                      >
                        <TargetIcon type="group" />
                        <span className="text-sm text-gray-900 dark:text-gray-100">
                          {group.name}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {t('prompts.share.group', 'Group')}
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {targets.allowed.group && !query && groupResults.length > 0 && (
            <select
              className={`${inputClass} w-auto`}
              value=""
              aria-label={t('prompts.share.addGroup', 'Add a group')}
              onChange={e => {
                const group = groupResults.find(g => g.id === e.target.value);
                if (group) add({ type: 'group', id: group.id, name: group.name });
              }}
            >
              <option value="">{t('prompts.share.addGroup', 'Add a group')}</option>
              {groupResults.map(group => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          )}
          {targets.allowed.everyone && !everyoneShared && (
            <button
              type="button"
              onClick={() => add({ type: 'everyone', id: null })}
              className="px-3 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 inline-flex items-center gap-1"
            >
              <Icon name="globe" size="sm" />
              {t('prompts.share.addEveryone', 'Share with everyone')}
            </button>
          )}
        </div>

        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
            {t('prompts.share.sharedWith', 'Shared with')}
          </div>
          {shares.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
              <Icon name="lock" size="sm" />
              {labels.private || t('prompts.share.private', 'Only you — this prompt is private')}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
              {shares.map(share => {
                const key = keyOf(share);
                return (
                  <li key={key} className="flex items-center gap-2 px-3 py-2">
                    <TargetIcon type={share.type} />
                    <span className="flex-1 min-w-0 text-sm text-gray-900 dark:text-gray-100 truncate">
                      {describe(share)}
                    </span>
                    <select
                      className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-sm px-2 py-1"
                      value={share.permission}
                      aria-label={t('prompts.share.permission', 'Permission')}
                      onChange={e => setPermission(key, e.target.value)}
                    >
                      <option value="use">{t('prompts.share.canUse', 'Can use')}</option>
                      <option value="edit">{t('prompts.share.canEdit', 'Can edit')}</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => remove(key)}
                      className="text-gray-500 hover:text-red-600 p-1"
                      aria-label={t('prompts.share.remove', 'Remove')}
                      title={t('prompts.share.remove', 'Remove')}
                    >
                      <Icon name="x" size="sm" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {labels.help ||
              t(
                'prompts.share.help',
                '“Can use” lets people insert, copy and duplicate the prompt. “Can edit” also lets them change it and share it further.'
              )}
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 p-4 border-t border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? t('prompts.editor.saving', 'Saving…') : t('common.save', 'Save')}
        </button>
      </div>
    </Modal>
  );
}

export default PromptShareDialog;
