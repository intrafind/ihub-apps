/**
 * useMermaidRenderer turns the diagram containers created by the Markdown
 * renderer into diagrams. Diagram source comes from content (model output,
 * pages, user messages), so everything the hook writes into the page has to
 * treat it as text or sanitized markup, and look-alike containers that come
 * from the content itself must be left alone.
 */
import { renderHook, waitFor } from '@testing-library/react';

jest.mock('mermaid', () => ({
  __esModule: true,
  default: { initialize: jest.fn(), render: jest.fn() }
}));

jest.mock('svg-pan-zoom', () =>
  jest.fn(() => ({
    destroy: jest.fn(),
    zoomIn: jest.fn(),
    zoomOut: jest.fn(),
    reset: jest.fn(),
    fit: jest.fn(),
    center: jest.fn()
  }))
);

import mermaid from 'mermaid';
import { useMermaidRenderer } from '../../../client/src/hooks/useMermaidRenderer';
import { renderMarkdown } from '../../../client/src/config/marked.config';
import {
  MERMAID_CONTAINER_TOKEN_ATTRIBUTE,
  isTrustedMermaidContainer
} from '../../../client/src/utils/mermaidSecurity';

const t = (key, fallback) => fallback;

/** A global flag that the inline handlers in the test markup would set. */
const SENTINEL = '__mermaidRendererSentinel';
const SET_SENTINEL = `window.${SENTINEL} = true`;

const fence = source => `\`\`\`mermaid\n${source}\n\`\`\``;

/** Renders Markdown the way the app does and puts the result into the page. */
const mountMarkdown = markdown => {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(markdown);
  document.body.appendChild(host);
  return host;
};

const startHook = () => renderHook(() => useMermaidRenderer({ t }));

/** Dispatches the events the test markup has inline handlers for. */
const fireInlineHandlers = root => {
  root.querySelectorAll('*').forEach(element => {
    element.dispatchEvent(new Event('error'));
    element.dispatchEvent(new Event('load'));
  });
};

const simpleSvg = (id, labelHtml = 'Start') =>
  `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">` +
  `<style>#${id}{font-family:sans-serif;}</style>` +
  '<g class="node"><rect width="80" height="30"></rect>' +
  '<foreignObject width="80" height="30">' +
  '<div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;">' +
  `<span class="nodeLabel"><p>${labelHtml}</p></span>` +
  '</div></foreignObject></g></svg>';

beforeEach(() => {
  mermaid.initialize.mockClear();
  mermaid.render.mockReset();
  delete window[SENTINEL];
});

afterEach(() => {
  document.body.innerHTML = '';
  delete window[SENTINEL];
  jest.restoreAllMocks();
});

describe('useMermaidRenderer', () => {
  test('configures Mermaid with the strict security level', async () => {
    mountMarkdown(fence('flowchart TD\n  A[Config] --> B[Check]'));
    mermaid.render.mockImplementation(async id => ({ svg: simpleSvg(id) }));

    startHook();

    await waitFor(() => expect(mermaid.initialize).toHaveBeenCalled());
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict' })
    );
  });

  test('renders diagram source and error message as text in the error state', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Control: inline handlers do run in this environment, so the sentinel
    // check below is meaningful.
    const control = document.createElement('div');
    control.innerHTML = `<img src="x" onerror="${SET_SENTINEL}">`;
    control.firstChild.dispatchEvent(new Event('error'));
    expect(window[SENTINEL]).toBe(true);
    delete window[SENTINEL];

    const source =
      'flowchart TD\n' +
      '  A[<b>marker</b>] --> B[Next]\n' +
      `  B --> C[<img src="x" onerror="${SET_SENTINEL}">]`;
    const host = mountMarkdown(fence(source));
    mermaid.render.mockRejectedValue(new Error('Parse error near <b>marker</b>'));

    startHook();

    const container = host.querySelector('.mermaid-diagram-container');
    await waitFor(() => expect(container.querySelector('pre code')).not.toBeNull());

    expect(container.querySelector('pre code').textContent).toBe(source);
    expect(container.textContent).toContain('Parse error near <b>marker</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();

    fireInlineHandlers(container);
    expect(window[SENTINEL]).toBeUndefined();
  });

  test('leaves diagram containers alone that the Markdown renderer did not create', async () => {
    const trustedSource = 'flowchart TD\n  A[Trusted] --> B[Diagram]';
    const lookAlikeCode = encodeURIComponent('flowchart TD\n  X[Look] --> Y[Alike]');
    // Raw HTML in the content keeps class and data-* attributes through the
    // Markdown sanitizer, so these reach the page as written.
    const host = mountMarkdown(
      [
        fence(trustedSource),
        '',
        `<div class="mermaid-diagram-container" id="without-token" data-code="${lookAlikeCode}">untouched one</div>`,
        '',
        `<div class="mermaid-diagram-container" id="wrong-token" ${MERMAID_CONTAINER_TOKEN_ATTRIBUTE}="0123456789abcdef0123456789abcdef" data-code="${lookAlikeCode}">untouched two<button class="mermaid-fullscreen" data-svg="${encodeURIComponent('<p id="from-attribute">attribute</p>')}">Full</button></div>`
      ].join('\n')
    );
    mermaid.render.mockImplementation(async id => ({ svg: simpleSvg(id) }));

    const [trusted] = host.querySelectorAll('.mermaid-diagram-container');
    const withoutToken = host.querySelector('#without-token');
    const wrongToken = host.querySelector('#wrong-token');
    expect(isTrustedMermaidContainer(trusted)).toBe(true);
    expect(isTrustedMermaidContainer(withoutToken)).toBe(false);
    expect(isTrustedMermaidContainer(wrongToken)).toBe(false);
    const wrongTokenMarkup = wrongToken.innerHTML;

    startHook();

    await waitFor(() => expect(trusted.querySelector('.mermaid-svg-container svg')).not.toBeNull());

    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(mermaid.render.mock.calls[0][1]).toBe(trustedSource);
    expect(withoutToken.dataset.processed).toBeUndefined();
    expect(withoutToken.textContent).toBe('untouched one');
    expect(wrongToken.dataset.processed).toBeUndefined();
    expect(wrongToken.innerHTML).toBe(wrongTokenMarkup);

    // Toolbar look-alikes outside a container the renderer created do nothing.
    wrongToken.querySelector('.mermaid-fullscreen').click();
    expect(document.querySelector('.mermaid-fullscreen-modal')).toBeNull();
    expect(document.getElementById('from-attribute')).toBeNull();
  });

  test('sanitizes the SVG returned by Mermaid and keeps HTML node labels', async () => {
    const host = mountMarkdown(fence('flowchart TD\n  A[Start] --> B[Sanitized]'));
    mermaid.render.mockImplementation(async id => ({
      svg:
        `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" onload="${SET_SENTINEL}">` +
        `<style>#${id}{font-family:sans-serif;}</style>` +
        `<script>${SET_SENTINEL}</script>` +
        '<g class="node" id="flowchart-A-0"><rect width="80" height="30"></rect>' +
        '<foreignObject width="80" height="30">' +
        '<div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;">' +
        `<span class="nodeLabel"><p>Start <b>marker</b><img src="x" onerror="${SET_SENTINEL}"></p></span>` +
        '</div></foreignObject></g>' +
        `<a href="javascript:${SET_SENTINEL}"><text x="0" y="45">link</text></a>` +
        '</svg>'
    }));

    startHook();

    const container = host.querySelector('.mermaid-diagram-container');
    await waitFor(() =>
      expect(container.querySelector('.mermaid-svg-container svg')).not.toBeNull()
    );

    const svg = container.querySelector('.mermaid-svg-container svg');
    expect(svg.id).toBe(`${container.id}-svg`);
    expect(svg.hasAttribute('onload')).toBe(false);
    expect(container.querySelector('script')).toBeNull();
    expect(svg.querySelector('style')).not.toBeNull();

    const label = svg.querySelector('foreignObject span.nodeLabel p');
    expect(label).not.toBeNull();
    expect(label.textContent).toBe('Start marker');
    expect(label.querySelector('b').textContent).toBe('marker');
    expect(label.querySelector('img').hasAttribute('onerror')).toBe(false);

    const link = svg.querySelector('a');
    expect(link.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);

    fireInlineHandlers(container);
    expect(window[SENTINEL]).toBeUndefined();
  });

  test('opens the fullscreen view from the rendered diagram, not from button attributes', async () => {
    const host = mountMarkdown(fence('flowchart TD\n  A[Full] --> B[Screen]'));
    mermaid.render.mockImplementation(async id => ({ svg: simpleSvg(id, 'Fullscreen label') }));

    startHook();

    const container = host.querySelector('.mermaid-diagram-container');
    await waitFor(() =>
      expect(container.querySelector('.mermaid-svg-container svg')).not.toBeNull()
    );

    const button = container.querySelector('.mermaid-fullscreen');
    expect(button.hasAttribute('data-svg')).toBe(false);
    button.setAttribute(
      'data-svg',
      encodeURIComponent(
        `<p id="from-attribute">attribute</p><img src="x" onerror="${SET_SENTINEL}">`
      )
    );

    button.click();

    const modal = document.querySelector('.mermaid-fullscreen-modal');
    expect(modal).not.toBeNull();
    expect(modal.querySelector('.diagram-content span.nodeLabel').textContent).toBe(
      'Fullscreen label'
    );
    expect(document.getElementById('from-attribute')).toBeNull();
    expect(modal.querySelector('img')).toBeNull();
    expect(window[SENTINEL]).toBeUndefined();

    modal.querySelector('.close-fullscreen').click();
    expect(document.querySelector('.mermaid-fullscreen-modal')).toBeNull();
  });
});
