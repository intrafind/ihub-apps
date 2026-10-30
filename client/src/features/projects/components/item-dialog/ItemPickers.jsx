// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { formatBytes } from '../../../admin/utils/systemResourcesFormat';
import { localizedText, uploadAccept } from '../../utils/projectItems';
import { HINT_CLASS, INPUT_CLASS, LABEL_CLASS, SECONDARY_BUTTON } from './dialogStyles';
import SiteCrawlPanel from './SiteCrawlPanel';
import UrlPreviewPanel from './UrlPreviewPanel';

/**
 * The pickers of the "Add item" dialog, one per picker type of spec 1 §4.1
 * (`upload`, `url`, `page`, `ifinder`) plus the pasted-text tab. Each one
 * only edits the dialog's draft; the dialog builds and sends the request.
 *
 * @module features/projects/components/item-dialog/ItemPickers
 */

/**
 * File upload: a file input and, where several files are allowed, a drop zone.
 *
 * @param {Object} props
 * @param {Array<File>} props.files
 * @param {(files: Array<File>) => void} props.onFilesChange
 * @param {Object|null} props.config - `_config` (accept list, limits).
 * @param {boolean} [props.multiple=false]
 * @returns {JSX.Element}
 */
export function UploadPicker({ files, onFilesChange, config, multiple = false }) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const maxBytes = config?.limits?.maxFileBytes;

  const take = list => {
    const picked = Array.from(list || []);
    onFilesChange(multiple ? picked : picked.slice(0, 1));
  };

  return (
    <div
      className={`rounded-lg border-2 border-dashed p-4 transition-colors ${
        dragging
          ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20'
          : 'border-gray-300 dark:border-gray-600'
      }`}
      onDragOver={event => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        take(event.dataTransfer?.files);
      }}
      data-testid="project-item-dropzone"
    >
      <label htmlFor="project-item-file" className={LABEL_CLASS}>
        {t('projects.addItem.file', 'File')}
      </label>
      <input
        id="project-item-file"
        type="file"
        multiple={multiple}
        accept={uploadAccept(config)}
        onChange={e => take(e.target.files)}
        className="block w-full text-sm text-gray-700 dark:text-gray-300"
      />
      {multiple && (
        <p className={HINT_CLASS}>{t('projects.addItem.dropHint', 'Or drop files here.')}</p>
      )}
      {config?.upload?.summary && (
        <p className={HINT_CLASS}>
          {t('projects.addItem.accepted', 'Accepted: {{types}}', {
            types: config.upload.summary
          })}
        </p>
      )}
      {Number.isFinite(maxBytes) && maxBytes > 0 && (
        <p className={HINT_CLASS}>
          {t('projects.addItem.maxFileSize', 'At most {{size}} per file.', {
            size: formatBytes(maxBytes)
          })}
        </p>
      )}
      {files.length > 1 && (
        <ul className="mt-2 text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
          {files.map(file => (
            <li key={`${file.name}-${file.size}`} className="truncate">
              {file.name} · {formatBytes(file.size)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Pasted text, stored as an `upload` item.
 *
 * @param {{draft: Object, update: (changes: Object) => void}} props
 * @returns {JSX.Element}
 */
export function TextPicker({ draft, update }) {
  const { t } = useTranslation();
  return (
    <div>
      <label htmlFor="project-item-text" className={LABEL_CLASS}>
        {t('projects.addItem.text', 'Text')}
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
}

/**
 * A web page by URL, with a check that it can be read and a preview of the
 * text it gives the model before it is added. With `crawlUrl`, the pages the
 * page links to on the same site can be listed and several added at once
 * (`draft.selectedUrls`).
 *
 * @param {Object} props
 * @param {Object} props.draft
 * @param {(changes: Object) => void} props.update
 * @param {(url: string) => Promise<{ok: boolean, error?: string}>} props.checkUrl
 * @param {(url: string) => Promise<Object>} [props.previewUrl] - See `UrlPreviewPanel`.
 * @param {(url: string, options: Object) => Promise<Object>} [props.crawlUrl] - See
 *   `SiteCrawlPanel`.
 * @param {Set<string>} [props.existingUrls] - `comparableUrl` forms of the URLs
 *   the project has already.
 * @param {number} [props.remaining] - Items the project still takes.
 * @param {boolean} [props.busy] - The picked pages are being added.
 * @param {(error: Error) => string} props.errorMessage
 * @returns {JSX.Element}
 */
export function UrlPicker({
  draft,
  update,
  checkUrl,
  previewUrl,
  crawlUrl,
  existingUrls,
  remaining,
  busy,
  errorMessage
}) {
  const { t } = useTranslation();
  const [check, setCheck] = useState(null);
  const [preview, setPreview] = useState(null);
  // The control a preview was opened from, to give the focus back on close.
  const previewOpenerRef = useRef(null);
  const selected = draft.selectedUrls || [];

  const closePreview = () => {
    setPreview(null);
    const opener = previewOpenerRef.current;
    previewOpenerRef.current = null;
    if (opener?.isConnected) opener.focus();
  };

  // A check answers for the URL it was started for: one that comes back
  // after the URL was edited (or checked again) is dropped, so a slow answer
  // never reports on an earlier URL.
  const runCheck = async () => {
    const url = draft.url.trim();
    setCheck({ checking: true, url });
    let outcome;
    try {
      outcome = await checkUrl(url);
    } catch (err) {
      outcome = { ok: false, error: errorMessage(err) };
    }
    setCheck(current => (current?.url === url ? { ...outcome, url } : current));
  };

  // The same for a preview: the panel shows the page last asked for.
  const runPreview = async (target, title) => {
    const url = String(target || '').trim();
    if (!url) return;
    if (typeof document !== 'undefined') previewOpenerRef.current = document.activeElement;
    setPreview({ loading: true, url, title });
    let outcome;
    try {
      outcome = await previewUrl(url);
    } catch (err) {
      outcome = { ok: false, error: errorMessage(err) };
    }
    setPreview(current =>
      current?.url === url ? { ...outcome, url, title: outcome.title || title } : current
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="project-item-url" className={LABEL_CLASS}>
          {t('projects.addItem.url', 'URL')}
        </label>
        <div className="flex gap-2">
          <input
            id="project-item-url"
            type="url"
            value={draft.url}
            placeholder="https://example.com/handbook"
            onChange={e => {
              // Pages found for another address are no longer offered.
              update({ url: e.target.value, ...(selected.length > 0 ? { selectedUrls: [] } : {}) });
              setCheck(null);
            }}
            className={INPUT_CLASS}
          />
          <button
            type="button"
            onClick={runCheck}
            disabled={!draft.url.trim() || check?.checking}
            className={SECONDARY_BUTTON}
          >
            {check?.checking
              ? t('projects.addItem.checking', 'Checking...')
              : t('projects.addItem.check', 'Check')}
          </button>
          {previewUrl && (
            <button
              type="button"
              onClick={() => void runPreview(draft.url)}
              disabled={!draft.url.trim() || (preview?.loading && preview.url === draft.url.trim())}
              className={SECONDARY_BUTTON}
            >
              {t('projects.addItem.preview', 'Preview')}
            </button>
          )}
        </div>
        {check && !check.checking && (
          <p
            className={`mt-1 text-sm ${
              check.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {check.ok
              ? t('projects.addItem.urlOk', 'The page can be read.')
              : t('projects.addItem.urlFailed', 'The page cannot be read: {{error}}', {
                  error: check.error || ''
                })}
          </p>
        )}
      </div>
      {preview && <UrlPreviewPanel preview={preview} onClose={closePreview} />}
      {crawlUrl && (
        <SiteCrawlPanel
          url={draft.url}
          crawlUrl={crawlUrl}
          errorMessage={errorMessage}
          selected={selected}
          onSelectedChange={selectedUrls => update({ selectedUrls })}
          onPreview={previewUrl ? runPreview : undefined}
          existingUrls={existingUrls}
          remaining={remaining}
          busy={busy}
        />
      )}
    </div>
  );
}

/**
 * An iHub page, in a fixed language or the reader's.
 *
 * @param {Object} props
 * @param {Object} props.draft
 * @param {(changes: Object) => void} props.update
 * @param {Array<{id: string, title: string|Object, languages: string[]}>|null} props.pages -
 *   `null` while loading.
 * @returns {JSX.Element}
 */
export function PagePicker({ draft, update, pages }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const selectedPage = (pages || []).find(page => page.id === draft.pageId);
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="project-item-page" className={LABEL_CLASS}>
          {t('projects.addItem.page', 'Page')}
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
              : t('projects.addItem.choosePage', 'Choose a page')}
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
            {t('projects.addItem.language', 'Language')}
          </label>
          <select
            id="project-item-page-language"
            value={draft.language}
            onChange={e => update({ language: e.target.value })}
            className={INPUT_CLASS}
          >
            <option value="">{t('projects.addItem.userLanguage', "The user's language")}</option>
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

/**
 * The iFinder search profiles the caller may search in, loaded once; null while
 * loading or without a loader, `{profiles: []}` when they could not be read.
 *
 * @param {(() => Promise<Object>)|undefined} fetchProfiles
 * @returns {{profiles: Array<{id: string, name: string}>, defaultProfile: string|null,
 *   fixed: boolean}|null}
 */
function useIFinderProfiles(fetchProfiles) {
  const [listing, setListing] = useState(null);
  useEffect(() => {
    if (typeof fetchProfiles !== 'function') return undefined;
    let active = true;
    fetchProfiles()
      .then(result => active && setListing(result))
      .catch(() => active && setListing({ profiles: [], defaultProfile: null, fixed: false }));
    return () => {
      active = false;
    };
  }, [fetchProfiles]);
  return listing;
}

/**
 * Where an iFinder picker searches: the caller's search profiles, as the chat
 * input offers them. Not shown with a single profile or a fixed one. The draft
 * keeps `searchProfile` empty for the default, so only another profile is
 * stored with the item (and read with it).
 *
 * @param {Object} props
 * @param {string} props.id
 * @param {ReturnType<typeof useIFinderProfiles>} props.listing
 * @param {string} props.value - The draft's `searchProfile`; empty for the default.
 * @param {(profile: string) => void} props.onChange
 * @returns {JSX.Element|null}
 */
function IFinderProfileSelect({ id, listing, value, onChange }) {
  const { t } = useTranslation();
  if (!listing || listing.fixed || listing.profiles.length < 2) return null;
  const fallback = listing.defaultProfile || listing.profiles[0]?.id || '';
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {t('projects.addItem.ifinderProfile', 'Search in')}
      </label>
      <select
        id={id}
        value={value || fallback}
        onChange={e => onChange(e.target.value === fallback ? '' : e.target.value)}
        className={INPUT_CLASS}
      >
        {listing.profiles.map(profile => (
          <option key={profile.id} value={profile.id}>
            {profile.name || profile.id}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * One iFinder document, found by a search with the caller's own rights, in the
 * search profile they pick (when they have more than one).
 *
 * @param {Object} props
 * @param {Object} props.draft
 * @param {(changes: Object) => void} props.update
 * @param {(query: string, options?: {profile?: string}) => Promise<Array<Object>>} props.searchIFinder
 * @param {() => Promise<Object>} [props.fetchProfiles] - The caller's search profiles;
 *   without it the default profile is searched.
 * @param {(error: Error) => string} props.errorMessage
 * @returns {JSX.Element}
 */
export function IFinderDocumentPicker({
  draft,
  update,
  searchIFinder,
  fetchProfiles,
  errorMessage
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const profiles = useIFinderProfiles(fetchProfiles);

  const search = async () => {
    // Enter in the field reaches here too, not only the (disabled) button.
    if (!query.trim() || searching) return;
    setSearching(true);
    setError(null);
    try {
      setResults(
        await searchIFinder(
          query.trim(),
          draft.searchProfile ? { profile: draft.searchProfile } : undefined
        )
      );
    } catch (err) {
      setResults([]);
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-3">
      <IFinderProfileSelect
        id="project-item-ifinder-profile"
        listing={profiles}
        value={draft.searchProfile}
        onChange={searchProfile => {
          // A hit of another profile is not offered under this one.
          setResults(null);
          update({ searchProfile, documentId: '', documentTitle: '' });
        }}
      />
      <label htmlFor="project-item-ifinder-search" className={LABEL_CLASS}>
        {t('projects.addItem.ifinderSearch', 'Search iFinder')}
      </label>
      <div className="flex gap-2">
        <input
          id="project-item-ifinder-search"
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void search();
            }
          }}
          className={INPUT_CLASS}
        />
        <button
          type="button"
          onClick={search}
          disabled={!query.trim() || searching}
          className={SECONDARY_BUTTON}
        >
          {searching
            ? t('projects.addItem.searching', 'Searching...')
            : t('projects.addItem.search', 'Search')}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {results && (
        <ul
          className="max-h-56 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-200 dark:divide-gray-700"
          data-testid="ifinder-results"
        >
          {results.length === 0 && (
            <li className="p-3 text-sm text-gray-500 dark:text-gray-400">
              {t('projects.addItem.noResults', 'No documents found.')}
            </li>
          )}
          {results.map(result => {
            const selected = draft.documentId === result.documentId;
            return (
              <li key={result.documentId}>
                <button
                  type="button"
                  onClick={() =>
                    update({
                      documentId: result.documentId,
                      documentTitle: result.title || result.documentId,
                      // The name follows the picked document until the user
                      // types one of their own.
                      name:
                        !draft.name || draft.name === draft.documentTitle
                          ? result.title || ''
                          : draft.name
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
          {t('projects.addItem.selectedDocument', 'Selected: {{title}}', {
            title: draft.documentTitle
          })}
        </p>
      )}
    </div>
  );
}

/**
 * An iFinder search whose matching documents are read whenever the project is
 * used, in the search profile the caller picks (when they have more than one).
 *
 * @param {{draft: Object, update: (changes: Object) => void,
 *   fetchProfiles?: () => Promise<Object>}} props
 * @returns {JSX.Element}
 */
export function IFinderQueryPicker({ draft, update, fetchProfiles }) {
  const { t } = useTranslation();
  const profiles = useIFinderProfiles(fetchProfiles);
  return (
    <div className="space-y-3">
      <IFinderProfileSelect
        id="project-item-query-profile"
        listing={profiles}
        value={draft.searchProfile}
        onChange={searchProfile => update({ searchProfile })}
      />
      <div>
        <label htmlFor="project-item-query" className={LABEL_CLASS}>
          {t('projects.addItem.query', 'Search query')}
        </label>
        <input
          id="project-item-query"
          type="text"
          value={draft.query}
          onChange={e => update({ query: e.target.value })}
          className={INPUT_CLASS}
        />
        <p className={HINT_CLASS}>
          {t(
            'projects.addItem.queryHint',
            'The documents matching this query are read whenever the project is used.'
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Why a tab cannot be used.
 *
 * @param {{reason: string|null}} props
 * @returns {JSX.Element}
 */
export function DisabledTabNotice({ reason }) {
  const { t } = useTranslation();
  const text =
    reason === 'later'
      ? t('projects.addItem.comingLater', 'Coming in a later release.')
      : reason === 'storageUnavailable'
        ? t(
            'projects.addItem.storageUnavailable',
            'Files and text need the project storage, which is not available on this server.'
          )
        : t('projects.addItem.kindDisabled', 'This kind is not enabled on this server.');
  return (
    <div className="flex items-start gap-2 p-4 rounded-lg bg-gray-50 dark:bg-gray-900/40 text-sm text-gray-600 dark:text-gray-400">
      <Icon name="information-circle" className="h-5 w-5 shrink-0" />
      <p>{text}</p>
    </div>
  );
}
