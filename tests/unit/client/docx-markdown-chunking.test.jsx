/**
 * HTML → Markdown of extracted Word documents is converted in chunks of top-level blocks
 * (concepts/document-extraction/, T-PERF-01).
 *
 * Turndown joins block after block by copying the whole output so far, so one call for a long
 * document is quadratic: measured in Chromium, 5,000 paragraphs took 1.1 s and 20,000 took
 * 12.6 s (mammoth alone: 0.6 s). Timing cannot guard this in jsdom — its linear DOM costs hide
 * the quadratic part at any size jest can afford — so the mechanism is tested: no call gets
 * more than a chunk, and chunking changes nothing in the text.
 */
import '@testing-library/jest-dom';

const TurndownService = require('turndown');
const {
  createDocumentMarkdownConverter,
  htmlToMarkdown,
  normalizeMarkdown
} = require('../../../shared/documentExtraction/markdown.js');

const Turndown = TurndownService.default || TurndownService;

/** What mammoth produces: headings, paragraphs, lists, a table and footnotes. */
const mixedHtml = blocks => {
  let html = '';
  for (let i = 0; i < blocks; i += 1) {
    if (i % 40 === 0) html += `<h1>Kapitel ${i}</h1>`;
    if (i % 25 === 0)
      html += '<ol><li>Erstens</li><li>Zweitens<ol><li>Unterpunkt</li></ol></li></ol>';
    if (i % 60 === 0) html += `<table><tr><td><p>A${i}</p></td><td><p>B</p></td></tr></table>`;
    html += `<p>Absatz ${i} mit <strong>Betonung</strong>.<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup></p>`;
  }
  return `${html}<ol><li id="footnote-1"><p>Fussnote <a href="#footnote-ref-1">↑</a></p></li></ol>`;
};

describe('htmlToMarkdown', () => {
  it('T-PERF-01: never hands Turndown more than a chunk of top-level blocks', () => {
    const service = createDocumentMarkdownConverter(Turndown);
    const turndown = jest.spyOn(service, 'turndown');
    htmlToMarkdown(service, mixedHtml(1000), DOMParser);

    const calls = turndown.mock.calls.map(([input]) => input);
    // Table cells and footnote definitions are converted by their own, small calls.
    const documentCalls = calls.filter(
      input => input.nodeType === 1 && input.childNodes.length > 5
    );
    expect(documentCalls.length).toBeGreaterThan(10);
    for (const input of documentCalls) expect(input.childNodes.length).toBeLessThanOrEqual(100);
  });

  it('T-PERF-01: chunking changes nothing in the text', () => {
    const html = mixedHtml(1000);
    const chunked = normalizeMarkdown(
      htmlToMarkdown(createDocumentMarkdownConverter(Turndown), html, DOMParser)
    );
    const wholeService = createDocumentMarkdownConverter(Turndown);
    const whole = normalizeMarkdown(wholeService.turndown(html));
    expect(chunked).toBe(whole);
    // Spot checks that the comparison compares something.
    expect(chunked).toContain('# Kapitel 0');
    expect(chunked).toContain('1. Erstens\n2. Zweitens\n  1. Unterpunkt');
    expect(chunked).toContain('| A0 | B |');
    expect(chunked).toContain('[^1]: Fussnote');
  });

  it('keeps an empty document empty', () => {
    const service = createDocumentMarkdownConverter(Turndown);
    expect(normalizeMarkdown(htmlToMarkdown(service, '', DOMParser))).toBe('');
  });
});
