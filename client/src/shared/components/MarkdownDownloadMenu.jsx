import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { exportMarkdownDocument } from '../utils/markdownExports';

/**
 * Compact "⬇ download ▾" dropdown for an in-memory markdown string (workflow
 * outputs, the markdown viewer). The file is generated, AI-labelled and signed
 * by the server (`POST /api/exports`); the menu only picks the format.
 *
 * While a download is in flight the trigger shows a busy placeholder so the
 * user knows the click registered; a failure is reported through `onError`,
 * or shown under the trigger when no handler is passed.
 *
 * @param {Object} props
 * @param {string} props.content - The markdown body to export
 * @param {string} props.name - Suggested file name / document title (without extension)
 * @param {'markdown'|'workflow'} [props.source='markdown'] - What the document is
 *   (`workflow` for workflow execution reports)
 * @param {string} [props.appId] - App the document belongs to, if any
 * @param {'sm'|'md'} [props.size='sm']
 * @param {Function} [props.onError] - Called with the error of a failed export
 * @returns {JSX.Element}
 */
function MarkdownDownloadMenu({ content, name, source = 'markdown', appId, size = 'sm', onError }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ref = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const handler = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = e => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function run(format) {
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      await exportMarkdownDocument({ content, name, format, source, appId });
    } catch (err) {
      if (onError) onError(err);
      else {
        console.error('Download failed', err);
        setError(
          t('pages.appChat.export.errors.failed', {
            message: err?.message || '',
            defaultValue: 'The export failed: {{message}}'
          })
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const options = [
    { format: 'markdown', label: t('pages.appChat.export.menu.markdown', 'Markdown (.md)') },
    { format: 'html', label: t('pages.appChat.export.menu.html', 'HTML (.html)') },
    { format: 'pdf', label: t('pages.appChat.export.menu.pdf', 'PDF (.pdf)') },
    { format: 'docx', label: t('pages.appChat.export.menu.docx', 'Word (.docx)') }
  ];

  const triggerClass =
    size === 'md'
      ? 'text-xs px-2 py-1 border border-indigo-300 dark:border-indigo-700 rounded-sm text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-50'
      : 'text-xs px-1.5 py-0.5 border border-indigo-300 dark:border-indigo-700 rounded-sm text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-50';

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={busy}
        className={triggerClass}
        title={t('pages.appChat.export.menu.title', 'Download as…')}
        aria-label={t('pages.appChat.export.menu.title', 'Download as…')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={busy}
      >
        {busy
          ? t('pages.appChat.export.menu.busy', 'Preparing…')
          : t('pages.appChat.export.menu.trigger', '⬇ download ▾')}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 mt-1 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-sm shadow-lg z-20"
        >
          {options.map(option => (
            <button
              key={option.format}
              type="button"
              role="menuitem"
              onClick={() => run(option.format)}
              className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200"
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300 max-w-xs">
          {error}
        </p>
      )}
    </div>
  );
}

export default MarkdownDownloadMenu;
