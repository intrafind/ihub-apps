import {
  buildPageIndex,
  computePassageMatches,
  emptyPageIndex,
  flattenMatches,
  itemStringsOf,
  matchToItemSlices
} from '../../../client/src/features/documentPreview/utils/pdfPassageMatching.js';

/** Fake pdf.js text content: one entry per text item. */
function textContent(items) {
  return { items: items.map(([str, hasEOL = false]) => ({ str, hasEOL })) };
}

/**
 * Reconstructs what would be highlighted: the matched slices resolved back to
 * substrings of the text items the viewer draws boxes over.
 */
function highlighted(pageContents, result) {
  const out = [];
  result.pageMatches.forEach((positions, pageIdx) => {
    const itemStrings = itemStringsOf(pageContents[pageIdx]);
    positions.forEach((start, i) => {
      const length = result.pageMatchesLength[pageIdx][i];
      const text = matchToItemSlices(itemStrings, start, length)
        .map(slice => itemStrings[slice.itemIdx].slice(slice.start, slice.end))
        .join('');
      out.push({ pageIdx, text });
    });
  });
  return out;
}

describe('pdfPassageMatching', () => {
  describe('matchToItemSlices', () => {
    const itemStrings = ['Hello ', 'brave ', 'new ', 'world'];

    it('should return a single slice for a match inside one item', () => {
      expect(matchToItemSlices(itemStrings, 6, 5)).toEqual([{ itemIdx: 1, start: 0, end: 5 }]);
    });

    it('should split a match spanning several items', () => {
      // "brave new wo" starts at offset 6 and is 12 characters long
      expect(matchToItemSlices(itemStrings, 6, 12)).toEqual([
        { itemIdx: 1, start: 0, end: 6 },
        { itemIdx: 2, start: 0, end: 4 },
        { itemIdx: 3, start: 0, end: 2 }
      ]);
    });

    it('should clip partial slices at both ends', () => {
      // "llo brave ne"
      expect(matchToItemSlices(itemStrings, 2, 12)).toEqual([
        { itemIdx: 0, start: 2, end: 6 },
        { itemIdx: 1, start: 0, end: 6 },
        { itemIdx: 2, start: 0, end: 2 }
      ]);
    });

    it('should skip empty items instead of emitting zero-width slices', () => {
      expect(matchToItemSlices(['ab', '', 'cd'], 0, 4)).toEqual([
        { itemIdx: 0, start: 0, end: 2 },
        { itemIdx: 2, start: 0, end: 2 }
      ]);
    });

    it('should return nothing for a match beyond the page text', () => {
      expect(matchToItemSlices(itemStrings, 500, 10)).toEqual([]);
    });
  });

  describe('buildPageIndex', () => {
    it('should produce a shadow of the page text', () => {
      const index = buildPageIndex(
        textContent([
          ['Hello, ', false],
          ['World!', false]
        ])
      );
      expect(index.shadow.text).toBe('helloworld');
    });

    it('should tolerate items without a string', () => {
      const index = buildPageIndex({
        items: [{ str: 'ok' }, { type: 'beginMarkedContent' }, { str: 'ay' }]
      });
      expect(index.shadow.text).toBe('okay');
    });

    it('should produce an empty index for a page with no text', () => {
      expect(emptyPageIndex().shadow.text).toBe('');
    });
  });

  describe('itemStringsOf', () => {
    it('should keep empty items so indices stay aligned with the text layer', () => {
      // pdf.js's TextLayer pushes a textDiv for every item whose `str` is
      // defined — empty strings included. Dropping them here would shift every
      // slice index after the first empty item and highlight the wrong text.
      const page = textContent([
        ['First item. ', true],
        ['', true],
        ['Second item.', false]
      ]);
      expect(itemStringsOf(page)).toEqual(['First item. ', '', 'Second item.']);
    });

    it('should drop marked-content boundaries, which produce no textDiv', () => {
      expect(
        itemStringsOf({ items: [{ str: 'a' }, { type: 'beginMarkedContent' }, { str: 'b' }] })
      ).toEqual(['a', 'b']);
    });

    it('should resolve a match to the right item when an empty item precedes it', () => {
      const page = textContent([
        ['Preamble sentence here. ', true],
        ['', true],
        ['The clause that must be highlighted.', false]
      ]);
      const itemStrings = itemStringsOf(page);
      const result = computePassageMatches(
        ['The clause that must be highlighted.'],
        [buildPageIndex(page)]
      );

      const slices = matchToItemSlices(
        itemStrings,
        result.pageMatches[0][0],
        result.pageMatchesLength[0][0]
      );
      expect(slices).toEqual([{ itemIdx: 2, start: 0, end: 35 }]);
      expect(itemStrings[2].slice(0, 35)).toBe('The clause that must be highlighted');
    });
  });

  describe('end-to-end offset mapping', () => {
    it('should resolve a passage back to the exact text items', () => {
      const page = textContent([
        ['The contract ', false],
        ['shall remain ', false],
        ['valid until December 2027.', true],
        [' Unrelated trailing text.', false]
      ]);
      const result = computePassageMatches(
        ['shall remain valid until December 2027'],
        [buildPageIndex(page)]
      );

      expect(result.total).toBe(1);
      expect(highlighted([page], result)).toEqual([
        { pageIdx: 0, text: 'shall remain valid until December 2027' }
      ]);
    });

    it('should resolve a match that starts and ends mid-item', () => {
      const page = textContent([['Preamble text. The important clause is here. Epilogue.', false]]);
      const result = computePassageMatches(
        ['The important clause is here.'],
        [buildPageIndex(page)]
      );

      expect(highlighted([page], result)).toEqual([
        { pageIdx: 0, text: 'The important clause is here' }
      ]);
    });

    it('should resolve a cross-page passage to slices on both pages', () => {
      const pages = [
        textContent([['Page one ends with the beginning of the ', false]]),
        textContent([['passage and page two carries it on. Rest.', false]])
      ];
      const result = computePassageMatches(
        ['ends with the beginning of the passage and page two carries it on'],
        pages.map(buildPageIndex)
      );

      expect(result.total).toBe(2);
      expect(highlighted(pages, result)).toEqual([
        { pageIdx: 0, text: 'ends with the beginning of the' },
        { pageIdx: 1, text: 'passage and page two carries it on' }
      ]);
    });

    it('should resolve through end-of-line markers between items', () => {
      const page = textContent([
        ['Die Kündigungsfrist', true],
        ['beträgt drei Monate.', false]
      ]);
      const result = computePassageMatches(
        ['Die Kündigungsfrist beträgt drei Monate'],
        [buildPageIndex(page)]
      );

      expect(result.total).toBe(1);
      // The synthetic newline is not part of the text layer, so the two items
      // are highlighted back-to-back with nothing in between.
      expect(highlighted([page], result)).toEqual([
        { pageIdx: 0, text: 'Die Kündigungsfristbeträgt drei Monate' }
      ]);
    });

    it('should resolve a hyphenated line break to the full source span', () => {
      const page = textContent([
        ['Ver-', true],
        ['trag gilt ab sofort.', false]
      ]);
      const result = computePassageMatches(['Vertrag gilt ab sofort'], [buildPageIndex(page)]);

      expect(result.total).toBe(1);
      expect(highlighted([page], result)).toEqual([
        { pageIdx: 0, text: 'Ver-trag gilt ab sofort' }
      ]);
    });
  });

  describe('flattenMatches', () => {
    it('should flatten per-page matches into document order', () => {
      const flat = flattenMatches({
        pageMatches: [[10], [], [3, 40]],
        pageMatchesLength: [[5], [], [7, 2]]
      });
      expect(flat).toEqual([
        { pageIdx: 0, matchIdx: 0, start: 10, length: 5 },
        { pageIdx: 2, matchIdx: 0, start: 3, length: 7 },
        { pageIdx: 2, matchIdx: 1, start: 40, length: 2 }
      ]);
    });
  });
});
