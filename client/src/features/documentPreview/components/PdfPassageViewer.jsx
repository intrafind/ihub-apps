import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { loadPdfjs } from '../../upload/utils/fileProcessing';
import {
  buildPageIndex,
  computePassageMatches,
  emptyPageIndex,
  flattenMatches,
  matchToItemSlices
} from '../utils/pdfPassageMatching';
import './PdfPassageViewer.css';

// Pages this far outside the viewport are pre-rendered so scrolling stays
// smooth without keeping a canvas for every page of a large document alive.
const RENDER_MARGIN_PX = 800;

/**
 * Renders a single page: canvas, pdf.js text layer and the highlight overlay.
 *
 * Highlights are painted as absolutely positioned boxes derived from DOM ranges
 * over the text layer spans, so they follow the real glyph geometry instead of
 * approximating it — and the text layer itself stays untouched and selectable.
 */
function PdfPage({ page, scale, matches, selectedMatchIdx, onHighlightsPainted, TextLayer }) {
  const wrapperRef = useRef(null);
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  // The rendered TextLayer instance. Its `textDivs` are index-aligned with
  // `textContentItemsStr`, which a DOM query is not: pdf.js appends a `<br>`
  // instead of a span for items with an empty string, so querying the container
  // for spans silently shifts every index after the first empty item.
  const textLayerObjRef = useRef(null);
  const [highlights, setHighlights] = useState([]);
  const [textLayerReady, setTextLayerReady] = useState(false);

  const viewport = useMemo(() => page.pdfPage.getViewport({ scale }), [page.pdfPage, scale]);

  // Render canvas + text layer. Both are re-done on scale changes because the
  // text layer positions its spans in device pixels for a fixed scale.
  useEffect(() => {
    let cancelled = false;
    let renderTask = null;
    let textLayer = null;

    const canvas = canvasRef.current;
    const textLayerDiv = textLayerRef.current;
    if (!canvas || !textLayerDiv) return undefined;

    setTextLayerReady(false);

    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const context = canvas.getContext('2d');
    renderTask = page.pdfPage.render({
      canvasContext: context,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
    });

    textLayerDiv.replaceChildren();
    textLayer = new TextLayer({
      textContentSource: page.textContent,
      container: textLayerDiv,
      viewport
    });
    textLayerObjRef.current = textLayer;

    Promise.all([
      renderTask.promise.catch(err => {
        // Cancelled renders are expected while scrolling/zooming.
        if (err?.name !== 'RenderingCancelledException') throw err;
      }),
      textLayer.render()
    ])
      .then(() => {
        if (!cancelled) setTextLayerReady(true);
      })
      .catch(() => {
        /* leave the page blank; a failed page must not break the viewer */
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [page, viewport, TextLayer]);

  // Derive highlight boxes from the rendered text layer.
  useEffect(() => {
    if (!textLayerReady || matches.length === 0) {
      setHighlights([]);
      return;
    }
    const textLayer = textLayerObjRef.current;
    const wrapper = wrapperRef.current;
    if (!textLayer || !wrapper) return;

    // Both come from the text layer itself, so match offsets, item strings and
    // rendered elements are guaranteed to line up.
    const textDivs = textLayer.textDivs;
    const itemStrings = textLayer.textContentItemsStr;
    const wrapperRect = wrapper.getBoundingClientRect();
    const boxes = [];

    matches.forEach(match => {
      for (const slice of matchToItemSlices(itemStrings, match.start, match.length)) {
        // Empty items render as a `<br>`, so their span has no text node and is
        // skipped here — they carry no characters and never hold a match.
        const textNode = textDivs[slice.itemIdx]?.firstChild;
        if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
        const range = document.createRange();
        try {
          range.setStart(textNode, Math.min(slice.start, textNode.length));
          range.setEnd(textNode, Math.min(slice.end, textNode.length));
        } catch {
          continue;
        }
        for (const rect of range.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          boxes.push({
            key: `${match.matchIdx}-${slice.itemIdx}-${boxes.length}`,
            matchIdx: match.matchIdx,
            left: rect.left - wrapperRect.left,
            top: rect.top - wrapperRect.top,
            width: rect.width,
            height: rect.height
          });
        }
        range.detach?.();
      }
    });

    setHighlights(boxes);
    onHighlightsPainted?.(page.pageIdx);
  }, [textLayerReady, matches, page, onHighlightsPainted]);

  return (
    <div
      ref={wrapperRef}
      className="ihub-pdf-page"
      data-page-number={page.pageIdx + 1}
      style={{
        width: `${Math.floor(viewport.width)}px`,
        height: `${Math.floor(viewport.height)}px`,
        // pdf.js's TextLayer sizes its container with calc(var(--scale-factor) * …)
        '--scale-factor': scale
      }}
    >
      <canvas ref={canvasRef} />
      <div className="ihub-pdf-highlight-layer">
        {highlights.map(box => (
          <div
            key={box.key}
            data-match-index={box.matchIdx}
            className={`ihub-pdf-highlight${
              box.matchIdx === selectedMatchIdx ? ' ihub-pdf-highlight--selected' : ''
            }`}
            style={{
              left: `${box.left}px`,
              top: `${box.top}px`,
              width: `${box.width}px`,
              height: `${box.height}px`
            }}
          />
        ))}
      </div>
      <div ref={textLayerRef} className="ihub-pdf-text-layer" />
    </div>
  );
}

/**
 * A page slot that only mounts the real {@link PdfPage} while it is near the
 * viewport. Unrendered slots keep the page's layout height so scroll offsets
 * (and therefore "jump to page N") stay correct for the whole document.
 */
function PdfPageSlot({ page, scale, scrollRoot, ...pageProps }) {
  const slotRef = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = slotRef.current;
    if (!node || !scrollRoot) return undefined;
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { root: scrollRoot, rootMargin: `${RENDER_MARGIN_PX}px 0px` }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollRoot]);

  const height = Math.floor(page.height * scale);
  const width = Math.floor(page.width * scale);

  return (
    <div ref={slotRef} style={{ minHeight: `${height}px` }} data-page-slot={page.pageIdx + 1}>
      {visible ? (
        <PdfPage page={page} scale={scale} {...pageProps} />
      ) : (
        <div
          className="ihub-pdf-page"
          data-page-number={page.pageIdx + 1}
          style={{ width: `${width}px`, height: `${height}px` }}
        />
      )}
    </div>
  );
}

/**
 * PDF viewer that highlights backend-supplied passages and can jump between
 * them.
 *
 * Text for *every* page is extracted up front — passages routinely straddle a
 * page break, so the matcher needs the whole document's shadow text before it
 * can resolve anything. Canvas rendering stays lazy.
 *
 * @param {Object} props
 * @param {ArrayBuffer} props.data raw PDF bytes.
 * @param {string[]} props.passages passage texts to highlight.
 * @param {number} [props.scale] render scale.
 * @param {Function} [props.onStateChange] called with
 *   `{ loading, numPages, totalMatches, currentMatch, error }`.
 * @param {Object} [props.controlRef] receives `{ nextMatch, previousMatch, goToPage }`.
 */
function PdfPassageViewer({ data, passages, scale = 1.2, onStateChange, controlRef }) {
  const scrollRef = useRef(null);
  const [pages, setPages] = useState([]);
  // Taken from the lazily imported pdf.js rather than a static import: the
  // `pdf` bundle chunk is deliberately on-demand (see vite.config.js), and a
  // static import would pull it into the chat bundle for every user.
  const [textLayerCtor, setTextLayerCtor] = useState(null);
  const [matchResult, setMatchResult] = useState(null);
  const [currentMatch, setCurrentMatch] = useState(-1);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const pendingScrollRef = useRef(null);
  const pendingInitialJumpRef = useRef(false);

  // Load the document and extract all page text.
  useEffect(() => {
    let cancelled = false;
    let pdfDocument = null;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const pdfjsLib = await loadPdfjs();
        if (cancelled) return;
        setTextLayerCtor(() => pdfjsLib.TextLayer);
        // pdf.js transfers (and thereby neuters) the buffer it is given; hand
        // it a copy so the caller can re-open the same bytes later.
        pdfDocument = await pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
        if (cancelled) return;

        const collected = [];
        for (let i = 0; i < pdfDocument.numPages; i += 1) {
          const pdfPage = await pdfDocument.getPage(i + 1);
          if (cancelled) return;
          let textContent;
          try {
            textContent = await pdfPage.getTextContent();
          } catch {
            textContent = { items: [], styles: {} };
          }
          if (cancelled) return;
          const unscaled = pdfPage.getViewport({ scale: 1 });
          collected.push({
            pageIdx: i,
            pdfPage,
            textContent,
            index: textContent.items.length ? buildPageIndex(textContent) : emptyPageIndex(),
            width: unscaled.width,
            height: unscaled.height
          });
        }
        if (cancelled) return;
        setPages(collected);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || 'Failed to load PDF');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      pdfDocument?.destroy?.();
    };
  }, [data]);

  // Match the passages once the document text is available.
  useEffect(() => {
    if (pages.length === 0) {
      setMatchResult(null);
      return;
    }
    const texts = (passages || []).filter(p => typeof p === 'string' && p.trim().length > 0);
    if (texts.length === 0) {
      setMatchResult({
        pageMatches: pages.map(() => []),
        total: 0,
        firstMatchPageIdx: -1,
        flat: []
      });
      setCurrentMatch(-1);
      pendingInitialJumpRef.current = false;
      return;
    }
    const result = computePassageMatches(
      texts,
      pages.map(p => p.index)
    );
    setMatchResult({ ...result, flat: flattenMatches(result) });
    setCurrentMatch(result.total > 0 ? 0 : -1);
    pendingInitialJumpRef.current = result.total > 0;
  }, [pages, passages]);

  // Memoized so the identity is stable across renders — the effects and
  // callbacks below key on it.
  const flatMatches = useMemo(() => matchResult?.flat || [], [matchResult]);

  // Per-page match lists, tagged with their index in the flat (document-order)
  // list so a highlight can tell whether it is the selected one.
  const matchesByPage = useMemo(() => {
    const byPage = pages.map(() => []);
    flatMatches.forEach((match, flatIdx) => {
      byPage[match.pageIdx]?.push({ ...match, matchIdx: flatIdx });
    });
    return byPage;
  }, [pages, flatMatches]);

  const scrollToPage = useCallback(pageIdx => {
    const root = scrollRef.current;
    const slot = root?.querySelector(`[data-page-slot="${pageIdx + 1}"]`);
    if (root && slot) {
      root.scrollTop = slot.offsetTop - root.offsetTop - 16;
    }
  }, []);

  const scrollToMatch = useCallback(
    flatIdx => {
      const match = flatMatches[flatIdx];
      if (!match) return;
      const root = scrollRef.current;
      const highlight = root?.querySelector(
        `[data-page-number="${match.pageIdx + 1}"] [data-match-index="${flatIdx}"]`
      );
      if (highlight) {
        highlight.scrollIntoView({ block: 'center', behavior: 'smooth' });
        pendingScrollRef.current = null;
      } else {
        // The page is not rendered yet — scroll it into view and finish once
        // its highlights have been painted.
        pendingScrollRef.current = flatIdx;
        scrollToPage(match.pageIdx);
      }
    },
    [flatMatches, scrollToPage]
  );

  const handleHighlightsPainted = useCallback(
    pageIdx => {
      const pending = pendingScrollRef.current;
      if (pending === null || pending === undefined) return;
      if (flatMatches[pending]?.pageIdx !== pageIdx) return;
      pendingScrollRef.current = null;
      requestAnimationFrame(() => scrollToMatch(pending));
    },
    [flatMatches, scrollToMatch]
  );

  // Jump to the first match once a freshly computed match set has been
  // committed. The ref keeps this to the initial jump — later navigation
  // scrolls explicitly via goToMatch.
  useEffect(() => {
    if (!pendingInitialJumpRef.current || flatMatches.length === 0) return;
    pendingInitialJumpRef.current = false;
    scrollToMatch(0);
  }, [flatMatches, scrollToMatch]);

  const goToMatch = useCallback(
    next => {
      if (flatMatches.length === 0) return;
      setCurrentMatch(prev => {
        const target = (prev + (next ? 1 : -1) + flatMatches.length) % flatMatches.length;
        scrollToMatch(target);
        return target;
      });
    },
    [flatMatches, scrollToMatch]
  );

  useImperativeHandle(
    controlRef,
    () => ({
      nextMatch: () => goToMatch(true),
      previousMatch: () => goToMatch(false),
      goToPage: scrollToPage
    }),
    [goToMatch, scrollToPage]
  );

  useEffect(() => {
    onStateChange?.({
      loading,
      error,
      numPages: pages.length,
      totalMatches: flatMatches.length,
      currentMatch
    });
  }, [loading, error, pages.length, flatMatches.length, currentMatch, onStateChange]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto bg-gray-100 dark:bg-gray-900 p-4">
      {error && <p className="text-sm text-red-600 dark:text-red-400 text-center py-8">{error}</p>}
      {!error &&
        textLayerCtor &&
        pages.map(page => (
          <PdfPageSlot
            key={page.pageIdx}
            page={page}
            scale={scale}
            scrollRoot={scrollRef.current}
            matches={matchesByPage[page.pageIdx] || []}
            selectedMatchIdx={currentMatch}
            onHighlightsPainted={handleHighlightsPainted}
            TextLayer={textLayerCtor}
          />
        ))}
    </div>
  );
}

export default PdfPassageViewer;
