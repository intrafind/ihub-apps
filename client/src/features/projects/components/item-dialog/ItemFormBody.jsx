// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { formatBytes } from '../../../admin/utils/systemResourcesFormat';
import { buildItemRequest, validateUploads } from '../../utils/projectItems';
import {
  DisabledTabNotice,
  IFinderDocumentPicker,
  IFinderQueryPicker,
  PagePicker,
  TextPicker,
  UploadPicker,
  UrlPicker
} from './ItemPickers';
import { INPUT_CLASS, LABEL_CLASS, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialogStyles';

/** A fresh draft: shared fields plus each picker's input. */
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
 * The translated message of a validation code of the dialog.
 *
 * @param {Function} t
 * @param {string} code
 * @param {Object|null} config
 * @returns {string}
 */
function validationMessage(t, code, config) {
  const limits = config?.limits || {};
  switch (code) {
    case 'fileRequired':
      return t('projects.addItem.errors.fileRequired', 'Choose a file to upload.');
    case 'fileTooLarge':
      return t('projects.addItem.errors.fileTooLarge', 'The file is larger than {{max}}.', {
        max: formatBytes(limits.maxFileBytes)
      });
    case 'quotaFiles':
      return t(
        'projects.addItem.errors.quotaFiles',
        'A project holds at most {{max}} items; remove some first.',
        { max: limits.maxFiles }
      );
    case 'quotaProjectBytes':
      return t(
        'projects.addItem.errors.quotaProjectBytes',
        'These files do not fit into the {{max}} a project may hold.',
        { max: formatBytes(limits.maxProjectBytes) }
      );
    case 'textRequired':
      return t('projects.addItem.errors.textRequired', 'Enter the text to add.');
    case 'urlInvalid':
      return t('projects.addItem.errors.urlInvalid', 'Enter a valid http(s) URL.');
    case 'pageRequired':
      return t('projects.addItem.errors.pageRequired', 'Choose a page.');
    case 'documentRequired':
      return t('projects.addItem.errors.documentRequired', 'Search iFinder and choose a document.');
    case 'queryRequired':
      return t('projects.addItem.errors.queryRequired', 'Enter a search query.');
    default:
      return t('projects.addItem.errors.unsupported', 'This kind cannot be added here.');
  }
}

/**
 * Upload the files one by one (each is its own request with its own status,
 * spec 3 §2). A failure does not stop the others.
 *
 * @returns {Promise<{added: Array<Object>, failures: string[]}>}
 */
async function uploadAll(api, projectId, files, { name, pinned }) {
  const added = [];
  const failures = [];
  for (const file of files) {
    try {
      added.push(
        await api.uploadItem(projectId, {
          file,
          name: files.length === 1 ? name || undefined : undefined,
          pinned
        })
      );
    } catch (err) {
      failures.push(
        files.length === 1 ? api.errorMessage(err) : `${file.name}: ${api.errorMessage(err)}`
      );
    }
  }
  return { added, failures };
}

/**
 * The form of every non-cloud tab: the tab's picker, the optional name, the
 * pinned flag, and the submit. A disabled tab shows why instead.
 *
 * @param {Object} props
 * @param {{id: string, enabled: boolean, reason: string|null}} props.tab
 * @param {string} props.projectId
 * @param {Object|null} props.config
 * @param {Object} props.api - See `AddProjectItemDialog`.
 * @param {boolean} props.multipleUploads
 * @param {{items?: number, bytes?: number}|null} props.usage
 * @param {(item: Object) => void} props.onAdded
 * @param {() => void} props.onClose
 * @returns {JSX.Element}
 */
function ItemFormBody({ tab, projectId, config, api, multipleUploads, usage, onAdded, onClose }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [files, setFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [pages, setPages] = useState(null);
  const update = changes => setDraft(prev => ({ ...prev, ...changes }));

  // A new tab starts without the previous tab's error (adjusted during render).
  const [errorTab, setErrorTab] = useState(tab.id);
  if (errorTab !== tab.id) {
    setErrorTab(tab.id);
    setError(null);
  }

  // The page list is loaded once, the first time the page tab is shown.
  useEffect(() => {
    if (tab.id !== 'page' || !tab.enabled || pages !== null) return;
    api
      .fetchPages()
      .then(setPages)
      .catch(err => {
        setPages([]);
        setError(api.errorMessage(err));
      });
  }, [tab.id, tab.enabled, pages, api]);

  const submitUpload = async () => {
    const uploadError = validateUploads(files, config, usage);
    if (uploadError) return setError(validationMessage(t, uploadError, config));
    setSubmitting(true);
    const { added, failures } = await uploadAll(api, projectId, files, {
      name: draft.name.trim(),
      pinned: draft.pinned
    });
    added.forEach(item => onAdded(item));
    setSubmitting(false);
    if (failures.length > 0) return setError(failures.join('\n'));
    return onClose();
  };

  const submitJson = async () => {
    const { body, error: requestError } = buildItemRequest(tab.id, draft);
    if (requestError) return setError(validationMessage(t, requestError, config));
    setSubmitting(true);
    try {
      onAdded(await api.addItem(projectId, body));
      onClose();
    } catch (err) {
      setError(api.errorMessage(err));
    } finally {
      setSubmitting(false);
    }
    return undefined;
  };

  const handleSubmit = event => {
    event.preventDefault();
    setError(null);
    void (tab.id === 'upload' ? submitUpload() : submitJson());
  };

  const renderPicker = () => {
    if (!tab.enabled) return <DisabledTabNotice reason={tab.reason} />;
    switch (tab.id) {
      case 'upload':
        return (
          <UploadPicker
            files={files}
            onFilesChange={setFiles}
            config={config}
            multiple={multipleUploads}
          />
        );
      case 'text':
        return <TextPicker draft={draft} update={update} />;
      case 'url':
        return (
          <UrlPicker
            draft={draft}
            update={update}
            checkUrl={api.checkUrl}
            errorMessage={api.errorMessage}
          />
        );
      case 'page':
        return <PagePicker draft={draft} update={update} pages={pages} />;
      case 'ifinder-document':
        return (
          <IFinderDocumentPicker
            draft={draft}
            update={update}
            searchIFinder={api.searchIFinder}
            errorMessage={api.errorMessage}
          />
        );
      case 'ifinder-query':
        return <IFinderQueryPicker draft={draft} update={update} />;
      default:
        return null;
    }
  };

  const showName = tab.enabled && !(tab.id === 'upload' && files.length > 1);

  return (
    <form onSubmit={handleSubmit} className="flex flex-col min-h-0">
      <div className="px-6 py-4 space-y-4 overflow-y-auto">
        {renderPicker()}

        {tab.enabled && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
            {showName ? (
              <div className="sm:col-span-2">
                <label htmlFor="project-item-name" className={LABEL_CLASS}>
                  {t('projects.addItem.name', 'Name')}
                </label>
                <input
                  id="project-item-name"
                  type="text"
                  value={draft.name}
                  placeholder={t(
                    'projects.addItem.namePlaceholder',
                    'Optional; derived from the content when empty'
                  )}
                  onChange={e => update({ name: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
            ) : (
              <div className="sm:col-span-2" />
            )}
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 pb-2">
              <input
                type="checkbox"
                checked={draft.pinned}
                onChange={e => update({ pinned: e.target.checked })}
                className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
              />
              {t('projects.addItem.pinned', 'Pinned (always in the prompt)')}
            </label>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400 whitespace-pre-line">
            {error}
          </p>
        )}
      </div>

      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button type="submit" disabled={!tab.enabled || submitting} className={PRIMARY_BUTTON}>
          {submitting && <Icon name="arrow-path" size="sm" className="animate-spin mr-2" />}
          {t('projects.addItem.submit', 'Add')}
        </button>
      </div>
    </form>
  );
}

export default ItemFormBody;
