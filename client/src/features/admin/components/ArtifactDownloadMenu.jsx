import { useEffect, useRef, useState } from 'react';
import {
  downloadAsMarkdown,
  downloadAsHTML,
  downloadAsDOCX,
  printAsPDF
} from '../utils/artifactDownload';

/**
 * Compact ⬇ Download ▾ dropdown used in both the artifact list rows and
 * the ArtifactViewer modal header. Renders four format options and runs
 * the matching helper. While a download is in flight the trigger shows a
 * spinner-y placeholder so the user knows the click registered.
 *
 * Sized `size="sm"` for tight list rows and `size="md"` for the modal
 * header (slightly more padding).
 */
function ArtifactDownloadMenu({ runId, name, size = 'sm', onError }) {
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
      else console.error('Artifact download failed', err);
    } finally {
      setBusy(false);
    }
  }

  const triggerClass =
    size === 'md'
      ? 'text-xs px-2 py-0.5 border border-indigo-300 rounded text-indigo-700 hover:bg-indigo-50 disabled:opacity-50'
      : 'text-xs px-1.5 py-0.5 border border-indigo-300 rounded text-indigo-700 hover:bg-indigo-50 disabled:opacity-50';

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
        <div className="absolute left-0 mt-1 w-48 bg-white border rounded shadow-lg z-20">
          <button
            type="button"
            onClick={() => run(() => downloadAsMarkdown(runId, name))}
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100"
          >
            Markdown (.md)
          </button>
          <button
            type="button"
            onClick={() => run(() => downloadAsHTML(runId, name))}
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100"
          >
            HTML (.html)
          </button>
          <button
            type="button"
            onClick={() => run(() => printAsPDF(runId, name))}
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100"
          >
            PDF (via print dialog)
          </button>
          <button
            type="button"
            onClick={() => run(() => downloadAsDOCX(runId, name))}
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100"
          >
            Word (.docx)
          </button>
        </div>
      )}
    </div>
  );
}

export default ArtifactDownloadMenu;
