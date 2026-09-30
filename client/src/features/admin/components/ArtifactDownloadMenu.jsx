import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadArtifactAs } from '../utils/artifactDownload';

/**
 * Compact "⬇ download ▾" dropdown used in both the artifact list rows and
 * the ArtifactViewer modal header. Renders four format options; the file is
 * generated, AI-labelled and signed by the server (`POST /api/exports`).
 * While a download is in flight the trigger shows a busy placeholder so the
 * user knows the click registered.
 *
 * Sized `size="sm"` for tight list rows and `size="md"` for the modal
 * header (slightly more padding).
 *
 * @param {Object} props
 * @param {string} props.runId - Agent run id
 * @param {string} props.name - Artifact name
 * @param {'sm'|'md'} [props.size='sm']
 * @param {Function} [props.onError] - Called with the error of a failed download
 * @returns {JSX.Element}
 */
function ArtifactDownloadMenu({ runId, name, size = 'sm', onError }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
    try {
      await downloadArtifactAs(runId, name, format);
    } catch (err) {
      if (onError) onError(err);
      else console.error('Artifact download failed', err);
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
      ? 'text-xs px-2 py-0.5 border border-indigo-300 dark:border-indigo-700 rounded-sm text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-50'
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
          className="absolute left-0 mt-1 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-sm shadow-lg z-20"
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
    </div>
  );
}

export default ArtifactDownloadMenu;
