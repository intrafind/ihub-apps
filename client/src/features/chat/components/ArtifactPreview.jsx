// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { highlightCode, renderMarkdown } from '../../../config/marked.config';
import {
  MAX_PREVIEW_BYTES,
  artifactDisplayName,
  codeLanguageOf,
  formatBytes,
  previewTypeOf
} from '../utils/artifactFiles';

/**
 * Read what a preview shows of a blob: an object URL for a picture, the text
 * (cut at {@link MAX_PREVIEW_BYTES}) for everything readable.
 */
async function loadPreview(type, blob) {
  if (type === 'image') return { url: URL.createObjectURL(blob) };
  const truncated = blob.size > MAX_PREVIEW_BYTES;
  const text = await (truncated ? blob.slice(0, MAX_PREVIEW_BYTES) : blob).text();
  return { text, truncated };
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

  useEffect(() => {
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

  const code = type === 'json' && !state.truncated ? prettyJson(state.text) : state.text;
  const language = type === 'json' ? 'json' : codeLanguageOf(artifact.name);
  const html = DOMPurify.sanitize(highlightCode(code, language));
  return (
    <>
      {truncatedNote}
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
