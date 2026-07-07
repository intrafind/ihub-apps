import { marked } from 'marked';
import { renderMarkdown } from '../../../client/src/config/marked.config';

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
