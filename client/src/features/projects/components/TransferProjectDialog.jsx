// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { fetchProjectShareTargets, transferProject } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';
import { INPUT_CLASS, PRIMARY_BUTTON, SECONDARY_BUTTON } from './item-dialog/dialogStyles';

/** Users need at least this many characters before the server searches them. */
const MIN_QUERY = 2;

/**
 * Hands a project to another user (`POST …/transfer`, owner only). The new
 * owner gets everything; the previous owner keeps no role unless the new
 * owner adds them.
 *
 * Mount it only while open.
 *
 * @param {Object} props
 * @param {Object} props.project
 * @param {() => void} props.onClose
 * @param {(result: Object) => void} props.onTransferred - The project, or
 *   `{ id, transferred: true }` when the caller can no longer see it.
 * @returns {JSX.Element}
 */
function TransferProjectDialog({ project, onClose, onTransferred }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const searchRef = useRef(null);

  useEffect(() => {
    if (query.trim().length < MIN_QUERY) {
      setUsers([]);
      return undefined;
    }
    let active = true;
    const handle = setTimeout(() => {
      fetchProjectShareTargets(query.trim())
        .then(result => active && setUsers(result?.users || []))
        .catch(err => active && setError(projectErrorMessage(err, t)));
    }, 250);
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [query, t]);

  const handleTransfer = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      onTransferred(await transferProject(project.id, selected.id));
    } catch (err) {
      setError(projectErrorMessage(err, t));
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} labelledBy="transfer-project-title" initialFocusRef={searchRef}>
      <div className="px-6 pt-5 pb-4 space-y-3">
        <h2
          id="transfer-project-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('projects.transfer.title', 'Transfer ownership')}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t(
            'projects.transfer.hint',
            'The new owner may change and delete the project. You lose your access unless they share it with you again.'
          )}
        </p>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setSelected(null);
          }}
          placeholder={t('projects.transfer.search', 'Search people')}
          aria-label={t('projects.transfer.search', 'Search people')}
          className={INPUT_CLASS}
        />
        {users.length > 0 && (
          <ul className="max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
            {users.map(user => (
              <li key={user.id}>
                <button
                  type="button"
                  aria-pressed={selected?.id === user.id}
                  onClick={() => setSelected(user)}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm ${
                    selected?.id === user.id
                      ? 'bg-indigo-50 dark:bg-indigo-900/30'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  <Icon name="user" size="sm" className="text-gray-500" />
                  <span className="text-gray-900 dark:text-gray-100">{user.name}</span>
                  {user.email && (
                    <span className="text-xs text-gray-500 truncate">{user.email}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          onClick={handleTransfer}
          disabled={!selected || saving}
          className={PRIMARY_BUTTON}
        >
          {selected
            ? t('projects.transfer.submitTo', 'Transfer to {{name}}', { name: selected.name })
            : t('projects.transfer.submit', 'Transfer')}
        </button>
      </div>
    </Modal>
  );
}

export default TransferProjectDialog;
