// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { highlightCode, renderMarkdown } from '../../../config/marked.config';
import { sanitizeMermaidSvg } from '../../../utils/mermaidSecurity';
import {
  MAX_PREVIEW_BYTES,
  artifactDisplayName,
  codeLanguageOf,
  formatBytes,
  previewTypeOf,
  withPreviewCsp
} from '../utils/artifactFiles';

/**
 * Read what a preview shows of a blob: an object URL for a picture or PDF, the
 * text (cut at {@link MAX_PREVIEW_BYTES}) for everything readable.
 */
async function loadPreview(type, blob) {
  if (type === 'image' || type === 'pdf') return { url: URL.createObjectURL(blob) };
  const truncated = blob.size > MAX_PREVIEW_BYTES;
  const text = await (truncated ? blob.slice(0, MAX_PREVIEW_BYTES) : blob).text();
  return { text, truncated };
}

/**
 * Pick the delimiter of a CSV/TSV text from its first record. Only delimiters
 * outside quoted fields count, so `"Last, First";Amount` is a semicolon file.
 */
function detectDelimiter(source) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"' && source[i + 1] === '"') i += 1;
      else if (ch === '"') inQuotes = false;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === '\r' || ch === '\n') {
      break;
    } else if (ch in counts) {
      counts[ch] += 1;
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/**
 * Parse a CSV/TSV string into rows for the table preview. Auto-detects comma,
 * semicolon or tab delimiter from the header record and handles RFC 4180 quotes.
 */
function parseCsvPreview(text, maxRows = 200) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(source);

  const allRows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some(c => c !== '')) allRows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    if (row.some(c => c !== '')) allRows.push(row);
  }
  const [header = [], ...dataRows] = allRows;
  return {
    header,
    rows: dataRows.slice(0, maxRows),
    totalRows: dataRows.length
  };
}

/** Pretty-print JSON; the text as it is when it does not parse (or was cut). */
function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * Parse a Jupyter Notebook (`.ipynb`) JSON string into cells for rich preview.
 */
function parseNotebookPreview(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.cells)) return null;
    const lang =
      parsed.metadata?.kernelspec?.language || parsed.metadata?.language_info?.name || 'python';
    const cells = parsed.cells.slice(0, 100).map((cell, index) => {
      const source = Array.isArray(cell?.source)
        ? cell.source.join('')
        : typeof cell?.source === 'string'
          ? cell.source
          : '';
      return {
        id: cell?.id || `cell-${index}`,
        type: cell?.cell_type === 'markdown' ? 'markdown' : 'code',
        executionCount: cell?.execution_count ?? null,
        source
      };
    });
    return { language: String(lang).toLowerCase(), cells };
  } catch {
    return null;
  }
}

/**
 * Preview of one artifact: a picture, rendered Markdown, pretty-printed JSON
 * or highlighted code. Office documents and archives have no preview; the
 * panel offers their download.
 *
 * Everything rendered as HTML is sanitized: Markdown by `renderMarkdown`,
 * highlighted code by DOMPurify (highlight.js escapes, but the text is a
 * model's).
 *
 * @param {Object} props
 * @param {Object} props.artifact - Descriptor `{ id, kind, mimeType, bytes, name? }`.
 * @param {(id: string) => Promise<Blob>} props.getBlob - Fetches (and caches) the bytes.
 */
export default function ArtifactPreview({ artifact, getBlob }) {
  const { t } = useTranslation();
  const type = previewTypeOf(artifact);
  const name = artifactDisplayName(artifact);
  const [state, setState] = useState({ status: 'loading' });
  const [viewMode, setViewMode] = useState('preview');

  useEffect(() => {
    setViewMode('preview');
    if (type === 'none') {
      setState({ status: 'none' });
      return undefined;
    }
    let active = true;
    let url = null;
    setState({ status: 'loading' });
    getBlob(artifact.id)
      .then(blob => loadPreview(type, blob))
      .then(content => {
        url = content.url || null;
        if (active) setState({ status: 'ready', ...content });
        else if (url) URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (active) setState({ status: 'error' });
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [artifact.id, type, getBlob]);

  if (state.status === 'loading') {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400" role="status">
        {t('chatArtifacts.previewLoading', 'Loading preview…')}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <p className="text-sm text-red-700 dark:text-red-400" role="alert">
        {t('chatArtifacts.previewFailed', 'The preview could not be loaded.')}
      </p>
    );
  }
  if (state.status === 'none') {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t(
          'chatArtifacts.noPreview',
          'There is no preview for this file type. Download it to open it.'
        )}
      </p>
    );
  }

  const truncatedNote = state.truncated ? (
    <p className="mb-2 text-xs text-amber-800 dark:text-amber-200">
      {t(
        'chatArtifacts.previewTruncated',
        'Showing the first {{size}}. Download the file to see all of it.',
        {
          size: formatBytes(MAX_PREVIEW_BYTES)
        }
      )}
    </p>
  ) : null;

  if (type === 'image') {
    return (
      <img
        src={state.url}
        alt={name}
        className="max-w-full h-auto rounded-md border border-gray-200 dark:border-gray-700"
      />
    );
  }

  if (type === 'pdf') {
    return (
      <iframe
        src={state.url}
        title={name}
        className="w-full h-[65vh] rounded-md border border-gray-200 dark:border-gray-700 bg-white"
      />
    );
  }

  if (type === 'markdown') {
    return (
      <>
        {truncatedNote}
        <article
          className="prose prose-sm dark:prose-invert max-w-none"
          // Sanitized by renderMarkdown (DOMPurify).
          dangerouslySetInnerHTML={{ __html: renderMarkdown(state.text) }}
        />
      </>
    );
  }

  const notebook = type === 'ipynb' ? parseNotebookPreview(state.text) : null;
  const hasRichPreview =
    type === 'html' || type === 'svg' || type === 'csv' || (type === 'ipynb' && Boolean(notebook));
  const modeToggle = hasRichPreview ? (
    <div className="mb-2 flex items-center justify-end">
      <div
        className="inline-flex rounded-md border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 p-0.5 text-xs"
        role="group"
        aria-label={t('chatArtifacts.viewMode', 'Preview mode')}
      >
        <button
          type="button"
          onClick={() => setViewMode('preview')}
          className={`rounded px-2.5 py-1 font-medium transition-colors ${
            viewMode === 'preview'
              ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-xs'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          {t('chatArtifacts.previewTab', 'Preview')}
        </button>
        <button
          type="button"
          onClick={() => setViewMode('code')}
          className={`rounded px-2.5 py-1 font-medium transition-colors ${
            viewMode === 'code'
              ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-xs'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          {t('chatArtifacts.codeTab', 'Code')}
        </button>
      </div>
    </div>
  ) : null;

  if (hasRichPreview && viewMode === 'preview') {
    if (type === 'html') {
      return (
        <>
          {truncatedNote}
          {modeToggle}
          <iframe
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={withPreviewCsp(state.text)}
            title={name}
            className="w-full h-[65vh] rounded-md border border-gray-200 dark:border-gray-700 bg-white"
          />
        </>
      );
    }
    if (type === 'svg') {
      return (
        <>
          {truncatedNote}
          {modeToggle}
          <div
            className="flex items-center justify-center p-4 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-auto max-h-[60vh]"
            dangerouslySetInnerHTML={{ __html: sanitizeMermaidSvg(state.text) }}
          />
        </>
      );
    }
    if (type === 'csv') {
      const { header, rows, totalRows } = parseCsvPreview(state.text);
      return (
        <>
          {truncatedNote}
          {modeToggle}
          <div className="overflow-auto max-h-[60vh] rounded-md border border-gray-200 dark:border-gray-700">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-xs">
              {header.length > 0 && (
                <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0">
                  <tr>
                    {header.map((col, idx) => (
                      <th
                        key={idx}
                        scope="col"
                        className="px-3 py-2 text-left font-semibold text-gray-700 dark:text-gray-200 whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
                {rows.map((row, rIdx) => (
                  <tr
                    key={rIdx}
                    className={rIdx % 2 === 1 ? 'bg-gray-50/60 dark:bg-gray-800/40' : undefined}
                  >
                    {header.map((_, cIdx) => (
                      <td
                        key={cIdx}
                        className="px-3 py-1.5 text-gray-800 dark:text-gray-200 whitespace-nowrap"
                      >
                        {row[cIdx] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalRows > rows.length && (
            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
              {t('chatArtifacts.csvRowsShown', 'Showing {{shown}} of {{total}} rows.', {
                shown: rows.length,
                total: totalRows
              })}
            </p>
          )}
        </>
      );
    }
    if (type === 'ipynb' && notebook) {
      let codeIndex = 0;
      return (
        <>
          {truncatedNote}
          {modeToggle}
          <div className="space-y-3 overflow-auto max-h-[65vh] pr-1">
            {notebook.cells.map(cell => {
              if (cell.type === 'markdown') {
                return (
                  <article
                    key={cell.id}
                    className="prose prose-sm dark:prose-invert max-w-none rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(cell.source) }}
                  />
                );
              }
              codeIndex += 1;
              const badge = cell.executionCount ?? codeIndex;
              const cellHtml = DOMPurify.sanitize(highlightCode(cell.source, notebook.language));
              return (
                <div
                  key={cell.id}
                  className="rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden bg-gray-900"
                >
                  <div className="px-3 py-1 bg-gray-800 text-[11px] font-mono text-gray-400 border-b border-gray-700">
                    {`In [${badge}]:`}
                  </div>
                  <pre className="p-3 overflow-auto text-xs leading-relaxed text-gray-100">
                    <code
                      className={`hljs language-${notebook.language}`}
                      dangerouslySetInnerHTML={{ __html: cellHtml }}
                    />
                  </pre>
                </div>
              );
            })}
          </div>
        </>
      );
    }
  }

  const isJsonLike = type === 'json' || type === 'ipynb';
  const code = isJsonLike && !state.truncated ? prettyJson(state.text) : state.text;
  const language = isJsonLike ? 'json' : codeLanguageOf(artifact.name);
  const html = DOMPurify.sanitize(highlightCode(code, language));
  return (
    <>
      {truncatedNote}
      {modeToggle}
      <pre
        // Focusable so the scrollable code can be read with the keyboard.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label={t('chatArtifacts.codeOf', 'Content of {{name}}', { name })}
        className="bg-gray-900 text-gray-100 rounded-md p-4 overflow-auto text-xs leading-relaxed max-h-[60vh] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <code
          className={language ? `hljs language-${language}` : undefined}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </>
  );
}
