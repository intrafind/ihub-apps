import { useEffect } from 'react';
import { validateMermaidCode, processMermaidCode } from '../utils/markdownHelpers';
import svgPanZoom from 'svg-pan-zoom';

// A simple debounce utility
const debounce = (func, delay) => {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func.apply(null, args), delay);
  };
};

// Markdown containers that are still receiving streamed tokens. Diagrams
// inside them are intentionally left unrendered: their source is incomplete
// and would be thrown away by the next token anyway.
const STREAMING_CLASS = 'is-streaming';
const STREAMING_MARKDOWN_CLASS = 'streaming-markdown';
const STREAMING_SELECTOR = `.${STREAMING_CLASS}`;

// Rendered SVG cache keyed by the processed diagram source. Re-mounting a
// message (navigation, re-parse, layout change) then reuses the existing SVG
// instead of paying for a full Mermaid render, which is what made diagrams
// visibly flicker on every UI change.
const MAX_CACHED_DIAGRAMS = 100;
const svgCache = new Map();

const getCachedRender = key => {
  if (!svgCache.has(key)) return null;
  // Refresh recency so the LRU eviction below keeps hot diagrams.
  const entry = svgCache.get(key);
  svgCache.delete(key);
  svgCache.set(key, entry);
  return entry;
};

const setCachedRender = (key, entry) => {
  svgCache.set(key, entry);
  while (svgCache.size > MAX_CACHED_DIAGRAMS) {
    svgCache.delete(svgCache.keys().next().value);
  }
};

// Mermaid injects a temporary element keyed by the ID passed to render().
// Container IDs are content-derived and can legitimately repeat across
// messages, so renders always get their own throwaway ID.
let renderSequence = 0;
const nextRenderId = () => `mermaid-render-${++renderSequence}`;

// Mermaid derives every ID inside the generated markup (the root element, the
// scoped `<style>` selectors and the arrow markers) from the ID passed to
// render(). Re-pointing them at the owning container keeps IDs unique when the
// same cached SVG is reused for several identical diagrams on one page.
const rescopeSvgIds = (svg, renderId, containerId) =>
  renderId && containerId ? svg.split(renderId).join(`${containerId}-svg`) : svg;

// Releases the pan-zoom instance attached to a container, if any.
const destroyPanZoom = (container, registry) => {
  const instance = container?.panZoomInstance;
  if (!instance) return;
  registry?.delete(instance);
  try {
    instance.destroy();
  } catch (e) {
    console.warn('Error destroying pan-zoom instance:', e);
  }
  container.panZoomInstance = null;
};

// Helper to provide button feedback for Mermaid interactions
const showMermaidButtonFeedback = (btn, message, colorClass, iconType) => {
  const originalHTML = btn.innerHTML;
  const originalClass = btn.className;

  let icon;
  if (iconType === 'checkmark') {
    icon = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>`;
  } else if (iconType === 'error') {
    icon = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>`;
  }

  btn.innerHTML = `
    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      ${icon}
    </svg>
    <span class="hidden sm:inline">${message}</span>
  `;

  btn.className = btn.className.replace(/text-gray-600|text-red-600/, colorClass);

  setTimeout(() => {
    btn.innerHTML = originalHTML;
    btn.className = originalClass;
  }, 2000);
};

export const useMermaidRenderer = ({ t }) => {
  useEffect(() => {
    let mermaid;
    let mermaidReady = false;

    // Every live diagram's pan-zoom instance. A single delegated keydown
    // listener drives them all; previously each diagram registered its own
    // document listener that was never removed when its container was
    // replaced, so re-renders leaked handlers indefinitely.
    const panZoomInstances = new Set();

    // Pre-load Mermaid immediately when hook initializes
    const loadMermaid = async () => {
      if (!mermaid) {
        try {
          const mermaidModule = await import('mermaid');
          mermaid = mermaidModule.default;
          mermaid.initialize({
            startOnLoad: false,
            theme: 'default',
            securityLevel: 'loose', // Avoids sandboxed iframes, simplifying rendering & cleanup
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            // Disable useMaxWidth to allow diagrams to render at their natural size
            flowchart: { useMaxWidth: false, htmlLabels: true },
            sequence: { useMaxWidth: false, htmlLabels: false },
            gantt: { useMaxWidth: false, htmlLabels: false },
            journey: { useMaxWidth: false, htmlLabels: false },
            class: { useMaxWidth: false, htmlLabels: false },
            state: { useMaxWidth: false, htmlLabels: false },
            er: { useMaxWidth: false, htmlLabels: false },
            pie: { useMaxWidth: false, htmlLabels: false },
            quadrantChart: { useMaxWidth: false, htmlLabels: false },
            timeline: { useMaxWidth: false, htmlLabels: false },
            gitgraph: { useMaxWidth: false, htmlLabels: false },
            mindmap: { useMaxWidth: false, htmlLabels: true },
            maxTextSize: 50000,
            maxEdges: 500
          });
          mermaidReady = true;

          // Process any existing diagrams now that Mermaid is ready
          initializeMermaidDiagrams();
        } catch (err) {
          console.error('Failed to load or initialize Mermaid:', err);
        }
      }
    };

    const initializeMermaidDiagrams = async () => {
      const containers = document.querySelectorAll(
        '.mermaid-diagram-container:not([data-processed="true"])'
      );

      if (containers.length === 0) return;

      // Wait for Mermaid to be ready
      if (!mermaidReady) {
        return; // Mermaid will call this function once it's loaded
      }

      for (const container of containers) {
        // Leave diagrams inside a still-streaming message alone; they are
        // re-parsed on every token and will be picked up once streaming ends.
        if (container.closest(STREAMING_SELECTOR)) {
          continue;
        }

        container.dataset.processed = 'true'; // Mark as processed immediately
        const code = decodeURIComponent(container.dataset.code);
        const language = container.dataset.language || 'mermaid';

        if (!validateMermaidCode(code)) {
          console.warn('Skipping incomplete or invalid Mermaid code.');
          container.innerHTML = `<div class="p-4 text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg">Incomplete diagram code.</div>`;
          continue;
        }

        const processedCode = processMermaidCode(code);
        const cached = getCachedRender(processedCode);

        try {
          let svg = cached?.svg;
          let renderId = cached?.renderId;

          if (!svg) {
            // Validate diagram complexity
            const codeLength = code.length;
            const nodeCount = (code.match(/\[.*?\]|{.*?}|\(.*?\)/g) || []).length;
            const edgeCount = (code.match(/-->|->|---|-\.-|==>|==|\.\./g) || []).length;

            const LIMITS = { maxNodes: 100, maxEdges: 200, maxTextLength: 10000 };

            if (
              codeLength > LIMITS.maxTextLength ||
              nodeCount > LIMITS.maxNodes ||
              edgeCount > LIMITS.maxEdges
            ) {
              throw new Error(
                `Diagram too complex (${codeLength} chars, ${nodeCount} nodes, ${edgeCount} edges)`
              );
            }

            // Render the diagram
            const tempId = nextRenderId();

            try {
              const result = await mermaid.render(tempId, processedCode);
              svg = result.svg;
              renderId = tempId;
            } catch (renderError) {
              // Clean up any elements Mermaid may have created
              const tempElement = document.getElementById(tempId);
              if (tempElement) tempElement.remove();
              throw renderError;
            }

            setCachedRender(processedCode, { svg, renderId });
          }

          svg = rescopeSvgIds(svg, renderId, container.id);

          // The container may have been swapped out of the DOM while the
          // asynchronous render was in flight.
          if (!container.isConnected) {
            continue;
          }

          // Drop any pan-zoom instance from a previous render of this container.
          destroyPanZoom(container, panZoomInstances);

          // Create the diagram HTML with toolbar and pan-zoom controls
          container.innerHTML = `
            <div class="mermaid-container code-block-container relative group border border-gray-200 rounded-lg overflow-hidden bg-white shadow-sm">
              <div class="mermaid-diagram p-4 bg-white overflow-x-auto" style="min-height: 200px; width: 100%; max-width: none;">
                <div class="mermaid-svg-container" style="display: flex; justify-content: flex-start; width: 100%; min-width: 100%;">
                  ${svg}
                </div>
                <div class="pan-zoom-controls absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  <button class="mermaid-zoom-in p-1.5 rounded bg-white/90 backdrop-blur-sm text-gray-700 hover:bg-white hover:text-gray-900 shadow-sm transition-all duration-200" type="button" title="${t ? t('common.zoomIn', 'Zoom In') : 'Zoom In'} (+)">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"></path>
                    </svg>
                  </button>
                  <button class="mermaid-zoom-out p-1.5 rounded bg-white/90 backdrop-blur-sm text-gray-700 hover:bg-white hover:text-gray-900 shadow-sm transition-all duration-200" type="button" title="${t ? t('common.zoomOut', 'Zoom Out') : 'Zoom Out'} (-)">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7"></path>
                    </svg>
                  </button>
                  <button class="mermaid-zoom-reset p-1.5 rounded bg-white/90 backdrop-blur-sm text-gray-700 hover:bg-white hover:text-gray-900 shadow-sm transition-all duration-200" type="button" title="${t ? t('common.resetView', 'Reset View') : 'Reset View'} (0)">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="code-block-toolbar flex flex-row items-center justify-between bg-gray-50 border-t border-gray-200 px-3 py-2 rounded-b-lg">
                <div class="flex flex-row items-center gap-2">
                  <span class="text-xs font-medium text-gray-600">Mermaid ${language !== 'mermaid' ? `(${language})` : ''}</span>
                </div>
                <div class="flex flex-row items-center gap-2">
                  <button class="mermaid-copy-code p-1.5 rounded text-xs bg-transparent text-gray-600 hover:bg-gray-200 hover:text-gray-800 transition-colors duration-200 flex items-center gap-1" 
                          data-code="${encodeURIComponent(code)}" data-processed-code="${encodeURIComponent(processedCode)}" type="button" title="${t ? t('common.copyCode', 'Copy code') : 'Copy code'}">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                    </svg>
                    <span class="hidden sm:inline">${t ? t('common.copy', 'Code') : 'Code'}</span>
                  </button>
                  <button class="mermaid-download-svg p-1.5 rounded text-xs bg-transparent text-gray-600 hover:bg-gray-200 hover:text-gray-800 transition-colors duration-200 flex items-center gap-1" 
                          data-svg="${encodeURIComponent(svg)}" data-id="${container.id}" type="button" title="${t ? t('common.downloadSVG', 'Download SVG') : 'Download SVG'}">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                    </svg>
                    <span class="hidden md:inline">SVG</span>
                  </button>
                  <button class="mermaid-download-png p-1.5 rounded text-xs bg-transparent text-gray-600 hover:bg-gray-200 hover:text-gray-800 transition-colors duration-200 flex items-center gap-1" 
                          data-svg="${encodeURIComponent(svg)}" data-id="${container.id}" type="button" title="${t ? t('common.downloadPNG', 'Download PNG') : 'Download PNG'}">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                    </svg>
                    <span class="hidden md:inline">PNG</span>
                  </button>
                  <button class="mermaid-download-pdf p-1.5 rounded text-xs bg-transparent text-gray-600 hover:bg-gray-200 hover:text-gray-800 transition-colors duration-200 flex items-center gap-1" 
                          data-svg="${encodeURIComponent(svg)}" data-id="${container.id}" type="button" title="${t ? t('common.downloadPDF', 'Download PDF') : 'Download PDF'}">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h8.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                    </svg>
                    <span class="hidden md:inline">PDF</span>
                  </button>
                  <button class="mermaid-fullscreen p-1.5 rounded text-xs bg-transparent text-gray-600 hover:bg-gray-200 hover:text-gray-800 transition-colors duration-200 flex items-center gap-1" 
                          data-svg="${encodeURIComponent(svg)}" type="button" title="${t ? t('common.viewFullscreen', 'View Fullscreen') : 'View Fullscreen'}">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"></path>
                    </svg>
                    <span class="hidden lg:inline">Full</span>
                  </button>
                </div>
              </div>
            </div>
          `;

          // Make SVG responsive and initialize pan-zoom
          const svgElement = container.querySelector('svg');
          if (svgElement) {
            // Simple, reliable width handling
            svgElement.style.width = '100%';
            svgElement.style.height = 'auto';
            svgElement.style.maxWidth = 'none';

            // Remove width/height attributes to prevent conflicts
            svgElement.removeAttribute('width');
            svgElement.removeAttribute('height');

            // Initialize svg-pan-zoom for interactive navigation
            try {
              const panZoomInstance = svgPanZoom(svgElement, {
                zoomEnabled: true,
                controlIconsEnabled: false, // We use custom controls
                fit: true,
                center: true,
                minZoom: 0.1,
                maxZoom: 10,
                zoomScaleSensitivity: 0.3,
                dblClickZoomEnabled: true,
                mouseWheelZoomEnabled: true,
                preventMouseEventsDefault: true,
                onZoom: () => {
                  // Optional: Add visual feedback on zoom
                }
              });

              // Store instance for cleanup
              container.panZoomInstance = panZoomInstance;
              panZoomInstances.add(panZoomInstance);

              // Wire up zoom control buttons
              const zoomInBtn = container.querySelector('.mermaid-zoom-in');
              const zoomOutBtn = container.querySelector('.mermaid-zoom-out');
              const zoomResetBtn = container.querySelector('.mermaid-zoom-reset');

              if (zoomInBtn) {
                zoomInBtn.addEventListener('click', () => {
                  panZoomInstance.zoomIn();
                });
              }

              if (zoomOutBtn) {
                zoomOutBtn.addEventListener('click', () => {
                  panZoomInstance.zoomOut();
                });
              }

              if (zoomResetBtn) {
                zoomResetBtn.addEventListener('click', () => {
                  panZoomInstance.reset();
                  panZoomInstance.fit();
                  panZoomInstance.center();
                });
              }
            } catch (panZoomError) {
              console.warn('Could not initialize pan-zoom:', panZoomError);
              // Gracefully degrade - diagram still works without pan-zoom
            }
          }
        } catch (err) {
          console.error('Mermaid rendering error:', err);

          // Display a user-friendly error state
          container.innerHTML = `
            <div class="code-block-container relative group border border-red-200 rounded-lg overflow-hidden bg-red-50 shadow-sm">
              <div class="bg-red-900 text-red-100 rounded-t-lg p-4 overflow-x-auto">
                <div class="text-sm text-red-200 mb-2">Mermaid Syntax Error:</div>
                <div class="text-red-100 text-sm mb-3">${err.message}</div>
                <pre class="text-red-200 text-xs"><code>${code}</code></pre>
              </div>
              <div class="code-block-toolbar flex flex-row items-center justify-between bg-red-100 border-t border-red-200 px-3 py-2 rounded-b-lg">
                <div class="flex flex-row items-center gap-2">
                  <span class="text-xs font-medium text-red-600">Mermaid (Error)</span>
                </div>
                <div class="flex flex-row items-center gap-2">
                  <button class="mermaid-copy-code p-1.5 rounded text-xs bg-transparent text-red-600 hover:bg-red-200 hover:text-red-800 transition-colors duration-200 flex items-center gap-1" 
                          data-code="${encodeURIComponent(code)}" data-processed-code="${encodeURIComponent(processedCode)}" type="button" title="Copy code">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                    </svg>
                    <span class="hidden sm:inline">Copy</span>
                  </button>
                </div>
              </div>
            </div>
          `;
        }
      }
    };

    // Debounced observer callback for efficiency
    const debouncedInit = debounce(initializeMermaidDiagrams, 150);

    const containsDiagram = node =>
      node.nodeType === Node.ELEMENT_NODE &&
      (node.classList?.contains('mermaid-diagram-container') ||
        node.querySelector?.('.mermaid-diagram-container'));

    // Release pan-zoom instances for containers React has detached, otherwise
    // each re-render of a message leaves a live instance behind.
    const releaseRemovedDiagrams = node => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.classList?.contains('mermaid-diagram-container')) {
        destroyPanZoom(node, panZoomInstances);
      }
      node
        .querySelectorAll?.('.mermaid-diagram-container')
        .forEach(child => destroyPanZoom(child, panZoomInstances));
    };

    const observer = new MutationObserver(mutations => {
      let shouldProcess = false;

      mutations.forEach(mutation => {
        if (mutation.type === 'attributes') {
          // A message that just finished streaming in place now holds
          // renderable diagrams that were skipped while it was streaming.
          const classList = mutation.target.classList;
          if (
            classList?.contains(STREAMING_MARKDOWN_CLASS) &&
            !classList.contains(STREAMING_CLASS)
          ) {
            shouldProcess = true;
          }
          return;
        }

        mutation.addedNodes.forEach(node => {
          if (containsDiagram(node)) shouldProcess = true;
        });
        mutation.removedNodes.forEach(releaseRemovedDiagrams);
      });

      if (shouldProcess) {
        debouncedInit();
      }
    });

    // Store timeout IDs for cleanup
    const timeouts = [];

    // Initial run with retry mechanism for diagrams that are already in the DOM
    const initialRun = () => {
      initializeMermaidDiagrams();

      // Retry after a delay to catch diagrams that might be rendered after initial mount
      timeouts.push(
        setTimeout(() => {
          initializeMermaidDiagrams();
        }, 500)
      );

      // One more retry for slower rendering
      timeouts.push(
        setTimeout(() => {
          initializeMermaidDiagrams();
        }, 1500)
      );
    };

    // Start loading Mermaid immediately
    loadMermaid();

    // Run initial processing (will be called again once Mermaid loads)
    initialRun();

    // Set up observer for future DOM changes
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });

    // Single delegated keyboard shortcut handler (+ / - / 0) for every diagram.
    const handleKeyPress = e => {
      if (panZoomInstances.size === 0) return;
      // Only handle if the user isn't typing into a field
      if (document.activeElement && document.activeElement.tagName !== 'BODY') return;

      let action;
      if (e.key === '+' || e.key === '=') action = 'in';
      else if (e.key === '-' || e.key === '_') action = 'out';
      else if (e.key === '0') action = 'reset';
      else return;

      e.preventDefault();
      panZoomInstances.forEach(instance => {
        try {
          if (action === 'in') instance.zoomIn();
          else if (action === 'out') instance.zoomOut();
          else {
            instance.reset();
            instance.fit();
            instance.center();
          }
        } catch (err) {
          console.warn('Pan-zoom keyboard shortcut failed:', err);
        }
      });
    };

    document.addEventListener('keydown', handleKeyPress);

    // Mermaid interaction handler
    const handleMermaidInteraction = e => {
      const button = e.target.closest('button');
      if (!button) return;

      // Copy code
      if (button.classList.contains('mermaid-copy-code')) {
        const code = decodeURIComponent(button.dataset.code);
        navigator.clipboard
          .writeText(code)
          .then(() => showMermaidButtonFeedback(button, 'Copied!', 'text-green-600', 'checkmark'))
          .catch(() => showMermaidButtonFeedback(button, 'Error', 'text-red-600', 'error'));
      }

      // Download SVG
      if (button.classList.contains('mermaid-download-svg')) {
        const id = button.dataset.id;
        try {
          // Find the actual diagram SVG element (not the button SVG)
          const containerElement = button.closest('.mermaid-container');
          let actualSvg = null;

          if (containerElement) {
            // Try multiple selectors to find the diagram SVG
            actualSvg =
              containerElement.querySelector('.mermaid-diagram svg') ||
              containerElement.querySelector('.mermaid-svg-container svg') ||
              containerElement.querySelector('.mermaid-container > div > svg');

            // If still not found, try to find any SVG that's not a button icon
            if (!actualSvg) {
              const allSvgs = containerElement.querySelectorAll('svg');
              for (const svg of allSvgs) {
                // Skip SVGs that are inside buttons (button icons)
                if (!svg.closest('button')) {
                  actualSvg = svg;
                  break;
                }
              }
            }
          }

          if (!actualSvg) {
            throw new Error('Could not find SVG element in the diagram');
          }

          // Get the SVG content directly from the DOM
          const svgClone = actualSvg.cloneNode(true);

          // Ensure SVG has proper namespace
          if (!svgClone.getAttribute('xmlns')) {
            svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          }

          // Get the SVG string
          const svgString = new XMLSerializer().serializeToString(svgClone);

          // Create a proper SVG with XML declaration and DOCTYPE
          const svgWithHeaders = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${svgString}`;
          const blob = new Blob([svgWithHeaders], { type: 'image/svg+xml;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${id}.svg`;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showMermaidButtonFeedback(button, 'Downloaded!', 'text-green-600', 'checkmark');
        } catch (err) {
          console.error('SVG download error:', err);
          showMermaidButtonFeedback(button, 'Error', 'text-red-600', 'error');
        }
      }

      // Download PNG
      if (button.classList.contains('mermaid-download-png')) {
        const id = button.dataset.id;
        try {
          // Find the actual diagram SVG element (not the button SVG)
          const containerElement = button.closest('.mermaid-container');
          let actualSvg = null;

          if (containerElement) {
            // Try multiple selectors to find the diagram SVG
            actualSvg =
              containerElement.querySelector('.mermaid-diagram svg') ||
              containerElement.querySelector('.mermaid-svg-container svg') ||
              containerElement.querySelector('.mermaid-container > div > svg');

            // If still not found, try to find any SVG that's not a button icon
            if (!actualSvg) {
              const allSvgs = containerElement.querySelectorAll('svg');
              for (const svg of allSvgs) {
                // Skip SVGs that are inside buttons (button icons)
                if (!svg.closest('button')) {
                  actualSvg = svg;
                  break;
                }
              }
            }
          }

          if (!actualSvg) {
            throw new Error('Could not find SVG element in the diagram');
          }

          // Get the SVG content directly from the DOM
          const svgClone = actualSvg.cloneNode(true);

          // Ensure SVG has proper namespace
          if (!svgClone.getAttribute('xmlns')) {
            svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          }

          // Get dimensions from the actual SVG
          const rect = actualSvg.getBoundingClientRect();
          const width = Math.max(rect.width || 800, 400);
          const height = Math.max(rect.height || 600, 300);

          // Set explicit width/height on the clone
          svgClone.setAttribute('width', width);
          svgClone.setAttribute('height', height);

          // Get the SVG string
          const svgString = new XMLSerializer().serializeToString(svgClone);

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const img = new Image();

          img.onload = () => {
            // Use higher scaling for better PNG quality - 4x for large diagrams, 3x for smaller ones
            const scaleFactor = width > 1000 || height > 800 ? 4 : 3;
            canvas.width = width * scaleFactor;
            canvas.height = height * scaleFactor;

            // Set highest quality rendering
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            // Fill with white background
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Scale and draw the image with high quality
            ctx.scale(scaleFactor, scaleFactor);
            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob(
              blob => {
                if (blob) {
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${id}.png`;
                  a.style.display = 'none';
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  showMermaidButtonFeedback(button, 'Downloaded!', 'text-green-600', 'checkmark');
                } else {
                  showMermaidButtonFeedback(button, 'Error', 'text-red-600', 'error');
                }
              },
              'image/png',
              1.0
            );
          };

          img.onerror = error => {
            console.error('Image load error:', error);
            showMermaidButtonFeedback(button, 'Error', 'text-red-600', 'error');
          };

          // Create SVG data URL with proper encoding
          const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
          img.src = svgDataUrl;
        } catch (err) {
          console.error('PNG download error:', err);
          showMermaidButtonFeedback(button, 'Error', 'text-red-600', 'error');
        }
      }

      // Download PDF
      if (button.classList.contains('mermaid-download-pdf')) {
        const id = button.dataset.id;
        try {
          // Find the actual diagram SVG element (not the button SVG)
          const containerElement = button.closest('.mermaid-container');
          let actualSvg = null;

          if (containerElement) {
            // Try multiple selectors to find the diagram SVG
            actualSvg =
              containerElement.querySelector('.mermaid-diagram svg') ||
              containerElement.querySelector('.mermaid-svg-container svg') ||
              containerElement.querySelector('.mermaid-container > div > svg');

            // If still not found, try to find any SVG that's not a button icon
            if (!actualSvg) {
              const allSvgs = containerElement.querySelectorAll('svg');
              for (const svg of allSvgs) {
                // Skip SVGs that are inside buttons (button icons)
                if (!svg.closest('button')) {
                  actualSvg = svg;
                  break;
                }
              }
            }
          }

          if (!actualSvg) {
            throw new Error('Could not find SVG element in the diagram');
          }

          // Get the SVG content directly from the DOM
          const svgClone = actualSvg.cloneNode(true);

          // Ensure SVG has proper namespace
          if (!svgClone.getAttribute('xmlns')) {
            svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          }

          // Get dimensions from the actual SVG
          const rect = actualSvg.getBoundingClientRect();
          const width = Math.max(rect.width || 800, 400);
          const height = Math.max(rect.height || 600, 300);

          // Set explicit width/height on the clone for PDF
          svgClone.setAttribute('width', width);
          svgClone.setAttribute('height', height);

          // Get the SVG string
          const svgString = new XMLSerializer().serializeToString(svgClone);

          // Create canvas for PDF generation
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const img = new Image();

          img.onload = () => {
            // Use higher scaling for better PDF quality - 4x for large diagrams, minimum 3x
            const scaleFactor = Math.max(3, width > 1000 || height > 800 ? 4 : 3);
            canvas.width = width * scaleFactor;
            canvas.height = height * scaleFactor;

            // Set highest quality rendering
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            // Fill with white background
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Scale and draw the image with high quality
            ctx.scale(scaleFactor, scaleFactor);
            ctx.drawImage(img, 0, 0, width, height);

            // Convert canvas to blob and create PDF with high quality
            canvas.toBlob(
              async blob => {
                if (blob) {
                  try {
                    // Dynamically import jsPDF
                    const { jsPDF } = await import('https://cdn.skypack.dev/jspdf@2.5.1');

                    // Calculate PDF dimensions based on actual diagram size with better scaling
                    const margin = 10; // 10mm margin

                    // Calculate dimensions in mm, ensuring minimum readable size
                    let pdfWidthMM = Math.max(width * 0.26458, 100); // Convert px to mm (96 DPI assumption)
                    let pdfHeightMM = Math.max(height * 0.26458, 70);

                    // Add margins
                    pdfWidthMM += margin * 2;
                    pdfHeightMM += margin * 2;

                    // Limit maximum size to reasonable bounds
                    const maxWidthMM = 420; // A3 width
                    const maxHeightMM = 297; // A3 height

                    if (pdfWidthMM > maxWidthMM || pdfHeightMM > maxHeightMM) {
                      const scaleRatio = Math.min(
                        maxWidthMM / pdfWidthMM,
                        maxHeightMM / pdfHeightMM
                      );
                      pdfWidthMM *= scaleRatio;
                      pdfHeightMM *= scaleRatio;
                    }

                    const pdf = new jsPDF({
                      orientation: pdfWidthMM > pdfHeightMM ? 'landscape' : 'portrait',
                      unit: 'mm',
                      format: [pdfWidthMM, pdfHeightMM],
                      compress: false // Disable compression for better quality
                    });

                    // Convert blob to data URL
                    const reader = new FileReader();
                    reader.onload = () => {
                      // Add image to PDF with margins, using high quality settings
                      const imageWidth = pdfWidthMM - margin * 2;
                      const imageHeight = pdfHeightMM - margin * 2;

                      pdf.addImage(
                        reader.result,
                        'PNG',
                        margin,
                        margin,
                        imageWidth,
                        imageHeight,
                        undefined,
                        'MEDIUM' // Use MEDIUM compression for balance of quality and size
                      );

                      // Save the PDF
                      pdf.save(`${id}.pdf`);
                      showMermaidButtonFeedback(
                        button,
                        'Downloaded!',
                        'text-green-600',
                        'checkmark'
                      );
                    };
                    reader.readAsDataURL(blob);
                  } catch (pdfError) {
                    console.error('PDF library error:', pdfError);
                    showMermaidButtonFeedback(button, 'Error', 'text-red-600', 'error');
                  }
                } else {
                  showMermaidButtonFeedback(button, 'Error', 'text-red-600', 'error');
                }
              },
              'image/png',
              1.0 // Maximum quality
            );
          };

          img.onerror = error => {
            console.error('Image load error for PDF:', error);
            showMermaidButtonFeedback(button, 'Error', 'text-red-600', 'error');
          };

          // Create SVG data URL with proper encoding
          const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
          img.src = svgDataUrl;
        } catch (err) {
          console.error('PDF download error:', err);
          showMermaidButtonFeedback(button, 'Error', 'text-red-600', 'error');
        }
      }

      // Fullscreen viewer
      if (button.classList.contains('mermaid-fullscreen')) {
        const svg = decodeURIComponent(button.dataset.svg);

        // Check if modal already exists to prevent double opening
        if (document.querySelector('.mermaid-fullscreen-modal')) {
          return;
        }

        const modal = document.createElement('div');
        modal.className =
          'mermaid-fullscreen-modal fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-75 p-4';
        modal.style.zIndex = '9999';

        modal.innerHTML = `
          <div class="relative w-full h-full bg-white rounded-lg shadow-xl overflow-hidden flex flex-col">
            <div class="absolute top-4 right-4 z-20 flex gap-2">
              <button class="zoom-out p-2 bg-white rounded-full shadow-lg hover:bg-gray-100 transition-colors" title="Zoom Out">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7"></path>
                </svg>
              </button>
              <button class="zoom-in p-2 bg-white rounded-full shadow-lg hover:bg-gray-100 transition-colors" title="Zoom In">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"></path>
                </svg>
              </button>
              <button class="reset-zoom p-2 bg-white rounded-full shadow-lg hover:bg-gray-100 transition-colors" title="Reset Zoom">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                </svg>
              </button>
              <button class="close-fullscreen p-2 bg-white rounded-full shadow-lg hover:bg-gray-100 transition-colors" title="Close">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
              </button>
            </div>
            <div class="diagram-viewer flex-1 overflow-hidden p-8 relative" style="cursor: grab;">
              <div class="diagram-content" style="transform-origin: 0 0; width: fit-content; position: absolute; top: 0; left: 0; opacity: 0;">
                ${svg}
              </div>
            </div>
          </div>
        `;

        const PADDING = 32; // matches the p-8 padding on .diagram-viewer
        const MIN_ZOOM = 0.1;
        const MAX_ZOOM = 5;

        let currentZoom = 1;
        let isDragging = false;
        let startX, startY;
        let translateX = 0;
        let translateY = 0;

        const diagramViewer = modal.querySelector('.diagram-viewer');
        const diagramContent = modal.querySelector('.diagram-content');

        // Update transform with zoom and translation
        const updateTransform = () => {
          diagramContent.style.transform = `translate(${translateX}px, ${translateY}px) scale(${currentZoom})`;
        };

        // Measure the untransformed size of the diagram.
        const measureDiagram = () => {
          const svgElement = diagramContent.querySelector('svg');
          if (!svgElement) return null;

          const previousTransform = diagramContent.style.transform;
          diagramContent.style.transform = 'none';
          const svgRect = svgElement.getBoundingClientRect();
          diagramContent.style.transform = previousTransform;

          if (!svgRect.width || !svgRect.height) return null;
          return { width: svgRect.width, height: svgRect.height };
        };

        // Scale the diagram down so it fits the viewer, then centre it.
        // Centring alone is not enough: a diagram larger than the viewer ends up
        // with a negative offset and is pushed outside the clipped viewport,
        // which made the fullscreen view appear blank.
        const fitDiagram = () => {
          const size = measureDiagram();
          if (!size) return false;

          const viewerRect = diagramViewer.getBoundingClientRect();
          const availableWidth = viewerRect.width - PADDING * 2;
          const availableHeight = viewerRect.height - PADDING * 2;
          if (availableWidth <= 0 || availableHeight <= 0) return false;

          // Never scale up beyond 1:1; only shrink oversized diagrams.
          currentZoom = Math.max(
            MIN_ZOOM,
            Math.min(1, availableWidth / size.width, availableHeight / size.height)
          );

          translateX = PADDING + (availableWidth - size.width * currentZoom) / 2;
          translateY = PADDING + (availableHeight - size.height * currentZoom) / 2;

          updateTransform();
          return true;
        };

        // Zoom functionality
        const updateZoom = (newZoom, zoomCenterX = null, zoomCenterY = null) => {
          const oldZoom = currentZoom;
          currentZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
          const zoomRatio = currentZoom / oldZoom;

          if (zoomCenterX === null || zoomCenterY === null) {
            // Default zoom towards the center of the viewer
            const viewerRect = diagramViewer.getBoundingClientRect();
            zoomCenterX = viewerRect.width / 2;
            zoomCenterY = viewerRect.height / 2;
          }

          // Calculate new translation to keep the zoom point stable
          translateX = zoomCenterX - (zoomCenterX - translateX) * zoomRatio;
          translateY = zoomCenterY - (zoomCenterY - translateY) * zoomRatio;

          updateTransform();
        };

        modal
          .querySelector('.zoom-in')
          .addEventListener('click', () => updateZoom(currentZoom * 1.2));
        modal
          .querySelector('.zoom-out')
          .addEventListener('click', () => updateZoom(currentZoom / 1.2));
        modal.querySelector('.reset-zoom').addEventListener('click', fitDiagram);

        // Fit the diagram before it becomes visible, retrying while the browser
        // is still laying the SVG out. The content stays hidden until the first
        // successful fit so the diagram never flashes at the wrong position.
        const initializePosition = () => {
          let attempts = 0;
          const maxAttempts = 10;

          const tryFit = () => {
            if (!document.body.contains(modal)) return;
            if (fitDiagram()) {
              diagramContent.style.opacity = '1';
              diagramContent.classList.add('transition-transform', 'duration-200');
            } else if (attempts < maxAttempts) {
              attempts++;
              setTimeout(tryFit, 50);
            } else {
              // Give up on measuring and at least show the diagram.
              diagramContent.style.opacity = '1';
            }
          };

          tryFit();
        };

        // Re-fit when the window (and therefore the viewer) is resized.
        const handleResize = debounce(fitDiagram, 150);
        window.addEventListener('resize', handleResize);

        // Drag functionality
        diagramViewer.addEventListener('mousedown', e => {
          if (e.target.closest('button')) return;
          isDragging = true;
          diagramViewer.style.cursor = 'grabbing';
          startX = e.clientX - translateX;
          startY = e.clientY - translateY;
          e.preventDefault();
        });

        // Wheel zoom
        diagramViewer.addEventListener('wheel', e => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;

            // Get mouse position relative to the viewer
            const viewerRect = diagramViewer.getBoundingClientRect();
            const mouseX = e.clientX - viewerRect.left;
            const mouseY = e.clientY - viewerRect.top;

            updateZoom(currentZoom * zoomFactor, mouseX, mouseY);
          }
        });

        // Create cleanup function for event listeners
        const mouseMoveHandler = e => {
          if (!isDragging) return;
          e.preventDefault();
          translateX = e.clientX - startX;
          translateY = e.clientY - startY;
          updateTransform();
        };

        const mouseUpHandler = () => {
          if (isDragging) {
            isDragging = false;
            diagramViewer.style.cursor = 'grab';
          }
        };

        const escapeHandler = e => {
          if (e.key === 'Escape') {
            closeModal();
          }
        };

        // Add document event listeners
        document.addEventListener('mousemove', mouseMoveHandler);
        document.addEventListener('mouseup', mouseUpHandler);
        document.addEventListener('keydown', escapeHandler);

        const closeModal = () => {
          if (document.body.contains(modal)) {
            // Clean up event listeners
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
            document.removeEventListener('keydown', escapeHandler);
            window.removeEventListener('resize', handleResize);
            document.body.removeChild(modal);
          }
        };

        modal.addEventListener('click', e => {
          if (e.target === modal) closeModal();
        });

        modal.querySelector('.close-fullscreen').addEventListener('click', closeModal);

        document.body.appendChild(modal);

        // Position only once the modal is in the document and measurable.
        requestAnimationFrame(initializePosition);
      }
    };

    document.addEventListener('click', handleMermaidInteraction);

    return () => {
      // Clean up pan-zoom instances
      document
        .querySelectorAll('.mermaid-diagram-container')
        .forEach(container => destroyPanZoom(container, panZoomInstances));
      panZoomInstances.forEach(instance => {
        try {
          instance.destroy();
        } catch (e) {
          console.warn('Error destroying pan-zoom instance:', e);
        }
      });
      panZoomInstances.clear();

      // Clear any pending timeouts
      timeouts.forEach(clearTimeout);
      observer.disconnect();
      document.removeEventListener('keydown', handleKeyPress);
      document.removeEventListener('click', handleMermaidInteraction);
    };
  }, [t]);
};
