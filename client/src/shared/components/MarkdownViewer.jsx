import { useEffect, useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { configureMarked } from './MarkdownRenderer';
import MarkdownDownloadMenu from './MarkdownDownloadMenu';

/**
 * Modal markdown viewer. Renders an in-memory markdown string to HTML via
 * the shared `marked` config, sanitises with DOMPurify, and shows it
 * full-page so operators can read long reports comfortably. The download
 * menu remains available in the header.
 *
 * Mirrors `features/admin/components/ArtifactViewer.jsx` but operates on
 * content the caller already has — no `runId`/`name` fetch required.
 *
 * @param {Object} props
 * @param {string} props.content   The markdown body to render
 * @param {string} props.name      Title shown in the header, also used as filename hint
 * @param {Function} props.onClose Closes the modal
 */
function MarkdownViewer({ content, name, onClose }) {
  const htmlContent = useMemo(() => {
    try {
      configureMarked();
      return DOMPurify.sanitize(marked(content || ''));
    } catch {
      return DOMPurify.sanitize(`<pre>${(content || '').toString()}</pre>`);
    }
  }, [content]);

  // ESC closes.
  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!content && !name) return null;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-4xl w-full my-8 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 truncate">
              {name || 'Report'}
            </h3>
            <MarkdownDownloadMenu content={content} name={name} size="md" />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div
            className="prose dark:prose-invert max-w-none prose-headings:text-gray-900 dark:prose-headings:text-white prose-p:text-gray-700 dark:prose-p:text-gray-300 prose-a:text-indigo-600 dark:prose-a:text-indigo-400"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        </div>
      </div>
    </div>
  );
}

export default MarkdownViewer;
