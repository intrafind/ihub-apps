import {
  normalize,
  buildShadow,
  splitIntoFragments,
  computePassageMatches
} from '../../../client/src/features/documentPreview/utils/passageMatcher.js';

/**
 * Builds the page structures the matcher expects from raw text-layer
 * strings, the same way the viewer does after text extraction.
 */
function makePages(rawPageTexts) {
  return rawPageTexts.map(raw => {
    const [content, diffs] = normalize(raw);
    return { shadow: buildShadow(content), diffs };
  });
}

/**
 * Resolves the matches back to substrings of the text-layer content, which
 * is exactly what gets highlighted. Newlines in the extraction buffer are
 * synthetic EOL markers (pushed for `hasEOL`) that do not exist in the text
 * layer DOM, so the diff coordinates produced by normalize() are relative to
 * the page text without them.
 */
function highlightedSnippets(rawPageTexts, result) {
  const domTexts = rawPageTexts.map(raw => raw.replace(/\n/g, ''));
  const snippets = [];
  result.pageMatches.forEach((positions, pageIdx) => {
    positions.forEach((start, i) => {
      const length = result.pageMatchesLength[pageIdx][i];
      snippets.push(domTexts[pageIdx].slice(start, start + length));
    });
  });
  return snippets;
}

describe('passageMatcher', () => {
  describe('buildShadow', () => {
    it('should keep only letters and digits, lowercased', () => {
      const { text } = buildShadow('Ab, c – 12!');
      expect(text).toBe('abc12');
    });

    it('should map shadow characters back to source offsets', () => {
      const { text, mapStart, mapEnd } = buildShadow('Ab, c');
      expect(text).toBe('abc');
      expect(mapStart).toEqual([0, 1, 4]);
      expect(mapEnd).toEqual([1, 2, 5]);
    });

    it('should expand ligatures via NFKC folding', () => {
      const { text, mapStart, mapEnd } = buildShadow('ﬁle');
      expect(text).toBe('file');
      // both expanded characters point at the single source ligature
      expect(mapStart).toEqual([0, 0, 1, 2]);
      expect(mapEnd).toEqual([1, 1, 2, 3]);
    });

    it('should drop combining marks of decomposed umlauts', () => {
      const [normalized] = normalize('Müller');
      expect(buildShadow(normalized).text).toBe('muller');
    });

    it('should keep non-Latin scripts', () => {
      expect(buildShadow('Договор 2027').text).toBe('договор2027');
      expect(buildShadow('契約期間は二年間').text).toBe('契約期間は二年間');
    });
  });

  describe('splitIntoFragments', () => {
    it('should split on sentence boundaries', () => {
      const fragments = splitIntoFragments(
        'The first sentence is here. The second sentence follows. '
      );
      expect(fragments).toHaveLength(2);
      expect(fragments[0]).toContain('first sentence');
      expect(fragments[1]).toContain('second sentence');
    });

    it('should merge fragments that are too short to be unambiguous', () => {
      const fragments = splitIntoFragments(
        'Yes. No. This second part makes the fragment long enough to match.'
      );
      expect(fragments).toHaveLength(1);
    });
  });

  describe('computePassageMatches', () => {
    it('should match despite whitespace, quote and newline differences', () => {
      const raw = 'The quick\nbrown fox jumps over the “lazy” dog. More text.';
      const pages = makePages([raw]);
      const passage = 'The quick brown fox — jumps, over the "lazy" dog.';

      const result = computePassageMatches([passage], pages);

      expect(result.total).toBe(1);
      expect(result.firstMatchPageIdx).toBe(0);
      const [snippet] = highlightedSnippets([raw], result);
      // 'quick\nbrown' collapses to 'quickbrown' in text-layer coordinates
      expect(snippet).toContain('quickbrown fox');
      expect(snippet).toContain('“lazy” dog');
    });

    it('should map matches back through hyphenation-at-line-break removal', () => {
      const raw = 'Ver-\ntrag gilt ab sofort und bleibt bestehen.';
      const pages = makePages([raw]);

      const result = computePassageMatches(['Vertrag gilt ab sofort'], pages);

      expect(result.total).toBe(1);
      expect(highlightedSnippets([raw], result)).toEqual(['Ver-trag gilt ab sofort']);
    });

    it('should match a passage that contains ligatures against expanded page text', () => {
      const raw = 'The final configuration file was modified yesterday.';
      const pages = makePages([raw]);

      const result = computePassageMatches(['The ﬁnal conﬁguration ﬁle was modiﬁed'], pages);

      expect(result.total).toBe(1);
      expect(highlightedSnippets([raw], result)).toEqual([
        'The final configuration file was modified'
      ]);
    });

    it('should match despite a spurious space inside a word in the text layer', () => {
      const raw = 'Die Kündigungs frist beträgt drei Monate ab Zugang.';
      const pages = makePages([raw]);

      const result = computePassageMatches(['Die Kündigungsfrist beträgt drei Monate'], pages);

      expect(result.total).toBe(1);
    });

    it('should match Cyrillic passages at the correct position only', () => {
      const raw =
        'Преамбула документа описывает стороны. Договор действует до декабря 2027 года. Прочее.';
      const pages = makePages([raw]);

      const result = computePassageMatches(['Договор действует до декабря 2027 года.'], pages);

      expect(result.total).toBe(1);
      expect(highlightedSnippets([raw], result)).toEqual([
        'Договор действует до декабря 2027 года'
      ]);
    });

    it('should match CJK passages', () => {
      const raw = '会社概要の説明。第三条 契約期間は二年間とする。以上。';
      const pages = makePages([raw]);

      const result = computePassageMatches(['第三条 契約期間は二年間とする。'], pages);

      expect(result.total).toBe(1);
      expect(highlightedSnippets([raw], result)).toEqual(['第三条 契約期間は二年間とする']);
    });

    it('should match a passage crossing a clean page break', () => {
      const rawPages = [
        'Intro text on page one. This contract shall remain valid until ',
        'December 2027 and renews automatically. Other text.'
      ];
      const pages = makePages(rawPages);

      const result = computePassageMatches(
        ['This contract shall remain valid until December 2027 and renews automatically.'],
        pages
      );

      expect(result.total).toBe(2);
      expect(result.firstMatchPageIdx).toBe(0);
      expect(result.pageMatches[0]).toHaveLength(1);
      expect(result.pageMatches[1]).toHaveLength(1);
      const snippets = highlightedSnippets(rawPages, result);
      expect(snippets[0]).toContain('shall remain valid until');
      expect(snippets[1]).toContain('December 2027 and renews automatically');
    });

    it('should partially highlight a passage interrupted by a page footer', () => {
      const rawPages = [
        'Intro. The first sentence about the contract terms is complete here. The second sentence begins with details ',
        'Page 2 of 15\nabout the renewal and ends here. The third sentence is also fully on page two.'
      ];
      const pages = makePages(rawPages);

      const result = computePassageMatches(
        [
          'The first sentence about the contract terms is complete here. ' +
            'The second sentence begins with details about the renewal and ends here. ' +
            'The third sentence is also fully on page two.'
        ],
        pages
      );

      // full match is impossible (footer interrupts sentence two), but the
      // surrounding sentences and both halves of the broken one are found
      expect(result.total).toBeGreaterThanOrEqual(2);
      const snippets = highlightedSnippets(rawPages, result).join(' | ');
      expect(snippets).toContain('first sentence about the contract terms is complete here');
      expect(snippets).toContain('third sentence is also fully on page two');
      expect(snippets).not.toContain('Page 2 of 15');
    });

    it('should span an empty middle page without failing or looping', () => {
      const rawPages = [
        'Text before the image page ends with the first part of the passage ',
        '',
        'and the second part of the passage continues on page three.'
      ];
      const pages = makePages(rawPages);

      const result = computePassageMatches(
        ['ends with the first part of the passage and the second part of the passage continues'],
        pages
      );

      expect(result.total).toBe(2);
      expect(result.pageMatches[1]).toHaveLength(0);
    });

    it('should highlight every occurrence of a repeated passage', () => {
      const raw =
        'The same disclaimer text appears twice. Some middle part. The same disclaimer text appears twice.';
      const pages = makePages([raw]);

      const result = computePassageMatches(['The same disclaimer text appears twice.'], pages);

      expect(result.total).toBe(2);
    });

    it('should support multiple passages', () => {
      const raw =
        'First interesting statement here. Unrelated filler text. Second interesting statement there.';
      const pages = makePages([raw]);

      const result = computePassageMatches(
        ['First interesting statement here.', 'Second interesting statement there.'],
        pages
      );

      expect(result.total).toBe(2);
    });

    it('should return no matches for empty or blank passages', () => {
      const pages = makePages(['Some page content that could match.']);

      const result = computePassageMatches(['', '   ', '\n'], pages);

      expect(result.total).toBe(0);
      expect(result.firstMatchPageIdx).toBe(-1);
    });

    it('should return no matches when the passage text does not occur', () => {
      const pages = makePages(['Completely different page content.']);

      const result = computePassageMatches(
        ['This text is definitely not part of the document.'],
        pages
      );

      expect(result.total).toBe(0);
      expect(result.firstMatchPageIdx).toBe(-1);
    });

    it('should merge overlapping ranges from multiple passages', () => {
      const raw = 'A shared region of text that two passages both cover fully.';
      const pages = makePages([raw]);

      const result = computePassageMatches(
        [
          'A shared region of text that two passages',
          'region of text that two passages both cover fully.'
        ],
        pages
      );

      expect(result.total).toBe(1);
      expect(result.pageMatches[0]).toHaveLength(1);
    });
  });
});
