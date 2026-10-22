// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import {
  addAdminProjectItem,
  checkProjectPickerUrl,
  fetchProjectPickerPages,
  getAdminApiErrorMessage,
  searchProjectPickerIFinder,
  uploadAdminProjectItem
} from '../../../api/adminApi';
import {
  buildItemDialogTabs,
  buildItemRequest,
  kindIcon,
  localizedText,
  uploadAccept,
  validateUpload
} from '../utils/projectAdmin';
import { formatBytes } from '../utils/systemResourcesFormat';

const INPUT_CLASS =
  'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
const SECONDARY_BUTTON =
  'px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50';

/** A fresh draft for every tab: shared fields plus each picker's input. */
const EMPTY_DRAFT = Object.freeze({
  name: '',
  pinned: false,
  text: '',
  url: '',
  pageId: '',
  language: '',
  documentId: '',
  documentTitle: '',
  query: ''
});

/**
 * Dialog that adds one item to an admin project, with one tab per item kind
 * (#1036): file upload (multipart), pasted text, web page (URL), iHub page,
 * iFinder document and iFinder search. Cloud storage kinds are shown as
 * disabled tabs until a later release supports them.
 *
 * Mount it only while it is open (`{open && <AddProjectItemDialog … />}`):
 * every opening then starts from a clean draft.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {string} props.projectId
 * @param {Array<{id: string, name: Object, enabled: boolean}>} props.kinds - From `GET /_kinds`.
 * @param {Object|null} props.config - From `GET /_config` (upload accept list, limits).
 * @param {(item: Object) => void} props.onAdded - Called with the new item after a successful add.
 * @returns {JSX.Element|null}
 */
function AddProjectItemDialog({ isOpen, onClose, projectId, kinds, config, onAdded }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const tabs = useMemo(() => buildItemDialogTabs(kinds, config), [kinds, config]);
  const firstEnabled = tabs.find(tab => tab.enabled)?.id || tabs[0].id;
  // `null` until the admin picks a tab: follows the first usable one, which
  // may change while the kinds are still loading.
  const [chosenTab, setChosenTab] = useState(null);
  const activeTab = chosenTab ?? firstEnabled;
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [urlCheck, setUrlCheck] = useState(null);
  const [pages, setPages] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);

  // The page list is loaded once, the first time the page tab is shown.
  useEffect(() => {
    if (!isOpen || activeTab !== 'page' || pages !== null) return;
    fetchProjectPickerPages()
      .then(setPages)
      .catch(err => {
        setPages([]);
        setError(getAdminApiErrorMessage(err));
      });
  }, [isOpen, activeTab, pages]);

  const tab = tabs.find(candidate => candidate.id === activeTab) || tabs[0];
  const update = changes => setDraft(prev => ({ ...prev, ...changes }));

  const errorMessages = {
    fileRequired: t('admin.projects.addItem.errors.fileRequired', 'Choose a file to upload.'),
    fileTooLarge: t(
      'admin.projects.addItem.errors.fileTooLarge',
      'The file is larger than {{max}}.',
      {
        max: formatBytes(config?.limits?.maxFileBytes)
      }
    ),
    textRequired: t('admin.projects.addItem.errors.textRequired', 'Enter the text to add.'),
    urlInvalid: t('admin.projects.addItem.errors.urlInvalid', 'Enter a valid http(s) URL.'),
    pageRequired: t('admin.projects.addItem.errors.pageRequired', 'Choose a page.'),
    documentRequired: t(
      'admin.projects.addItem.errors.documentRequired',
      'Search iFinder and choose a document.'
    ),
    queryRequired: t('admin.projects.addItem.errors.queryRequired', 'Enter a search query.'),
    unsupported: t('admin.projects.addItem.errors.unsupported', 'This kind cannot be added here.')
  };

  const tabLabel = candidate => {
    switch (candidate.id) {
      case 'upload':
        return t('admin.projects.addItem.tabs.upload', 'Upload');
      case 'text':
        return t('admin.projects.addItem.tabs.text', 'Text');
      default: {
        const entry = (kinds || []).find(kind => kind.id === candidate.kind);
        return entry ? localizedText(entry.name, language) || candidate.id : candidate.id;
      }
    }
  };

  const disabledReason = candidate => {
    switch (candidate.reason) {
      case 'later':
        return t('admin.projects.addItem.comingLater', 'Coming in a later release.');
      case 'storageUnavailable':
        return t(
          'admin.projects.addItem.storageUnavailable',
          'Files and text need the project storage, which is not available on this server.'
        );
      case 'disabled':
        return t('admin.projects.addItem.kindDisabled', 'This kind is not enabled on this server.');
      default:
        return null;
    }
  };

  const handleCheckUrl = async () => {
    setUrlCheck({ checking: true });
    try {
      const result = await checkProjectPickerUrl(draft.url.trim());
      setUrlCheck(result);
    } catch (err) {
      setUrlCheck({ ok: false, error: getAdminApiErrorMessage(err) });
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setSearchResults(await searchProjectPickerIFinder(searchQuery.trim()));
    } catch (err) {
      setSearchResults([]);
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  const handleSubmit = async event => {
    event.preventDefault();
    setError(null);
    try {
      let item = null;
      if (tab.id === 'upload') {
        const uploadError = validateUpload(file, config);
        if (uploadError) {
          setError(errorMessages[uploadError]);
          return;
        }
        setSubmitting(true);
        item = await uploadAdminProjectItem(projectId, {
          file,
          name: draft.name.trim() || undefined,
          pinned: draft.pinned
        });
      } else {
        const { body, error: requestError } = buildItemRequest(tab.id, draft);
        if (requestError) {
          setError(errorMessages[requestError]);
          return;
        }
        setSubmitting(true);
        item = await addAdminProjectItem(projectId, body);
      }
      onAdded(item);
      onClose();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const renderTabBody = () => {
    if (!tab.enabled) {
      return (
        <div className="flex items-start gap-2 p-4 rounded-lg bg-gray-50 dark:bg-gray-900/40 text-sm text-gray-600 dark:text-gray-400">
          <Icon name="information-circle" className="h-5 w-5 shrink-0" />
          <p>{disabledReason(tab)}</p>
        </div>
      );
    }
    switch (tab.id) {
      case 'upload':
        return (
          <div>
            <label htmlFor="project-item-file" className={LABEL_CLASS}>
              {t('admin.projects.addItem.file', 'File')}
            </label>
            <input
              id="project-item-file"
              type="file"
              accept={uploadAccept(config)}
              onChange={e => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-gray-700 dark:text-gray-300"
            />
            {config?.upload?.summary && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('admin.projects.addItem.accepted', 'Accepted: {{types}}', {
                  types: config.upload.summary
                })}
              </p>
            )}
          </div>
        );
      case 'text':
        return (
          <div>
            <label htmlFor="project-item-text" className={LABEL_CLASS}>
              {t('admin.projects.addItem.text', 'Text')}
            </label>
            <textarea
              id="project-item-text"
              rows={8}
              value={draft.text}
              onChange={e => update({ text: e.target.value })}
              className={`${INPUT_CLASS} font-mono text-sm`}
            />
          </div>
        );
      case 'url':
        return (
          <div>
            <label htmlFor="project-item-url" className={LABEL_CLASS}>
              {t('admin.projects.addItem.url', 'URL')}
            </label>
            <div className="flex gap-2">
              <input
                id="project-item-url"
                type="url"
                value={draft.url}
                placeholder="https://example.com/handbook"
                onChange={e => {
                  update({ url: e.target.value });
                  setUrlCheck(null);
                }}
                className={INPUT_CLASS}
              />
              <button
                type="button"
                onClick={handleCheckUrl}
                disabled={!draft.url.trim() || urlCheck?.checking}
                className={SECONDARY_BUTTON}
              >
                {urlCheck?.checking
                  ? t('admin.projects.addItem.checking', 'Checking...')
                  : t('admin.projects.addItem.check', 'Check')}
              </button>
            </div>
            {urlCheck && !urlCheck.checking && (
              <p
                className={`mt-1 text-sm ${
                  urlCheck.ok
                    ? 'text-green-700 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                }`}
              >
                {urlCheck.ok
                  ? t('admin.projects.addItem.urlOk', 'The page can be read.')
                  : t('admin.projects.addItem.urlFailed', 'The page cannot be read: {{error}}', {
                      error: urlCheck.error || ''
                    })}
              </p>
            )}
          </div>
        );
      case 'page': {
        const selectedPage = (pages || []).find(page => page.id === draft.pageId);
        return (
          <div className="space-y-4">
            <div>
              <label htmlFor="project-item-page" className={LABEL_CLASS}>
                {t('admin.projects.addItem.page', 'Page')}
              </label>
              <select
                id="project-item-page"
                value={draft.pageId}
                disabled={pages === null}
                onChange={e => update({ pageId: e.target.value, language: '' })}
                className={INPUT_CLASS}
              >
                <option value="">
                  {pages === null
                    ? t('common.loading', 'Loading...')
                    : t('admin.projects.addItem.choosePage', 'Choose a page')}
                </option>
                {(pages || []).map(page => (
                  <option key={page.id} value={page.id}>
                    {localizedText(page.title, language) || page.id}
                  </option>
                ))}
              </select>
            </div>
            {selectedPage?.languages?.length > 0 && (
              <div>
                <label htmlFor="project-item-page-language" className={LABEL_CLASS}>
                  {t('admin.projects.addItem.language', 'Language')}
                </label>
                <select
                  id="project-item-page-language"
                  value={draft.language}
                  onChange={e => update({ language: e.target.value })}
                  className={INPUT_CLASS}
                >
                  <option value="">
                    {t('admin.projects.addItem.userLanguage', "The user's language")}
                  </option>
                  {selectedPage.languages.map(code => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        );
      }
      case 'ifinder-document':
        return (
          <div className="space-y-3">
            <label htmlFor="project-item-ifinder-search" className={LABEL_CLASS}>
              {t('admin.projects.addItem.ifinderSearch', 'Search iFinder')}
            </label>
            <div className="flex gap-2">
              <input
                id="project-item-ifinder-search"
                type="search"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleSearch();
                  }
                }}
                className={INPUT_CLASS}
              />
              <button
                type="button"
                onClick={handleSearch}
                disabled={!searchQuery.trim() || searching}
                className={SECONDARY_BUTTON}
              >
                {searching
                  ? t('admin.projects.addItem.searching', 'Searching...')
                  : t('admin.projects.addItem.search', 'Search')}
              </button>
            </div>
            {searchResults && (
              <ul
                className="max-h-56 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-200 dark:divide-gray-700"
                data-testid="ifinder-results"
              >
                {searchResults.length === 0 && (
                  <li className="p-3 text-sm text-gray-500 dark:text-gray-400">
                    {t('admin.projects.addItem.noResults', 'No documents found.')}
                  </li>
                )}
                {searchResults.map(result => {
                  const selected = draft.documentId === result.documentId;
                  return (
                    <li key={result.documentId}>
                      <button
                        type="button"
                        onClick={() =>
                          update({
                            documentId: result.documentId,
                            documentTitle: result.title || result.documentId,
                            name: draft.name || result.title || ''
                          })
                        }
                        aria-pressed={selected}
                        className={`w-full text-left p-3 text-sm ${
                          selected
                            ? 'bg-indigo-50 dark:bg-indigo-900/30'
                            : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                        }`}
                      >
                        <div className="font-medium text-gray-900 dark:text-gray-100 truncate">
                          {result.title || result.documentId}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {[result.mimeType, result.url].filter(Boolean).join(' · ')}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {draft.documentId && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('admin.projects.addItem.selectedDocument', 'Selected: {{title}}', {
                  title: draft.documentTitle
                })}
              </p>
            )}
          </div>
        );
      case 'ifinder-query':
        return (
          <div>
            <label htmlFor="project-item-query" className={LABEL_CLASS}>
              {t('admin.projects.addItem.query', 'Search query')}
            </label>
            <input
              id="project-item-query"
              type="text"
              value={draft.query}
              onChange={e => update({ query: e.target.value })}
              className={INPUT_CLASS}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.projects.addItem.queryHint',
                'The documents matching this query are read whenever the project is used.'
              )}
            </p>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClassName="max-w-3xl"
      labelledBy="add-project-item-title"
    >
      <form onSubmit={handleSubmit} className="flex flex-col min-h-0">
        <div className="px-6 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
          <h3
            id="add-project-item-title"
            className="text-lg font-medium text-gray-900 dark:text-gray-100"
          >
            {t('admin.projects.addItem.title', 'Add item')}
          </h3>
          <div
            role="tablist"
            aria-label={t('admin.projects.addItem.kinds', 'Item kinds')}
            className="mt-3 flex flex-wrap gap-1"
          >
            {tabs.map(candidate => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={candidate.id === tab.id}
                aria-disabled={!candidate.enabled || undefined}
                title={disabledReason(candidate) || undefined}
                onClick={() => {
                  setChosenTab(candidate.id);
                  setError(null);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${
                  candidate.id === tab.id
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                } ${candidate.enabled ? '' : 'opacity-50'}`}
              >
                <Icon name={kindIcon(candidate.id)} size="xs" />
                {tabLabel(candidate)}
              </button>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 space-y-4 overflow-y-auto">
          {renderTabBody()}

          {tab.enabled && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
              <div className="sm:col-span-2">
                <label htmlFor="project-item-name" className={LABEL_CLASS}>
                  {t('admin.projects.addItem.name', 'Name')}
                </label>
                <input
                  id="project-item-name"
                  type="text"
                  value={draft.name}
                  placeholder={t(
                    'admin.projects.addItem.namePlaceholder',
                    'Optional; derived from the content when empty'
                  )}
                  onChange={e => update({ name: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 pb-2">
                <input
                  type="checkbox"
                  checked={draft.pinned}
                  onChange={e => update({ pinned: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
                />
                {t('admin.projects.addItem.pinned', 'Pinned (always in the prompt)')}
              </label>
            </div>
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
            type="submit"
            disabled={!tab.enabled || submitting}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 flex items-center"
          >
            {submitting && <Icon name="arrow-path" size="sm" className="animate-spin mr-2" />}
            {t('admin.projects.addItem.submit', 'Add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default AddProjectItemDialog;
