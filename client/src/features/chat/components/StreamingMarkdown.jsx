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
 * @param {boolean} [props.streaming] - Whether the message is actively streaming.
 *   While true the container is GPU-promoted (will-change/translateZ) for smooth
 *   incremental updates; once streaming ends the promotion is dropped so finished
 *   messages don't each hold a permanent compositor layer.
 */
function StreamingMarkdown({ content, hasCitations, streaming = false }) {
  const containerRef = useRef(null);
  const [htmlContent, setHtmlContent] = useState('');
  const lastParsedContentRef = useRef(null);
  const citationsAppliedRef = useRef(false);

  const handleCitationClick = useCallback((type, num) => {
    scrollToCitation(type, num);
  }, []);

  // Use useLayoutEffect instead of useEffect to apply DOM changes synchronously
  // before the browser has a chance to paint
  useLayoutEffect(() => {
    if (!content) {
      setHtmlContent('');
      lastParsedContentRef.current = null;
      citationsAppliedRef.current = false;
      return;
    }

    // Re-parse when content changes or when citations become available but weren't applied yet
    const contentChanged = content !== lastParsedContentRef.current;
    const needsCitationTransform = hasCitations && !citationsAppliedRef.current;

    if (contentChanged || needsCitationTransform) {
      try {
        const transformHtml = hasCitations ? transformCitations : undefined;
        const parsedContent = renderMarkdown(content, {
          transformHtml
        });
        if (transformHtml) {
          citationsAppliedRef.current = true;
        }
        // Only push new HTML when it actually differs. Re-assigning identical
        // markup would tear down and recreate every child node, which throws
        // away already-rendered Mermaid diagrams.
        setHtmlContent(prev => (prev === parsedContent ? prev : parsedContent));
        lastParsedContentRef.current = content;
      } catch (error) {
        console.error('Error parsing markdown:', error);
      }
    }
  }, [content, hasCitations]);

  // Attach citation click handlers after DOM update
  useEffect(() => {
    if (hasCitations && containerRef.current) {
      attachCitationHandlers(containerRef.current, handleCitationClick);
    }
  }, [htmlContent, hasCitations, handleCitationClick]);

  return (
    <div
      ref={containerRef}
      className={`markdown-content break-words whitespace-normal streaming-markdown${
        streaming ? ' is-streaming' : ''
      }`}
      dangerouslySetInnerHTML={{ __html: htmlContent }} // sanitized with DOMPurify before setState
    />
  );
}

export default StreamingMarkdown;
