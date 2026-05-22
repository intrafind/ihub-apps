import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { configureMarked } from '../../../shared/components/MarkdownRenderer';
import ArtifactDownloadMenu from './ArtifactDownloadMenu';

/**
 * Modal markdown viewer for agent run artifacts. Fetches the raw file from
 * /api/agents/runs/:runId/artifacts/:name, renders via the shared marked
 * config, sanitises with DOMPurify, and displays it inline so operators can
 * read reports without leaving the page. The download/raw links remain
 * available from the header.
 */
function ArtifactViewer({ runId, name, onClose }) {
  const [htmlContent, setHtmlContent] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!runId || !name) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHtmlContent('');
    fetch(`/api/agents/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`, {
      credentials: 'include'
    })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(text => {
        if (cancelled) return;
        try {
          configureMarked();
          const parsed = marked(text || '');
          // Sanitize before storing — render path uses dangerouslySetInnerHTML
          // and we only set state with content that's already gone through
          // DOMPurify, mirroring features/chat/components/StreamingMarkdown.
          setHtmlContent(DOMPurify.sanitize(parsed));
        } catch (renderErr) {
          setError(renderErr.message);
        }
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err.message || 'Failed to load artifact');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, name]);

  // ESC closes.
  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!name) return null;
  const artifactUrl = `/api/agents/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-4xl w-full my-8 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="font-semibold text-gray-900 truncate">{name}</h3>
            <ArtifactDownloadMenu
              runId={runId}
              name={name}
              size="md"
              onError={err => setError(err.message || 'Download failed')}
            />
            <a
              href={artifactUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-2 py-0.5 border border-gray-300 rounded text-gray-700 hover:bg-gray-50"
              title="Open raw"
            >
              raw
            </a>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-900 text-lg leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && <div className="text-sm text-gray-500">Loading…</div>}
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
              {error}
            </div>
          )}
          {!loading && !error && (
            <article
              className="prose prose-sm max-w-none prose-headings:font-semibold prose-a:text-indigo-600"
              dangerouslySetInnerHTML={{ __html: htmlContent }} // sanitized with DOMPurify before setState
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default ArtifactViewer;
