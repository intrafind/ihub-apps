// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `read_url` with a `focus` (#3511): a long page returns the sections that
 * answer the question, verbatim, with an outline of the page, instead of its
 * first window. Without a focus nothing changes. The page still comes through
 * the guarded fetch and the page cache.
 */

import { jest } from '@jest/globals';

const throttledFetchMock = jest.fn();

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: throttledFetchMock
}));

jest.unstable_mockModule('../services/loop/RunStream.js', () => ({
  emitToolProgress: () => null
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({ ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] } })
  }
}));

const paragraph = n =>
  `<p>${`Lorem ipsum dolor sit amet number ${n}, consectetur adipiscing elit. `.repeat(40)}</p>`;

/** Twelve long chapters, then a short section holding the answer. */
function longPage({
  answer = 'The enterprise plan costs 4711 euros per seat and includes quasar support.'
} = {}) {
  let body = '<h1>Product manual</h1><p>Welcome to the manual of the product.</p>';
  for (let i = 1; i <= 12; i++) body += `<h2>Chapter ${i}</h2>${paragraph(i)}${paragraph(i + 100)}`;
  body += `<h2>Pricing details</h2><p>${answer}</p>`;
  return `<html><head><title>Product manual</title></head><body><main><article>${body}</article></main></body></html>`;
}

function htmlResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: name => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => body
  };
}

let counter = 0;
/** A public address that no earlier test has put into the page cache. */
const freshUrl = () => `http://93.184.216.34/manual-${++counter}`;

describe('read_url with a focus', () => {
  let extractForTool;
  let runToolCallScope;

  beforeEach(async () => {
    jest.resetAllMocks();
    ({ extractForTool } = await import('../tools/webContentExtractor.js'));
    ({ runToolCallScope } = await import('../services/sources/toolCallScope.js'));
  });

  test('returns the section that answers the question, even beyond the first window', async () => {
    throttledFetchMock.mockResolvedValue(htmlResponse(longPage()));
    const url = freshUrl();

    const plain = await extractForTool({ url });
    expect(plain.truncated).toBe(true);
    expect(plain.content).not.toContain('quasar');
    expect(plain.excerpted).toBeUndefined();

    const focused = await extractForTool({ url, focus: 'quasar support price per seat' });
    expect(focused.content).toContain('includes quasar support.');
    expect(focused.content).toMatch(/Outline of the whole text/);
    expect(focused.content).toMatch(/<section id="pricing-details"[^>]* offset="\d+"/);
    expect(focused.content.length).toBeLessThanOrEqual(10000);
    expect(focused.excerpted).toBe(true);
    expect(focused.truncated).toBe(true);
    expect(focused.offset).toBe(0);
    expect(focused.focus).toBe('quasar support price per seat');
    expect(focused.title).toBe(plain.title);
    expect(focused.totalLength).toBe(plain.totalLength);
    expect(focused.note).toMatch(/selection of the page/);
    // One fetch served both reads: the page cache and the guarded fetch are unchanged.
    expect(throttledFetchMock).toHaveBeenCalledTimes(1);
  });

  test('the offset an outline entry names reads from that section', async () => {
    throttledFetchMock.mockResolvedValue(htmlResponse(longPage()));
    const url = freshUrl();
    const focused = await extractForTool({ url, focus: 'quasar support price' });
    const offset = Number(
      /<section id="pricing-details"[^>]* offset="(\d+)"/.exec(focused.content)[1]
    );
    const read = await extractForTool({ url, offset, focus: 'quasar support price' });
    expect(read.excerpted).toBeUndefined();
    expect(read.content.startsWith('## Pricing details')).toBe(true);
    expect(read.content).toContain('includes quasar support.');
  });

  test('without a focus the result is unchanged, an empty one included', async () => {
    throttledFetchMock.mockResolvedValue(htmlResponse(longPage()));
    const url = freshUrl();
    const strip = ({ extractedAt: _at, ...rest }) => rest;
    const plain = strip(await extractForTool({ url }));
    expect(strip(await extractForTool({ url, focus: '' }))).toEqual(plain);
    expect(strip(await extractForTool({ url, focus: '   ' }))).toEqual(plain);
    expect(strip(await extractForTool({ url, focus: 42 }))).toEqual(plain);
    expect(Object.keys(plain)).not.toContain('focus');
    expect(Object.keys(plain)).not.toContain('excerpted');
  });

  test('a page that fits in maxLength is returned whole, whatever the focus', async () => {
    throttledFetchMock.mockResolvedValue(
      htmlResponse(
        '<html><head><title>Short</title></head><body><main><h1>Short</h1><p>A short page about quasar support, long enough to be read by the extractor as the main content of the page.</p></main></body></html>'
      )
    );
    const url = freshUrl();
    const plain = await extractForTool({ url });
    const focused = await extractForTool({ url, focus: 'quasar' });
    expect(focused.content).toBe(plain.content);
    expect(focused.excerpted).toBeUndefined();
  });

  test('an explicit offset is paging, not a question', async () => {
    throttledFetchMock.mockResolvedValue(htmlResponse(longPage()));
    const url = freshUrl();
    const paged = await extractForTool({ url, offset: 5000 });
    const focused = await extractForTool({ url, offset: 5000, focus: 'quasar' });
    expect(focused.content).toBe(paged.content);
    expect(focused.nextOffset).toBe(paged.nextOffset);
  });

  test('a focus that matches nothing gives the start of the page and an outline', async () => {
    throttledFetchMock.mockResolvedValue(htmlResponse(longPage()));
    const url = freshUrl();
    const plain = await extractForTool({ url });
    const focused = await extractForTool({ url, focus: 'zzzqqq' });
    expect(focused.excerpted).toBe(false);
    expect(focused.note).toMatch(/No section of the page matches/);
    expect(focused.content).toMatch(/Outline of the whole page/);
    expect(focused.content).toMatch(/chapter-12: Chapter 12 @\d+/);
    expect(focused.content.startsWith(plain.content.slice(0, 500))).toBe(true);
    expect(focused.content.length).toBeLessThanOrEqual(10000);
    expect(focused.nextOffset).toBeGreaterThan(0);
  });

  test('maxLength bounds the whole result, outline included', async () => {
    throttledFetchMock.mockResolvedValue(htmlResponse(longPage()));
    const url = freshUrl();
    for (const maxLength of [500, 1500, 4000, 20000]) {
      const focused = await extractForTool({ url, focus: 'quasar support price', maxLength });
      expect(focused.content.length).toBeLessThanOrEqual(maxLength);
      expect(focused.excerpted).toBe(true);
    }
  });

  test('a focus is trimmed and cut at 500 characters', async () => {
    throttledFetchMock.mockResolvedValue(htmlResponse(longPage()));
    const url = freshUrl();
    const focused = await extractForTool({
      url,
      focus: `   quasar support price ${'x'.repeat(2000)}`
    });
    expect(focused.focus.length).toBeLessThanOrEqual(500);
    expect(focused.focus.startsWith('quasar support price')).toBe(true);
  });

  test('the passages the model got are reported for the sources panel, privately', async () => {
    throttledFetchMock.mockResolvedValue(htmlResponse(longPage()));
    const url = freshUrl();
    const reported = [];
    await runToolCallScope(reported, () => extractForTool({ url, focus: 'quasar support price' }));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ provider: 'web', kind: 'page', url, private: true });
    expect(reported[0].passages[0].text).toMatch(/^Pricing details\n## Pricing details/);
    expect(reported[0].passages[0].text).toContain('includes quasar support.');

    const none = [];
    await runToolCallScope(none, () => extractForTool({ url }));
    expect(none).toEqual([]);
  });
});
