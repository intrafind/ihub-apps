// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import Modal from '../../../../shared/components/Modal';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { CALLOUT_CLASS, INPUT_CLASS, LABEL_CLASS } from '../formStyles';
import AppPickCard from './AppPickCard';
import { LINK_BUTTON_CLASS } from './createStyles';

const CLOSE_BUTTON_CLASS =
  'rounded-md p-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark';

/** The list inside the open dialog: it loads when the dialog opens. */
function PickerBody({ fetchApps, language, onPick, onClose, headingId }) {
  const { t } = useTranslation();
  const searchId = useId();
  const searchRef = useRef(null);
  const [apps, setApps] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    let current = true;
    fetchApps()
      .then(items => {
        if (!current) return;
        setApps(Array.isArray(items) ? items : []);
        setFailed(false);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [fetchApps, attempt]);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt(count => count + 1);
  }, []);

  const nameOf = app => getLocalizedContent(app.name, language) || app.id;
  const descriptionOf = app => getLocalizedContent(app.description, language);
  const needle = query.trim().toLowerCase();
  const shown = (apps || []).filter(
    app =>
      needle === '' ||
      [nameOf(app), descriptionOf(app), app.id].some(text =>
        String(text || '')
          .toLowerCase()
          .includes(needle)
      )
  );

  let content;
  if (failed) {
    content = (
      <p role="alert" className={CALLOUT_CLASS.warning}>
        {t('admin.apps.create.copy.loadError')}{' '}
        <button type="button" className={LINK_BUTTON_CLASS} onClick={retry}>
          {t('admin.apps.create.retry')}
        </button>
      </p>
    );
  } else if (!apps) {
    content = (
      <p role="status" className="text-sm text-gray-600 dark:text-gray-400">
        {t('admin.apps.loading')}
      </p>
    );
  } else if (apps.length === 0) {
    content = (
      <p className="text-sm text-gray-700 dark:text-gray-300">{t('admin.apps.create.copy.none')}</p>
    );
  } else if (shown.length === 0) {
    content = (
      <p role="status" className="text-sm text-gray-700 dark:text-gray-300">
        {t('admin.apps.create.copy.noMatch', { query: query.trim() })}
      </p>
    );
  } else {
    content = (
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {shown.map(app => (
          <li key={app.id}>
            <AppPickCard
              name={nameOf(app)}
              description={descriptionOf(app)}
              icon={app.icon}
              color={app.color}
              onPick={() => onPick(app)}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 dark:border-gray-700 px-5 py-4">
        <h2 id={headingId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.apps.create.copy.heading')}
        </h2>
        <button
          type="button"
          className={CLOSE_BUTTON_CLASS}
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <Icon name="close" size="md" aria-hidden="true" />
        </button>
      </div>
      <div className="px-5 pt-4">
        <label htmlFor={searchId} className={LABEL_CLASS}>
          {t('admin.apps.create.copy.search')}
        </label>
        <input
          ref={searchRef}
          id={searchId}
          type="search"
          className={INPUT_CLASS}
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </div>
      <div className="min-h-[8rem] flex-1 overflow-y-auto px-5 py-4">{content}</div>
    </>
  );
}

/**
 * "Copy an existing app": a dialog with a searchable list of apps. The list
 * comes from the caller's `fetchApps`; the dialog makes no request of its own.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {() => Promise<object[]>} props.fetchApps - The apps that can be copied, as stored.
 * @param {string} props.language - The language of names and descriptions.
 * @param {(app: object) => void} props.onPick
 * @returns {JSX.Element}
 */
function ExistingAppPicker({ isOpen, onClose, fetchApps, language, onPick }) {
  const headingId = useId();
  return (
    <Modal isOpen={isOpen} onClose={onClose} labelledBy={headingId} maxWidthClassName="max-w-2xl">
      <PickerBody
        fetchApps={fetchApps}
        language={language}
        onPick={onPick}
        onClose={onClose}
        headingId={headingId}
      />
    </Modal>
  );
}

export default ExistingAppPicker;
