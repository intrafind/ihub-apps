import React, { useLayoutEffect, useState, useRef } from 'react';
import { marked } from 'marked';
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
  const parserRef = useRef(null);

  // Configure marked renderer once
  useLayoutEffect(() => {
    if (!parserRef.current) {
      // Create a custom renderer to add copy buttons to code blocks
      const renderer = new marked.Renderer();
      
      // Store the original code renderer
      const originalCodeRenderer = renderer.code;
      
      // Override the code method to add copy buttons
      renderer.code = function(code, language, isEscaped) {
        // Generate a unique ID for this code block
        const codeBlockId = `code-block-${Math.random().toString(36).substring(2, 15)}`;
        
        // Get the original HTML from the default renderer
        const originalHtml = originalCodeRenderer.call(this, code, language, isEscaped);
        
        // Add the dark theme classes to the code block
        const enhancedHtml = originalHtml.replace(
          '<pre>',
          '<pre class="bg-gray-800 text-gray-100 rounded-md p-4">'
        );
        
        // Wrap it with a container that includes a copy button
        return `
          <div class="code-block-container relative group">
            ${enhancedHtml}
            <button 
              class="code-copy-btn absolute top-2 right-2 p-1 rounded text-xs bg-gray-700 text-white opacity-0 group-hover:opacity-100 transition-opacity duration-200"
              data-code-id="${codeBlockId}"
              data-code-content="${encodeURIComponent(code)}"
              type="button"
              aria-label="Copy code"
            >
              <span class="icon-copy-code"></span>
            </button>
          </div>
        `;
      };

      marked.setOptions({
        gfm: true,            // Enable GitHub Flavored Markdown
        breaks: true,         // Add <br> on single line breaks
        headerIds: true,      // Generate IDs for headings
        mangle: false,        // Don't escape autolinked email addresses
        pedantic: false,      // Conform to markdown.pl (compatibility)
        sanitize: false,      // Don't sanitize HTML
        smartLists: true,     // Use smart ordered lists
        smartypants: false,   // Use smart quotes, etc.
        xhtml: false,         // Don't close all tags
        highlight: function(code, lang) {
          // Re-add syntax highlighting
          if (lang && window.hljs && window.hljs.getLanguage(lang)) {
            try {
              return window.hljs.highlight(code, { language: lang }).value;
            } catch (e) {
              console.error("Highlighting error:", e);
            }
          }
          return code; // Use default highlighting
        },
        renderer: renderer    // Use our custom renderer
      });
      
      parserRef.current = true;
    }
  }, []);

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

  // Add event listeners for code copying
  useLayoutEffect(() => {
    const handleCodeCopyClick = (e) => {
      // Check if the click was on a copy button or its child elements
      const button = e.target.closest('.code-copy-btn');
      if (!button) return;
      
      // Get the code content from the data attribute
      const codeContent = decodeURIComponent(button.dataset.codeContent);
      const codeId = button.dataset.codeId;
      
      // Copy to clipboard
      navigator.clipboard.writeText(codeContent)
        .then(() => {
          button.classList.add('bg-green-600');
          button.classList.remove('bg-gray-700');
          
          setTimeout(() => {
            button.classList.add('bg-gray-700');
            button.classList.remove('bg-green-600');
          }, 2000);
        })
        .catch(err => {
          console.error('Failed to copy code block: ', err);
        });
    };
    
    // Add the event listener to the document to catch all code copy buttons
    document.addEventListener('click', handleCodeCopyClick);
    
    // Clean up
    return () => {
      document.removeEventListener('click', handleCodeCopyClick);
    };
  }, []);

  return (
    <div 
      key={renderKey}
      ref={containerRef}
      className="markdown-content break-words whitespace-normal streaming-markdown"
      dangerouslySetInnerHTML={{ __html: htmlContent }}
    />
  );
};

export default StreamingMarkdown;