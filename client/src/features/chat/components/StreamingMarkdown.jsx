import { memo, useLayoutEffect, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { renderMarkdown } from '../../../config/marked.config';
import {
  transformCitations,
  attachCitationHandlers,
  scrollToCitation
} from '../../../utils/citationTransformer';
import {
  applyCitationHighlight,
  transformWebCitations
} from '../../../utils/webCitationTransformer';
import {
  currentCitationHighlight,
  highlightCitation,
  openWebSources,
  releaseCitation,
  subscribeWebSources
} from '../webSourcesStore';
import './StreamingMarkdown.css';

/**
 * A component that renders markdown content with optimized real-time updates.
 * Content is rendered via the shared markdown renderer with centralized sanitization.
 * Citation tags are transformed to interactive badges post-render.
 *
 * @param {Object} props
 * @param {string} props.content - Markdown content to render
 * @param {boolean} [props.hasCitations] - Whether content may contain cite tags
 * @param {{messageKey: string, numbers: Map<string, number>, byNumber: Map<number, Object>}} [props.webCitations] -
 *   The answer's web citations (`shared/webCitations.resolveCitations`): links to
 *   cited sources render as numbered badges. Hovering or focusing a badge
 *   highlights its passage and source card; a click or tap opens the sources
 *   view on that card and pins the highlight.
 * @param {boolean} [props.streaming] - Whether the message is actively streaming.
 *   While true the container is GPU-promoted (will-change/translateZ) for smooth
 *   incremental updates; once streaming ends the promotion is dropped so finished
 *   messages don't each hold a permanent compositor layer.
 *
 * Exported wrapped in `memo`: the component owns its DOM through
 * `dangerouslySetInnerHTML`, and React re-applies that prop whenever the object
 * it is given is not reference-identical to the previous one — it never compares
 * the HTML string. A parent re-render for an unrelated reason (hovering a chat
 * message toggles its action row, for example) would therefore wipe and rebuild
 * the whole markdown subtree, throwing away every rendered Mermaid diagram in it.
 */
function StreamingMarkdown({ content, hasCitations, webCitations = null, streaming = false }) {
  const containerRef = useRef(null);
  const [htmlContent, setHtmlContent] = useState('');
  const lastParsedContentRef = useRef(null);
  const citationsAppliedRef = useRef(false);
  const lastWebCitationsRef = useRef(null);

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

    // Re-parse when content changes, when citations become available but weren't
    // applied yet, or when the web citations (their numbering) changed
    const contentChanged = content !== lastParsedContentRef.current;
    const needsCitationTransform = hasCitations && !citationsAppliedRef.current;
    const webCitationsChanged = webCitations !== lastWebCitationsRef.current;

    if (contentChanged || needsCitationTransform || webCitationsChanged) {
      try {
        const transforms = [
          hasCitations ? transformCitations : null,
          webCitations?.numbers?.size ? html => transformWebCitations(html, webCitations) : null
        ].filter(Boolean);
        const transformHtml = transforms.length
          ? html => transforms.reduce((out, transform) => transform(out), html)
          : undefined;
        const parsedContent = renderMarkdown(content, {
          transformHtml
        });
        lastWebCitationsRef.current = webCitations;
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
  }, [content, hasCitations, webCitations]);

  // Attach citation click handlers after DOM update
  useEffect(() => {
    if (hasCitations && containerRef.current) {
      attachCitationHandlers(containerRef.current, handleCitationClick);
    }
  }, [htmlContent, hasCitations, handleCitationClick]);

  // Web citation badges: hover and focus highlight, click and tap open the
  // sources view. Delegated on the container, whose children are replaced
  // whenever the markup changes.
  const messageKey = webCitations?.messageKey || null;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !messageKey) return undefined;
    const badgeOf = event => event.target?.closest?.('[data-web-citation]');
    const numberOf = badge => Number(badge.getAttribute('data-web-citation'));
    const onEnter = event => {
      const badge = badgeOf(event);
      if (badge) highlightCitation(messageKey, numberOf(badge));
    };
    const onLeave = event => {
      const badge = badgeOf(event);
      if (!badge || badge.contains(event.relatedTarget)) return;
      releaseCitation(messageKey, numberOf(badge));
    };
    const onClick = event => {
      const badge = badgeOf(event);
      if (!badge) return;
      // A modified or middle click opens the page itself, like any link.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) {
        return;
      }
      event.preventDefault();
      const n = numberOf(badge);
      highlightCitation(messageKey, n, { pinned: true });
      openWebSources(messageKey, n);
    };
    container.addEventListener('mouseover', onEnter);
    container.addEventListener('mouseout', onLeave);
    container.addEventListener('focusin', onEnter);
    container.addEventListener('focusout', onLeave);
    container.addEventListener('click', onClick);
    return () => {
      container.removeEventListener('mouseover', onEnter);
      container.removeEventListener('mouseout', onLeave);
      container.removeEventListener('focusin', onEnter);
      container.removeEventListener('focusout', onLeave);
      container.removeEventListener('click', onClick);
    };
  }, [messageKey]);

  // Keep the highlighted citation's badges and passages marked, also across
  // re-renders of the markup.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !messageKey) return undefined;
    const apply = () => {
      const highlight = currentCitationHighlight();
      applyCitationHighlight(container, highlight?.messageKey === messageKey ? highlight.n : null);
    };
    apply();
    return subscribeWebSources(apply);
  }, [htmlContent, messageKey]);

  // Reference-stable as long as the markup is unchanged. React compares the
  // `dangerouslySetInnerHTML` prop by object identity, so a fresh literal on
  // every render would re-assign `innerHTML` — destroying and recreating every
  // child node — even when the HTML is byte-identical.
  const innerHtml = useMemo(() => ({ __html: htmlContent }), [htmlContent]);

  return (
    <div
      ref={containerRef}
      className={`markdown-content wrap-break-word whitespace-normal streaming-markdown${
        streaming ? ' is-streaming' : ''
      }`}
      dangerouslySetInnerHTML={innerHtml} // sanitized with DOMPurify before setState
    />
  );
}

export default memo(StreamingMarkdown);
