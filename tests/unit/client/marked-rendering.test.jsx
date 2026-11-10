import { marked } from 'marked';
import { renderInlineMarkdown, renderMarkdown } from '../../../client/src/config/marked.config';

describe('renderMarkdown', () => {
  test('sanitizes unsafe html', () => {
    const html = renderMarkdown('# Title\n<script>alert("xss")</script>');

    expect(html).toContain('<h1');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert("xss")');
  });

  test('uses the shared custom code block renderer', () => {
    const html = renderMarkdown('```js\nconsole.log("hello")\n```');

    expect(html).toContain('code-block-container');
    expect(html).toContain('code-copy-btn');
    expect(html).toContain('code-download-btn');
  });

  test('does not mutate the global marked singleton', () => {
    const globalHtml = marked.parse('```js\nconsole.log("hello")\n```');

    expect(globalHtml).not.toContain('code-block-container');
  });
});

describe('link tooltips', () => {
  test('a link without a title gets its decoded destination as the tooltip', () => {
    const href =
      'https://ifinder.sharepoint.com/sites/Vertrieb/_layouts/15/Doc.aspx?sourcedoc=%7B3B68%7D&file=Schulungsangebot.pptx';
    const html = renderMarkdown(`[Schulungsangebot](${href})`);

    expect(html).toContain(
      'title="https://ifinder.sharepoint.com/sites/Vertrieb/_layouts/15/Doc.aspx?sourcedoc={3B68}&amp;file=Schulungsangebot.pptx"'
    );
    expect(html).toContain('>Schulungsangebot</a>');
  });

  test('an explicit link title wins and is escaped', () => {
    const html = renderMarkdown(
      '[Report](https://example.com/r "SharePoint › Vertrieb · onedrive-d4HF8X5AZOWTbeGW")'
    );

    expect(html).toContain('title="SharePoint › Vertrieb · onedrive-d4HF8X5AZOWTbeGW"');
    expect(html).not.toContain('title="https://example.com/r"');

    // Entities already in the title stay entities; `<c>` becomes attribute
    // text, not an element.
    const escaped = renderMarkdown('[x](https://example.com/ "a &quot;b&quot; <c>")');
    expect(escaped).toContain('title="a &quot;b&quot; <c>"');
    expect(escaped).not.toContain('&amp;quot;');
    expect(escaped).not.toContain('</c>');
  });

  test('a link whose text is the URL and a fragment link get no tooltip', () => {
    expect(renderMarkdown('<https://example.com/page>')).not.toContain('title=');
    expect(renderMarkdown('[https://example.com/page](https://example.com/page)')).not.toContain(
      'title='
    );
    expect(renderMarkdown('[Section](#section)')).not.toContain('title=');
  });

  test('a very long destination is cut for the tooltip', () => {
    const href = `https://example.com/${'a'.repeat(400)}`;
    const html = renderMarkdown(`[Long](${href})`);
    const title = html.match(/title="([^"]*)"/)[1];

    expect(title.length).toBe(200);
    expect(title.endsWith('…')).toBe(true);
    expect(html).toContain(`href="${href}"`);
  });

  test('links in table cells get tooltips too', () => {
    const md = '| Doc | Date |\n|---|---|\n| [A](https://example.com/a) | 2026-04-20 |';
    const html = renderMarkdown(md);

    expect(html).toContain('<td><a href="https://example.com/a" title="https://example.com/a"');
  });
});

describe('external links', () => {
  const anchorOf = html => {
    const container = document.createElement('div');
    container.innerHTML = html;
    return container.querySelector('a');
  };

  test('a link to another origin opens in a new tab without the opener', () => {
    const a = anchorOf(renderMarkdown('[Report](https://example.com/report)'));

    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('another port or host counts as external, the page origin does not', () => {
    const { origin, hostname } = window.location;
    const otherPort = anchorOf(renderMarkdown(`[x](http://${hostname}:65000/y)`));
    const samePage = anchorOf(renderMarkdown(`[x](${origin}/apps/chat)`));

    expect(otherPort.getAttribute('target')).toBe('_blank');
    expect(samePage.hasAttribute('target')).toBe(false);
  });

  test('relative, fragment and mailto links stay in the current tab', () => {
    for (const href of ['/apps/chat', '#section', 'mailto:team@example.com']) {
      expect(anchorOf(renderMarkdown(`[x](${href})`)).hasAttribute('target')).toBe(false);
    }
  });

  test('raw HTML cannot choose the target or drop the opener protection', () => {
    const external = anchorOf(renderMarkdown('<a href="https://example.com" target="_self">x</a>'));
    const internal = anchorOf(renderMarkdown('<a href="/apps/chat" target="_blank">x</a>'));

    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(internal.hasAttribute('target')).toBe(false);
  });

  test('inline rendering pins links too, and the hook does not leak to other DOMPurify calls', () => {
    const DOMPurify = require('dompurify');
    const inline = anchorOf(renderInlineMarkdown('[x](https://example.com)'));

    expect(inline.getAttribute('target')).toBe('_blank');
    expect(DOMPurify.sanitize('<a href="https://example.com" target="_blank">x</a>')).not.toContain(
      'target'
    );
  });
});
