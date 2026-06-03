import { useEffect, useRef, useState } from 'react';
import {
  exportAsMarkdown,
  exportAsHTML,
  printAsPDF,
  exportAsDOCX
} from '../utils/markdownExports';

/**
 * Compact ⬇ Download ▾ dropdown that operates on an in-memory markdown
 * string (no server round-trip). Used by the workflow execution page and
 * any other surface that already has the rendered report in memory.
 *
 * Renders four format options: Markdown / HTML / PDF (via print dialog) /
 * Word (.docx). While a conversion is in flight the trigger shows a
 * spinner-y placeholder so the user knows the click registered.
 *
 * @param {Object} props
 * @param {string} props.content    The markdown body to export
 * @param {string} props.name       Suggested filename (without extension)
 * @param {string} [props.size]     'sm' (default) or 'md'
 * @param {Function} [props.onError]
 */
function MarkdownDownloadMenu({ content, name, size = 'sm', onError }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handler = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  async function run(fn) {
    setOpen(false);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      if (onError) onError(err);
      else console.error('Download failed', err);
    } finally {
      setBusy(false);
    }
  }

  const triggerClass =
    size === 'md'
      ? 'text-xs px-2 py-1 border border-indigo-300 dark:border-indigo-700 rounded text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-50'
      : 'text-xs px-1.5 py-0.5 border border-indigo-300 dark:border-indigo-700 rounded text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-50';

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={busy}
        className={triggerClass}
        title="Download as…"
      >
        {busy ? '…' : '⬇ download ▾'}
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg z-20">
          <button
            type="button"
            onClick={() => run(() => exportAsMarkdown(content, name))}
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200"
          >
            Markdown (.md)
          </button>
          <button
            type="button"
            onClick={() => run(() => exportAsHTML(content, name))}
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200"
          >
            HTML (.html)
          </button>
          <button
            type="button"
            onClick={() => run(() => printAsPDF(content, name))}
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200"
          >
            PDF (via print dialog)
          </button>
          <button
            type="button"
            onClick={() => run(() => exportAsDOCX(content, name))}
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200"
          >
            Word (.docx)
          </button>
        </div>
      )}
    </div>
  );
}

export default MarkdownDownloadMenu;
