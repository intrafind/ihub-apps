/**
 * Chat export (client/src/features/chat/utils/chatExport.js): JSON, JSONL, Markdown, HTML and
 * the PDF hand-off to the server.
 *
 * The Markdown export is the one with a history: it used a private regex converter that left
 * HTML links, lists and headings unconverted. Swapping in turndown for *everything* is not the
 * fix either — turndown parses its input as HTML, so plain text and Markdown lose their
 * newlines (a list ends up on one line) and get `_` / `*` escaped. Only real HTML fragments
 * may go through it; the tests pin both halves.
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/exports', () => ({
  exportPdfOnServer: jest.fn()
}));
jest.mock('../../../client/src/utils/externalNavigation', () => ({
  saveBlobAs: jest.fn()
}));
// The DOCX/PPTX builders pulled in by exportFormats are irrelevant here (and heavy); keep the
// two naming helpers the chat export uses deterministic.
jest.mock('../../../client/src/utils/exportFormats', () => ({
  buildChatExportFilename: jest.fn(({ format }) => `chat.${format}`),
  buildChatExportTitle: jest.fn(({ appName }) => `${appName} chat`)
}));

const { exportPdfOnServer } = require('../../../client/src/api/endpoints/exports');
const { saveBlobAs } = require('../../../client/src/utils/externalNavigation');
const {
  messageContentToMarkdown,
  exportChatToFormat
} = require('../../../client/src/features/chat/utils/chatExport');

/** Read a Blob's text; jsdom's Blob has no `.text()` in every version. */
const readBlob = blob =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(blob);
  });

describe('messageContentToMarkdown', () => {
  it('passes plain text through with its newlines intact', () => {
    const text = 'Sure.\n\nHere is the answer.\nSecond line.';
    expect(messageContentToMarkdown(text)).toBe(text);
  });

  it('keeps Markdown lists and headings that do not open the message', () => {
    // markdownUtils.isMarkdown() anchors list/heading patterns to the string start, so none of
    // these would be recognised as Markdown — they must still survive untouched.
    expect(messageContentToMarkdown('Here are items:\n- one\n- two')).toBe(
      'Here are items:\n- one\n- two'
    );
    expect(messageContentToMarkdown('Steps:\n1. open\n2. close')).toBe('Steps:\n1. open\n2. close');
    expect(messageContentToMarkdown('Intro\n\n## Heading\n\nbody')).toBe(
      'Intro\n\n## Heading\n\nbody'
    );
  });

  it('does not escape underscores or asterisks in plain text', () => {
    expect(messageContentToMarkdown('Use my_var_name and 5*3 here')).toBe(
      'Use my_var_name and 5*3 here'
    );
  });

  it('leaves Markdown that merely mentions HTML tags in a code block alone', () => {
    const md = 'Try this:\n\n```html\n<div>\n  <p>hi</p>\n</div>\n```';
    expect(messageContentToMarkdown(md)).toBe(md);
  });

  it('converts an HTML fragment, keeping links, lists and headings', () => {
    const html =
      '<h2>Title</h2><p>See <a href="https://x.y/z">the docs</a></p><ul><li>a</li><li>b</li></ul>';
    const md = messageContentToMarkdown(html);

    expect(md).toContain('[the docs](https://x.y/z)');
    expect(md).toMatch(/^Title\n-+/m);
    expect(md).toMatch(/^\*\s+a$/m);
    expect(md).toMatch(/^\*\s+b$/m);
    expect(md).not.toContain('<');
  });

  it('converts an image-only HTML reply instead of leaving the raw tag', () => {
    // The chat UI renders content that is just an <img> (e.g. a generated image), so the export
    // has to recognise it as HTML too.
    expect(messageContentToMarkdown('<img src="data:image/png;base64,AAAA" alt="chart">')).toBe(
      '![chart](data:image/png;base64,AAAA)'
    );
  });

  it('returns an empty string for missing or non-string content', () => {
    expect(messageContentToMarkdown()).toBe('');
    expect(messageContentToMarkdown(null)).toBe('');
    expect(messageContentToMarkdown('')).toBe('');
    expect(messageContentToMarkdown({ text: 'x' })).toBe('');
  });
});

describe('exportChatToFormat', () => {
  let downloads = [];

  beforeEach(() => {
    downloads = [];
    exportPdfOnServer.mockReset();
    // Every client-side format ends in saveBlobAs (the shared helper that also keeps the object
    // URL alive until the transfer starts), so recording its calls captures the downloads.
    saveBlobAs.mockReset();
    saveBlobAs.mockImplementation((blob, filename) => {
      downloads.push({ filename, blob });
      return true;
    });
  });

  const messages = [
    { role: 'assistant', content: 'Welcome!', isGreeting: true },
    { role: 'user', content: 'List two things', timestamp: 1700000000000 },
    {
      role: 'assistant',
      content: 'Two things:\n- one\n- see [docs](https://example.com)',
      timestamp: 1700000001000
    }
  ];
  const settings = { model: 'gpt-test', temperature: 0.5 };

  it('exports Markdown without greetings, and without mangling Markdown replies', async () => {
    const result = await exportChatToFormat(messages, settings, 'markdown', {
      appId: 'chat',
      appName: 'Chat'
    });

    expect(result).toEqual({ success: true, filename: 'chat.md' });
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe('chat.md');
    expect(await readBlob(downloads[0].blob)).toBe(
      '**user**: List two things\n\n**assistant**: Two things:\n- one\n- see [docs](https://example.com)'
    );
  });

  it('exports Markdown links, lists and headings from HTML replies', async () => {
    await exportChatToFormat(
      [{ role: 'assistant', content: '<h2>Result</h2><p>Go to <a href="https://a.b">a.b</a></p>' }],
      settings,
      'markdown'
    );

    const text = await readBlob(downloads[0].blob);
    expect(text).toContain('[a.b](https://a.b)');
    expect(text).toMatch(/Result\n-+/);
    expect(text).not.toContain('<a ');
  });

  it('exports JSON with the settings metadata and no greeting', async () => {
    await exportChatToFormat(messages, settings, 'json', { appName: 'Chat' });

    const parsed = JSON.parse(await readBlob(downloads[0].blob));
    expect(downloads[0].filename).toBe('chat.json');
    expect(parsed.model).toBe('gpt-test');
    expect(parsed.temperature).toBe(0.5);
    expect(parsed.messages.map(m => m.role)).toEqual(['user', 'assistant']);
  });

  it('exports JSONL as one meta line followed by one line per message', async () => {
    await exportChatToFormat(messages, settings, 'jsonl', { appName: 'Chat' });

    const lines = (await readBlob(downloads[0].blob)).split('\n').map(line => JSON.parse(line));
    expect(downloads[0].filename).toBe('chat.jsonl');
    expect(lines[0]).toEqual({ meta: { model: 'gpt-test', temperature: 0.5 } });
    expect(lines.slice(1).map(m => m.role)).toEqual(['user', 'assistant']);
  });

  it('exports HTML that renders Markdown, escapes the title and strips scripts', async () => {
    await exportChatToFormat(
      [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'See [docs](https://example.com)\n\n<script>alert(1)</script>'
        }
      ],
      settings,
      'html',
      { appName: 'A <b>&</b> B' }
    );

    const html = await readBlob(downloads[0].blob);
    expect(downloads[0].filename).toBe('chat.html');
    expect(html).toContain('<a href="https://example.com">docs</a>');
    expect(html).not.toContain('<script>');
    // The title comes from user-controlled text: it must be escaped, not interpolated raw.
    expect(html).toContain('<title>A &lt;b&gt;&amp;&lt;/b&gt; B chat</title>');
  });

  it('renders the PDF on the server and saves the result, dropping greetings', async () => {
    const pdf = new Blob(['%PDF'], { type: 'application/pdf' });
    exportPdfOnServer.mockResolvedValue(pdf);

    const result = await exportChatToFormat(messages, settings, 'pdf', {
      appId: 'chat',
      appName: 'Chat',
      template: 'minimal',
      watermark: { text: '', position: 'bottom-left', opacity: 0.3 },
      language: 'de'
    });

    expect(result).toEqual({ success: true, filename: 'chat.pdf' });
    expect(exportPdfOnServer).toHaveBeenCalledTimes(1);
    const payload = exportPdfOnServer.mock.calls[0][0];
    expect(payload).toMatchObject({
      kind: 'chat',
      appId: 'chat',
      appName: 'Chat',
      filename: 'chat.pdf',
      template: 'minimal',
      language: 'de',
      // A cleared watermark text is sent as '', so it means "no watermark", not "platform default".
      watermark: { text: '', position: 'bottom-left', opacity: 0.3 },
      settings
    });
    expect(payload.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(saveBlobAs).toHaveBeenCalledWith(pdf, 'chat.pdf');
  });

  it('reports a failed save instead of claiming the export succeeded', async () => {
    // ExportDialog closes itself after anything that does not throw, so a download the browser
    // refused to start has to surface as an error — for the client-side formats and for the PDF.
    saveBlobAs.mockReturnValue(false);
    exportPdfOnServer.mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }));

    await expect(exportChatToFormat(messages, settings, 'markdown')).rejects.toThrow(
      'The download of chat.md could not be started'
    );
    await expect(exportChatToFormat(messages, settings, 'json')).rejects.toThrow(
      'The download of chat.json could not be started'
    );
    await expect(exportChatToFormat(messages, settings, 'pdf')).rejects.toThrow(
      'The download of chat.pdf could not be started'
    );
  });

  it('rejects an unsupported format', async () => {
    await expect(exportChatToFormat(messages, settings, 'docx-ish')).rejects.toThrow(
      'Unsupported export format: docx-ish'
    );
  });
});
