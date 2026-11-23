// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import Icon from './Icon';

// The look of the project dialogs this one came from.
const INPUT_CLASS =
  'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
const SECONDARY_BUTTON =
  'px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50';
const PRIMARY_BUTTON =
  'px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 flex items-center';
const DANGER_BUTTON =
  'px-4 py-2 text-sm font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 flex items-center';

/** Users need at least this many characters before the server searches them. */
const MIN_QUERY = 2;

/**
 * Gives something a user owns to another user, in two steps: pick the new
 * owner, then confirm after reading what the change means. Nothing is sent
 * before the confirmation.
 *
 * The dialog knows no API and no kind of item. The caller passes the lookup
 * of people, the call that makes the change and every text that names the
 * item. Projects change the owner at once
 * (`features/projects/components/TransferProjectDialog`); a personal app is
 * offered, and the receiver accepts (`features/apps/pages/UserAppEditPage`).
 *
 * Mount it only while open.
 *
 * @param {Object} props
 * @param {Object} props.item - What changes its owner; passed back to `transfer`.
 * @param {(query: string) => Promise<{users?: Array<{id: string, name: string, email?: string}>}>} props.fetchTargets -
 *   The people who can be picked. Called from two characters on.
 * @param {(item: Object, newOwner: {id: string, name: string}) => Promise<Object>} props.transfer -
 *   Makes the change. Its result goes to `onTransferred`.
 * @param {(error: unknown, t: Function) => string} props.errorMessage - A failed call as a sentence.
 * @param {Object} props.labels
 * @param {string} props.labels.title - Heading of the first step.
 * @param {string} props.labels.hint - What the first step asks for.
 * @param {string} props.labels.search - Name and placeholder of the search box.
 * @param {string} props.labels.submit - The button of the first step while nobody is picked.
 * @param {(newOwner: Object) => string} props.labels.submitTo - The same button once someone is.
 * @param {(newOwner: Object) => string} props.labels.confirmTitle - Heading of the second step.
 * @param {string} [props.labels.confirmIntro] - A sentence above the list.
 * @param {(newOwner: Object) => string[]} props.labels.lines - What the change means, one entry per bullet.
 * @param {string} [props.labels.footnote] - A sentence under the list.
 * @param {(newOwner: Object) => string} props.labels.confirm - The button that sends.
 * @param {string} [props.labels.sending] - That button while the call runs; `confirm` without it.
 * @param {string} [props.labels.back] - "Back" of the second step; the common text without it.
 * @param {string} [props.labels.cancel] - "Cancel" of the first step; the common text without it.
 * @param {boolean} [props.danger=true] - The change takes effect at once and cannot be taken
 *   back by the caller: the confirming button is red.
 * @param {string} [props.titleId='transfer-owner-title'] - The id of the heading.
 * @param {() => void} props.onClose
 * @param {(result: Object, newOwner: {id: string, name: string}) => void} props.onTransferred
 * @returns {JSX.Element}
 *
 * @example
 * <TransferOwnerDialog
 *   item={app}
 *   fetchTargets={q => fetchUserAppShareTargets({ q, purpose: 'offer' })}
 *   transfer={(item, owner) => offerUserApp(item.id, owner.id)}
 *   errorMessage={userAppErrorMessage}
 *   labels={labels}
 *   danger={false}
 *   onClose={close}
 *   onTransferred={setApp}
 * />
 */
function TransferOwnerDialog({
  item,
  fetchTargets,
  transfer,
  errorMessage,
  labels,
  danger = true,
  titleId = 'transfer-owner-title',
  onClose,
  onTransferred
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const searchRef = useRef(null);
  const backRef = useRef(null);
  // The lookup and the wording of the latest render: a caller may build them inline.
  const callsRef = useRef({ fetchTargets, errorMessage });
  callsRef.current = { fetchTargets, errorMessage };

  // Each step's first control takes the focus; otherwise Back would leave it
  // on the page behind the dialog.
  useEffect(() => {
    if (confirming) backRef.current?.focus();
    else searchRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (query.trim().length < MIN_QUERY) {
      // A query too short to search has no results; the list follows the box.
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setUsers([]);
      return undefined;
    }
    let active = true;
    const handle = setTimeout(() => {
      callsRef.current
        .fetchTargets(query.trim())
        .then(result => active && setUsers(result?.users || []))
        .catch(err => active && setError(callsRef.current.errorMessage(err, t)));
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
      onTransferred(await transfer(item, selected), selected);
    } catch (err) {
      setError(errorMessage(err, t));
      setSaving(false);
    }
  };

  const errorLine = error && (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {error}
    </p>
  );

  return (
    <Modal isOpen onClose={onClose} labelledBy={titleId} initialFocusRef={searchRef}>
      {confirming && selected ? (
        <>
          <div className="px-6 pt-5 pb-4 space-y-3">
            <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {labels.confirmTitle(selected)}
            </h2>
            {labels.confirmIntro && (
              <p className="text-sm text-gray-600 dark:text-gray-400">{labels.confirmIntro}</p>
            )}
            <ul className="list-disc pl-5 space-y-1 text-sm text-gray-700 dark:text-gray-300">
              {labels.lines(selected).map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {labels.footnote && (
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {labels.footnote}
              </p>
            )}
            {errorLine}
          </div>
          <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
            <button
              ref={backRef}
              type="button"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={saving}
              className={SECONDARY_BUTTON}
            >
              {labels.back || t('common.back')}
            </button>
            <button
              type="button"
              onClick={handleTransfer}
              disabled={saving}
              className={danger ? DANGER_BUTTON : PRIMARY_BUTTON}
            >
              {saving && labels.sending ? labels.sending : labels.confirm(selected)}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="px-6 pt-5 pb-4 space-y-3">
            <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {labels.title}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400">{labels.hint}</p>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                setSelected(null);
              }}
              placeholder={labels.search}
              aria-label={labels.search}
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
            {errorLine}
          </div>
          <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
              {labels.cancel || t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
              disabled={!selected}
              className={PRIMARY_BUTTON}
            >
              {selected ? labels.submitTo(selected) : labels.submit}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

export default TransferOwnerDialog;
