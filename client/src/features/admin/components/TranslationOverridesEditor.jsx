// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall, getAdminApiErrorMessage } from '../../../api/adminApi';
import i18nService from '../../../services/i18nService';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import UnsavedChangesDialog from './UnsavedChangesDialog';
import { CHECKBOX_CLASS, INPUT_CLASS } from './formStyles';

const PAGE_SIZE = 50;

/**
 * Search and edit translation overrides (`contents/locales/{lang}.json`).
 *
 * Searches the whole built-in catalogue, so any key can be found and
 * overridden; "Changed only" narrows the list to the keys already changed.
 * Each row saves on its own — an override is a single key, never a batch.
 * Unsaved edits are kept per language: switching the language never carries
 * a draft into another language's file.
 */
function TranslationOverridesEditor({ languages, initialLanguage }) {
  const { t, i18n } = useTranslation();
  const [language, setLanguage] = useState(initialLanguage || languages[0] || 'en');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // Off by default: a search must find labels that were never changed (CU-B7).
  const [changedOnly, setChangedOnly] = useState(false);
  const [data, setData] = useState({ items: [], total: 0, changedCount: 0 });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Unsaved edits by language, then key: { en: { 'common.save': '…' } } (CU-B8).
  const [draftsByLanguage, setDraftsByLanguage] = useState({});
  const drafts = draftsByLanguage[language] || {};
  const [busyKey, setBusyKey] = useState(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const id = ++requestIdRef.current;
    try {
      setLoading(true);
      const params = new URLSearchParams({
        q: debouncedQuery,
        changedOnly: String(changedOnly),
        limit: String(limit)
      });
      const response = await makeAdminApiCall(`/admin/translations/${language}?${params}`);
      if (id !== requestIdRef.current) return; // a newer request superseded this one
      setData(response.data);
      setError('');
    } catch (err) {
      if (id !== requestIdRef.current) return;
      setError(getAdminApiErrorMessage(err));
    } finally {
      if (id === requestIdRef.current) setLoading(false);
    }
  }, [language, debouncedQuery, changedOnly, limit]);

  useEffect(() => {
    load();
  }, [load]);

  /** Pull the changed text into this browser too, so the admin sees it at once. */
  const refreshClientTranslations = async () => {
    try {
      const current = (i18n.language || language).split('-')[0];
      i18nService.clearCache();
      i18n.removeResourceBundle?.(current, 'translation');
      await i18nService.loadFullTranslations(current);
    } catch (err) {
      console.error('Failed to reload translations:', err);
    }
  };

  /** Set or drop (`value` undefined) the draft of `key` in the current language. */
  const setDraft = (key, value) =>
    setDraftsByLanguage(prev => {
      const forLanguage = { ...prev[language] };
      if (value === undefined) delete forLanguage[key];
      else forLanguage[key] = value;
      return { ...prev, [language]: forLanguage };
    });
  const discardDraft = key => setDraft(key, undefined);

  // Languages other than the shown one that still hold unsaved edits (R6):
  // their drafts are not on screen, so the selector and a note name them.
  const unsavedCountOf = code => Object.keys(draftsByLanguage[code] || {}).length;
  const otherLanguagesWithDrafts = languages.filter(
    code => code !== language && unsavedCountOf(code) > 0
  );

  const save = async (entry, value) => {
    setBusyKey(entry.key);
    try {
      await makeAdminApiCall(`/admin/translations/${language}`, {
        method: 'PUT',
        body: { path: entry.path, value }
      });
      discardDraft(entry.key);
      setError('');
      await load();
      await refreshClientTranslations();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  const hasMore = data.items.length < data.total;

  // A draft that differs from the text it edits is an unsaved change. A draft
  // for a key the current list no longer shows (another search) still counts.
  const hasUnsavedDrafts = Object.entries(drafts).some(([key, draft]) => {
    const entry = data.items.find(item => item.key === key);
    if (!entry) return true;
    return draft !== (entry.override ?? entry.base ?? '');
  });
  // Drafts in another language are pending edits too (the selector says so); a
  // draft is dropped on save or discard, so every remaining one is a real edit.
  const { blocker } = useUnsavedChanges(
    false,
    hasUnsavedDrafts || otherLanguagesWithDrafts.length > 0
  );

  return (
    <div className="mt-8 bg-white dark:bg-gray-800 shadow-sm sm:rounded-lg px-4 py-5 sm:p-6">
      <h2 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
        {t('admin.localization.overrides.title', 'Translation overrides')}
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.localization.overrides.desc',
          'Change the wording of any label. Only the keys you change are stored, in contents/locales/. Search to find a label and edit it; reset a key to return to the built-in text.'
        )}
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <select
          aria-label={t('admin.localization.overrides.language', 'Language')}
          value={language}
          onChange={e => {
            setLanguage(e.target.value);
            setLimit(PAGE_SIZE);
          }}
          className={`${INPUT_CLASS} sm:w-auto`}
        >
          {languages.map(code => (
            <option key={code} value={code}>
              {unsavedCountOf(code) > 0
                ? t('admin.localization.overrides.languageUnsaved', {
                    defaultValue: '{{language}} ({{unsaved}} unsaved)',
                    language: code,
                    unsaved: unsavedCountOf(code)
                  })
                : code}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setLimit(PAGE_SIZE);
          }}
          placeholder={t(
            'admin.localization.overrides.search',
            'Search by key or text, e.g. "answerSource" or "email"'
          )}
          aria-label={t('admin.localization.overrides.searchLabel', 'Search translations')}
          className={`${INPUT_CLASS} block flex-1`}
        />
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
          <input
            type="checkbox"
            checked={changedOnly}
            onChange={e => {
              setChangedOnly(e.target.checked);
              setLimit(PAGE_SIZE);
            }}
            className={CHECKBOX_CLASS}
          />
          {t('admin.localization.overrides.changedOnly', 'Changed only')} ({data.changedCount})
        </label>
      </div>

      <p role="status" className="mt-2 text-sm text-amber-700 dark:text-amber-300 empty:hidden">
        {otherLanguagesWithDrafts.length > 0 &&
          t('admin.localization.overrides.unsavedElsewhere', {
            defaultValue:
              'Unsaved edits in {{languages}}. Switch to that language and save them before you leave this page.',
            languages: otherLanguagesWithDrafts
              .map(code => `${code} (${unsavedCountOf(code)})`)
              .join(', ')
          })}
      </p>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-200"
        >
          {error}
        </div>
      )}

      <ul className="mt-4 divide-y divide-gray-200 dark:divide-gray-700" aria-busy={loading}>
        {data.items.map(entry => {
          const current = entry.override ?? entry.base ?? '';
          const draft = drafts[entry.key];
          const value = draft ?? current;
          const dirty = draft !== undefined && draft !== current;
          const busy = busyKey === entry.key;
          return (
            <li key={entry.key} className="py-3">
              <div className="flex items-center justify-between gap-2">
                <code className="break-all text-xs text-gray-600 dark:text-gray-400">
                  {entry.key}
                </code>
                {entry.override !== null && (
                  <span className="shrink-0 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                    {entry.unknown
                      ? t('admin.localization.overrides.unknown', 'unknown key')
                      : t('admin.localization.overrides.changed', 'changed')}
                  </span>
                )}
              </div>
              {entry.override !== null && entry.base !== null && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t('admin.localization.overrides.original', 'Built-in')}: {entry.base}
                </p>
              )}
              <textarea
                rows={Math.min(4, Math.max(1, Math.ceil(value.length / 80)))}
                value={value}
                disabled={busy || entry.unknown}
                onChange={e =>
                  // Typing the stored text back is no edit: it leaves no draft behind.
                  setDraft(entry.key, e.target.value === current ? undefined : e.target.value)
                }
                aria-label={entry.key}
                className={`${INPUT_CLASS} mt-1 block`}
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={!dirty || busy}
                  onClick={() => save(entry, value)}
                  className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {t('admin.localization.overrides.save', 'Save')}
                </button>
                {dirty && (
                  <button
                    type="button"
                    onClick={() => discardDraft(entry.key)}
                    className="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-700 dark:border-gray-600 dark:text-gray-200"
                  >
                    {t('admin.localization.overrides.cancel', 'Cancel')}
                  </button>
                )}
                {entry.override !== null && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => save(entry, null)}
                    className="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    {t('admin.localization.overrides.reset', 'Reset to built-in')}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {!loading && data.items.length === 0 && !error && (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          {changedOnly && !debouncedQuery
            ? t(
                'admin.localization.overrides.none',
                'No keys changed yet. Search above to find a label to change.'
              )
            : t('admin.localization.overrides.noMatches', 'No matching translations.')}
        </p>
      )}

      {hasMore && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => setLimit(l => l + PAGE_SIZE)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200"
          >
            {t('admin.localization.overrides.more', 'Show more')} ({data.items.length}/{data.total})
          </button>
        </div>
      )}
      <UnsavedChangesDialog blocker={blocker} />
    </div>
  );
}

export default TranslationOverridesEditor;
