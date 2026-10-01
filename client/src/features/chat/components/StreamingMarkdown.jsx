import { memo, useLayoutEffect, useState, useRef, useEffect, useMemo } from 'react';
import { renderMarkdown } from '../../../config/marked.config';
import {
  applyCitationHighlight,
  transformSourceCitations
} from '../../../utils/sourceCitationTransformer';
import {
  currentCitationHighlight,
  highlightCitation,
  openSources,
  releaseCitation,
  subscribeSources
} from '../sources/sourcesStore';
import './StreamingMarkdown.css';

/**
 * A component that renders markdown content with optimized real-time updates.
 * Content is rendered via the shared markdown renderer with centralized sanitization.
 * Citations are transformed to interactive badges post-render.
 *
 * @param {Object} props
 * @param {string} props.content - Markdown content to render
 * @param {{messageKey: string, numberOfUrl: Function, numberOfMarker: Function,
 *   byNumber: Map<number, Object>}} [props.citations] - The answer's citations
 *   (`shared/sources/citations.resolveCitations`): links to its sources and
 *   provider markers render as numbered badges. Hovering or focusing a badge
 *   highlights its passage and source card; a click or tap opens the sources
 *   panel on that card and pins the highlight.
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
function StreamingMarkdown({ content, citations = null, streaming = false }) {
  const containerRef = useRef(null);
  const [htmlContent, setHtmlContent] = useState('');
  const lastParsedContentRef = useRef(null);
  const lastCitationsRef = useRef(null);

  // Use useLayoutEffect instead of useEffect to apply DOM changes synchronously
  // before the browser has a chance to paint
  useLayoutEffect(() => {
    if (!content) {
      setHtmlContent('');
      lastParsedContentRef.current = null;
      return;
    }

    // Re-parse when the content or the citations (their numbering) changed.
    const contentChanged = content !== lastParsedContentRef.current;
    const citationsChanged = citations !== lastCitationsRef.current;

    if (contentChanged || citationsChanged) {
      try {
        const parsedContent = renderMarkdown(content, {
          transformHtml: citations?.byNumber?.size
            ? html => transformSourceCitations(html, citations)
            : undefined
        });
        lastCitationsRef.current = citations;
        // Only push new HTML when it actually differs. Re-assigning identical
        // markup would tear down and recreate every child node, which throws
        // away already-rendered Mermaid diagrams.
        setHtmlContent(prev => (prev === parsedContent ? prev : parsedContent));
        lastParsedContentRef.current = content;
      } catch (error) {
        console.error('Error parsing markdown:', error);
      }
    }
  }, [content, citations]);

  // Citation badges: hover and focus highlight, click and tap open the
  // sources panel. Delegated on the container, whose children are replaced
  // whenever the markup changes.
  const messageKey = citations?.messageKey || null;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !messageKey) return undefined;
    const badgeOf = event => event.target?.closest?.('[data-source-citation]');
    const numberOf = badge => Number(badge.getAttribute('data-source-citation'));
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
      openSources(messageKey, n);
    };
    // A badge without a link is a button: Enter and Space press it.
    const onKey = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const badge = badgeOf(event);
      if (!badge || badge.getAttribute('role') !== 'button') return;
      onClick(event);
    };
    container.addEventListener('mouseover', onEnter);
    container.addEventListener('mouseout', onLeave);
    container.addEventListener('focusin', onEnter);
    container.addEventListener('focusout', onLeave);
    container.addEventListener('click', onClick);
    container.addEventListener('keydown', onKey);
    return () => {
      container.removeEventListener('mouseover', onEnter);
      container.removeEventListener('mouseout', onLeave);
      container.removeEventListener('focusin', onEnter);
      container.removeEventListener('focusout', onLeave);
      container.removeEventListener('click', onClick);
      container.removeEventListener('keydown', onKey);
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
    return subscribeSources(apply);
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
