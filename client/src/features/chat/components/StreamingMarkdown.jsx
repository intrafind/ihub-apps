import { useLayoutEffect, useState, useRef, useEffect, useCallback } from 'react';
import { renderMarkdown } from '../../../config/marked.config';
import {
  transformCitations,
  attachCitationHandlers,
  scrollToCitation
} from '../../../utils/citationTransformer';
import './StreamingMarkdown.css';

/**
 * A component that renders markdown content with optimized real-time updates.
 * Content is rendered via the shared markdown renderer with centralized sanitization.
 * Citation tags are transformed to interactive badges post-render.
 *
 * @param {Object} props
 * @param {string} props.content - Markdown content to render
 * @param {boolean} [props.hasCitations] - Whether content may contain cite tags
 * @param {Object} [props.citations] - Message citations ({ references: [], resultItems: [] }),
 *   used to give each citation badge a short excerpt for its hover/focus preview.
 * @param {boolean} [props.streaming] - Whether the message is actively streaming.
 *   While true the container is GPU-promoted (will-change/translateZ) for smooth
 *   incremental updates; once streaming ends the promotion is dropped so finished
 *   messages don't each hold a permanent compositor layer.
 */
function StreamingMarkdown({ content, hasCitations, citations, streaming = false }) {
  const containerRef = useRef(null);
  const [htmlContent, setHtmlContent] = useState('');
  const [renderKey, setRenderKey] = useState(0);
  const contentLengthRef = useRef(0);
  const citationsAppliedRef = useRef(false);

  const handleCitationClick = useCallback((type, num) => {
    scrollToCitation(type, num);
  }, []);

  // Use useLayoutEffect instead of useEffect to apply DOM changes synchronously
  // before the browser has a chance to paint
  useLayoutEffect(() => {
    if (!content) {
      setHtmlContent('');
      citationsAppliedRef.current = false;
      return;
    }

    // Re-parse when content changes or when citations become available but weren't applied yet
    const contentChanged = content.length !== contentLengthRef.current;
    const needsCitationTransform = hasCitations && !citationsAppliedRef.current;

    if (contentChanged || needsCitationTransform) {
      try {
        const transformHtml = hasCitations
          ? html => transformCitations(html, citations)
          : undefined;
        const parsedContent = renderMarkdown(content, {
          transformHtml
        });
        if (transformHtml) {
          citationsAppliedRef.current = true;
        }
        setHtmlContent(parsedContent);
        contentLengthRef.current = content.length;

        // Force a complete re-render by updating the key
        setRenderKey(prevKey => prevKey + 1);
      } catch (error) {
        console.error('Error parsing markdown:', error);
      }
    }
  }, [content, hasCitations, citations]);

  // Attach citation click handlers after DOM update
  useEffect(() => {
    if (hasCitations && containerRef.current) {
      attachCitationHandlers(containerRef.current, handleCitationClick);
    }
  }, [htmlContent, hasCitations, handleCitationClick]);

  return (
    <div
      key={renderKey}
      ref={containerRef}
      className={`markdown-content break-words whitespace-normal streaming-markdown${
        streaming ? ' is-streaming' : ''
      }`}
      dangerouslySetInnerHTML={{ __html: htmlContent }} // sanitized with DOMPurify before setState
    />
  );
}

export default StreamingMarkdown;
