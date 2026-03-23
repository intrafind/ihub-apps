import { useLayoutEffect, useState, useRef, useEffect, useCallback } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { configureMarked } from '../../../shared/components/MarkdownRenderer';
import {
  transformCitations,
  attachCitationHandlers,
  scrollToCitation
} from '../../../utils/citationTransformer';
import './StreamingMarkdown.css';

/**
 * A component that renders markdown content with optimized real-time updates.
 * Content is rendered via marked with raw HTML allowed (sanitize: false in marked config).
 * Citation tags are transformed to interactive badges post-render.
 *
 * @param {Object} props
 * @param {string} props.content - Markdown content to render
 * @param {boolean} [props.hasCitations] - Whether content may contain cite tags
 */
function StreamingMarkdown({ content, hasCitations }) {
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
        configureMarked();
        let parsedContent = marked(content);

        // Transform citation tags into interactive badges
        if (hasCitations) {
          parsedContent = transformCitations(parsedContent);
          citationsAppliedRef.current = true;
        }

        setHtmlContent(DOMPurify.sanitize(parsedContent));
        contentLengthRef.current = content.length;

        // Force a complete re-render by updating the key
        setRenderKey(prevKey => prevKey + 1);
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
      key={renderKey}
      ref={containerRef}
      className="markdown-content break-words whitespace-normal streaming-markdown"
      dangerouslySetInnerHTML={{ __html: htmlContent }} // sanitized with DOMPurify before setState
    />
  );
}

export default StreamingMarkdown;
