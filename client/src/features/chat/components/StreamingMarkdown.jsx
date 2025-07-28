import { useLayoutEffect, useState, useRef } from 'react';
import { marked } from 'marked';
import MarkdownRenderer, { configureMarked } from '../../../shared/components/MarkdownRenderer';
import './StreamingMarkdown.css';

/**
 * A component that renders markdown content with optimized real-time updates
 * This component specifically addresses the issue where markdown syntax is visible
 * during streaming and only rendered after the entire message is received.
 */
const StreamingMarkdown = ({ content }) => {
  const containerRef = useRef(null);
  const [htmlContent, setHtmlContent] = useState('');
  const [renderKey, setRenderKey] = useState(0);
  const contentLengthRef = useRef(0);

  // Use useLayoutEffect instead of useEffect to apply DOM changes synchronously
  // before the browser has a chance to paint
  useLayoutEffect(() => {
    if (!content) {
      setHtmlContent('');
      return;
    }

    // Only re-render if content has changed in a meaningful way
    if (content.length !== contentLengthRef.current) {
      try {
        configureMarked();
        const parsedContent = marked(content);
        setHtmlContent(parsedContent);
        contentLengthRef.current = content.length;

        // Force a complete re-render by updating the key
        setRenderKey(prevKey => prevKey + 1);
      } catch (error) {
        console.error('Error parsing markdown:', error);
      }
    }
  }, [content]);

  return (
    <>
      <MarkdownRenderer />
      <div
        key={renderKey}
        ref={containerRef}
        className="markdown-content break-words whitespace-normal streaming-markdown"
        dangerouslySetInnerHTML={{ __html: htmlContent }}
      />
    </>
  );
};

export default StreamingMarkdown;
