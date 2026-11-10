// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `focus` on the search tools (#3511): with `extractContent`, a result page
 * longer than `contentMaxLength` contributes the sections that answer the
 * question instead of its first characters. Without `focus`, or without
 * `extractContent`, nothing changes. Each result carries sections only: no
 * outline per page.
 */

import { jest } from '@jest/globals';

const throttledFetchMock = jest.fn();

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: throttledFetchMock,
  registerThrottleHints: () => null
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

function longPage() {
  let body = '<h1>Product manual</h1><p>Welcome to the manual of the product.</p>';
  for (let i = 1; i <= 12; i++) body += `<h2>Chapter ${i}</h2>${paragraph(i)}${paragraph(i + 100)}`;
  body += '<h2>Pricing details</h2><p>The enterprise plan costs 4711 euros per seat.</p>';
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
const freshUrl = () => `http://93.184.216.34/search-focus-${++counter}`;

describe('search extraction with a focus', () => {
  let searchWithExtraction;
  let url;

  beforeEach(async () => {
    jest.resetAllMocks();
    throttledFetchMock.mockResolvedValue(htmlResponse(longPage()));
    ({ default: searchWithExtraction } = await import('../tools/lib/searchWithExtraction.js'));
    const { default: webSearchService, SearchProvider } =
      await import('../services/WebSearchService.js');
    url = freshUrl();
    class FakeEngine extends SearchProvider {
      getName() {
        return 'focus-engine';
      }
      async search() {
        return { results: [{ title: 'Manual', url, description: 'The product manual' }] };
      }
    }
    webSearchService.registerProvider(new FakeEngine());
  });

  const run = extra =>
    searchWithExtraction({
      query: 'enterprise plan price',
      provider: 'focus-engine',
      component: 'Test',
      extractContent: true,
      contentMaxLength: 3000,
      ...extra
    });

  test('a page longer than contentMaxLength contributes the section that answers the question', async () => {
    const plain = (await run()).extractedContent[0].extractedContent;
    expect(plain.content).not.toContain('4711');
    expect(plain.excerpted).toBeUndefined();

    const focused = (await run({ focus: 'enterprise plan price per seat' })).extractedContent[0];
    expect(focused.contentExtracted).toBe(true);
    expect(focused.extractedContent.content).toContain('The enterprise plan costs 4711 euros');
    expect(focused.extractedContent.excerpted).toBe(true);
    expect(focused.extractedContent.content.length).toBeLessThanOrEqual(3000);
    expect(focused.extractedContent.content).not.toMatch(/Outline/);
    expect(focused.extractedContent.note).not.toMatch(/outline/i);
  });

  test('without a focus the extraction is what it was', async () => {
    const first = (await run()).extractedContent[0].extractedContent;
    for (const focus of [undefined, '', '   ']) {
      const again = (await run({ focus })).extractedContent[0].extractedContent;
      expect(again.content).toBe(first.content);
      expect(again.excerpted).toBeUndefined();
    }
  });

  test('a focus that matches nothing reads the page from its start, without an outline', async () => {
    const plain = (await run()).extractedContent[0].extractedContent;
    const none = (await run({ focus: 'zzzqqq' })).extractedContent[0].extractedContent;
    expect(none.content).toBe(plain.content);
    expect(none.excerpted).toBeUndefined();
    expect(none.nextOffset).toBe(plain.nextOffset);
  });

  test('a focus without extractContent does nothing', async () => {
    const result = await run({ extractContent: false, focus: 'enterprise plan' });
    expect(result.extractedContent).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect(throttledFetchMock).not.toHaveBeenCalled();
  });
});
