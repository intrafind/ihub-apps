import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchSourceMetadata } from '../../../api/endpoints/sources';
import { siteOf } from '../sources/sourcesView';

/** A date in the locale of the browser, or the value as it came when it does not parse. */
function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

/**
 * A source's details: what its provider knows about it (`GET
 * /api/sources/:provider/metadata`, fetched with the user's own permissions),
 * and what the source itself carries while that loads or when the provider
 * has no details to give.
 *
 * @param {Object} props
 * @param {Object} props.source - `shared/sources/source.js`
 * @param {Function} props.onClose
 */
function SourceDetailsModal({ source, onClose }) {
  const { t } = useTranslation();
  const titleId = useId();
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // Via apiClient, not a bare cookie `fetch`: the Outlook task pane and the
    // extension side panel carry their session in an Authorization header.
    fetchSourceMetadata({ source, signal: controller.signal })
      .then(data => {
        if (!cancelled) setMetadata(data || {});
      })
      .catch(err => {
        if (!cancelled && err.name !== 'CanceledError' && err.code !== 'ERR_CANCELED') {
          setError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [source]);

  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const details = metadata || {};
  const title = details.title || source.title || t('sources.untitled', 'Untitled');
  const fileName = details.filename || source.fileName;
  const rows = [
    { label: t('sources.fileType', 'File type'), value: details.application || source.type },
    { label: t('sources.fileSize', 'File size'), value: details.sizeFormatted },
    { label: t('sources.author', 'Author'), value: details.author },
    { label: t('sources.source', 'Source'), value: details.sourceName || siteOf(source) },
    {
      label: t('sources.modified', 'Modified'),
      value: formatDate(details.modificationDate || source.publishedDate)
    },
    { label: t('sources.indexed', 'Indexed'), value: formatDate(details.indexingDate) },
    { label: t('sources.language', 'Language'), value: details.language }
  ].filter(row => row.value);
  const breadcrumbs = Array.isArray(details.navigationTree)
    ? details.navigationTree
        .map(node => (typeof node === 'string' ? node : node?.label || node?.name))
        .filter(Boolean)
    : [];
  const link = details.deepLink || source.url;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mx-4 max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl dark:bg-gray-800"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <h3 id={titleId} className="text-base font-semibold text-gray-900 dark:text-white">
            {t('sources.documentDetails', 'Details')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-600"
            aria-label={t('common.close', 'Close')}
          >
            <Icon name="x" size="md" />
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm font-medium leading-snug text-gray-900 dark:text-white">{title}</p>
          {fileName && fileName !== title && (
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{fileName}</p>
          )}
          {rows.length > 0 && (
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              {rows.map(({ label, value }) => (
                <div key={label} className="contents">
                  <dt className="whitespace-nowrap text-gray-500 dark:text-gray-400">{label}</dt>
                  <dd className="text-gray-900 dark:text-gray-100">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {breadcrumbs.length > 0 && (
            <div className="mt-4">
              <p className="mb-1 text-sm text-gray-500 dark:text-gray-400">
                {t('sources.breadcrumbs', 'Path')}
              </p>
              <p className="text-sm text-gray-700 dark:text-gray-300">{breadcrumbs.join(' › ')}</p>
            </div>
          )}
          {loading && (
            <p className="mt-4 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Icon name="spinner" size="sm" className="animate-spin" />
              {t('sources.loading', 'Loading…')}
            </p>
          )}
          {error && !loading && (
            <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
              {t('sources.detailsUnavailable', 'No further details are available.')}
            </p>
          )}
          {link && /^https?:\/\//i.test(link) && (
            <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-700">
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-sm text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {link}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SourceDetailsModal;
