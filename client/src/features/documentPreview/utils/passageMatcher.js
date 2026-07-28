/**
 * Text matching for passage highlighting in the PDF document preview.
 *
 * Ported unchanged in behaviour from the iFinder searchbar
 * (`app/features/PdfJs/passageMatcher.js`, intrafind/ifinder#2655) so both
 * products highlight passages identically. Only formatting was adapted to this
 * repository's Prettier config — keep the algorithm in sync with iFinder.
 *
 * Passages are substrings of the fulltext the converter extracted into the
 * search index, while the preview is a *generated* PDF whose text layer can
 * differ from that fulltext in whitespace, punctuation, ligatures, page
 * furniture (headers/footers) and even spurious spaces inside words. Matching
 * therefore happens on a "shadow text": both sides are reduced to their
 * Unicode letters and digits only (NFKC-folded, lowercased), with an offset
 * map back to the original text-layer coordinates. Searching the shadow with
 * `indexOf` is linear in the document size — unlike a regex approach, it
 * cannot backtrack catastrophically on large documents.
 *
 * When a passage cannot be found as a whole (e.g. it crosses a page break
 * and the generated PDF inserts a footer there), it is split into
 * sentence-like fragments that are matched individually, so the passage is
 * still highlighted partially instead of not at all.
 */

const CHARACTERS_TO_NORMALIZE = {
  '‐': '-',
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '¼': '1/4',
  '½': '1/2',
  '¾': '3/4'
};
const DIACRITICS_REG_EXP = /\p{M}+/gu;
// Hangul syllables plus the CJK compatibility ideographs that decompose to
// astral-plane characters. Written with \u escapes on purpose: as literal
// characters the compatibility ideographs decompose under NFD into surrogate
// pairs, which turns this character class into a syntax error ("range out of
// order"). Keep the escapes when syncing this file.
const SYLLABLES_REG_EXP = /[\uAC00-\uD7AF\uFA6C\uFACF-\uFAD1\uFAD5-\uFAD7]+/g;
const SYLLABLES_LENGTHS = new Map();
const FIRST_CHAR_SYLLABLES_REG_EXP =
  '[\\u1100-\\u1112\\ud7a4-\\ud7af\\ud84a\\ud84c\\ud850\\ud854\\ud857\\ud85f]';
const NFKC_CHARS_TO_NORMALIZE = new Map();
let noSyllablesRegExp = null;
let withSyllablesRegExp = null;

/**
 * Normalizes text the same way pdf.js prepares page text for matching (NFD,
 * quote/hyphen folding, hyphenation-at-line-break removal, newline handling)
 * and returns a position diff array that maps normalized offsets back to the
 * original string.
 *
 * @param {string} text
 * @returns {[string, Array<[number, number]>, boolean]} normalized text,
 *   position diffs and whether the text contains diacritics.
 */
function normalize(text) {
  const syllablePositions = [];
  let m;
  while ((m = SYLLABLES_REG_EXP.exec(text)) !== null) {
    let { index } = m;
    for (const char of m[0]) {
      let len = SYLLABLES_LENGTHS.get(char);
      if (!len) {
        len = char.normalize('NFD').length;
        SYLLABLES_LENGTHS.set(char, len);
      }
      syllablePositions.push([len, index++]);
    }
  }
  let normalizationRegex;
  if (syllablePositions.length === 0 && noSyllablesRegExp) {
    normalizationRegex = noSyllablesRegExp;
  } else if (syllablePositions.length > 0 && withSyllablesRegExp) {
    normalizationRegex = withSyllablesRegExp;
  } else {
    const replace = Object.keys(CHARACTERS_TO_NORMALIZE).join('');
    const toNormalizeWithNFKC = '①-⑳' + 'Ⓐ-⓿' + '㉄-㊿' + '㋐-㋾' + '＀-￯';
    const CJK = '(?:\\p{Ideographic}|[぀-ヿ])';
    const regexp = `([${replace}])|([${toNormalizeWithNFKC}])|(\\p{M}+(?:-\\n)?)|(\\S-\\n)|(${CJK}\\n)|(\\n)`;
    if (syllablePositions.length === 0) {
      normalizationRegex = noSyllablesRegExp = new RegExp(`${regexp}|(\\u0000)`, 'gum');
    } else {
      normalizationRegex = withSyllablesRegExp = new RegExp(
        `${regexp}|(${FIRST_CHAR_SYLLABLES_REG_EXP})`,
        'gum'
      );
    }
  }
  const rawDiacriticsPositions = [];
  while ((m = DIACRITICS_REG_EXP.exec(text)) !== null) {
    rawDiacriticsPositions.push([m[0].length, m.index]);
  }
  let normalized = text.normalize('NFD');
  const positions = [[0, 0]];
  let rawDiacriticsIndex = 0;
  let syllableIndex = 0;
  let shift = 0;
  let shiftOrigin = 0;
  let eol = 0;
  let hasDiacritics = false;
  normalized = normalized.replace(normalizationRegex, (match, p1, p2, p3, p4, p5, p6, p7, i) => {
    i -= shiftOrigin;
    if (p1) {
      const replacement = CHARACTERS_TO_NORMALIZE[p1];
      const jj = replacement.length;
      for (let j = 1; j < jj; j++) {
        positions.push([i - shift + j, shift - j]);
      }
      shift -= jj - 1;
      return replacement;
    }
    if (p2) {
      let replacement = NFKC_CHARS_TO_NORMALIZE.get(p2);
      if (!replacement) {
        replacement = p2.normalize('NFKC');
        NFKC_CHARS_TO_NORMALIZE.set(p2, replacement);
      }
      const jj = replacement.length;
      for (let j = 1; j < jj; j++) {
        positions.push([i - shift + j, shift - j]);
      }
      shift -= jj - 1;
      return replacement;
    }
    if (p3) {
      const hasTrailingDashEOL = p3.endsWith('\n');
      const len = hasTrailingDashEOL ? p3.length - 2 : p3.length;
      hasDiacritics = true;
      let jj = len;
      if (i + eol === rawDiacriticsPositions[rawDiacriticsIndex]?.[1]) {
        jj -= rawDiacriticsPositions[rawDiacriticsIndex][0];
        ++rawDiacriticsIndex;
      }
      for (let j = 1; j <= jj; j++) {
        positions.push([i - 1 - shift + j, shift - j]);
      }
      shift -= jj;
      shiftOrigin += jj;
      if (hasTrailingDashEOL) {
        i += len - 1;
        positions.push([i - shift + 1, 1 + shift]);
        shift += 1;
        shiftOrigin += 1;
        eol += 1;
        return p3.slice(0, len);
      }
      return p3;
    }
    if (p4) {
      positions.push([i - shift + 1, 1 + shift]);
      shift += 1;
      shiftOrigin += 1;
      eol += 1;
      return p4.charAt(0);
    }
    if (p5) {
      positions.push([i - shift + 1, shift]);
      shiftOrigin += 1;
      eol += 1;
      return p5.charAt(0);
    }
    if (p6) {
      positions.push([i - shift + 1, shift - 1]);
      shift -= 1;
      shiftOrigin += 1;
      eol += 1;
      return ' ';
    }
    if (i + eol === syllablePositions[syllableIndex]?.[1]) {
      const newCharLen = syllablePositions[syllableIndex][0] - 1;
      ++syllableIndex;
      for (let j = 1; j <= newCharLen; j++) {
        positions.push([i - (shift - j), shift - j]);
      }
      shift -= newCharLen;
      shiftOrigin += newCharLen;
    }
    return p7;
  });
  positions.push([normalized.length, shift]);
  return [normalized, positions, hasDiacritics];
}

function binarySearchFirstItem(items, condition, start = 0) {
  let minIndex = start;
  let maxIndex = items.length - 1;
  if (maxIndex < 0 || !condition(items[maxIndex])) {
    return items.length;
  }
  if (condition(items[minIndex])) {
    return minIndex;
  }
  while (minIndex < maxIndex) {
    const currentIndex = (minIndex + maxIndex) >> 1;
    const currentItem = items[currentIndex];
    if (condition(currentItem)) {
      maxIndex = currentIndex;
    } else {
      minIndex = currentIndex + 1;
    }
  }
  return minIndex;
}

/**
 * Maps a position/length in normalized text back to the original text via
 * the diffs produced by {@link normalize}.
 *
 * @param {Array<[number, number]>|null} diffs
 * @param {number} pos
 * @param {number} len
 * @returns {[number, number]} position and length in the original text.
 */
function getOriginalIndex(diffs, pos, len) {
  if (!diffs) {
    return [pos, len];
  }
  const start = pos;
  const end = pos + len;
  let i = binarySearchFirstItem(diffs, x => x[0] >= start);
  if (diffs[i][0] > start) {
    --i;
  }
  let j = binarySearchFirstItem(diffs, x => x[0] >= end, i);
  if (diffs[j][0] > end) {
    --j;
  }
  return [start + diffs[i][1], len + diffs[j][1] - diffs[i][1]];
}

const SHADOW_CHAR_REG_EXP = /[\p{L}\p{N}]/u;
const NON_ALPHANUMERIC_REG_EXP = /[^\p{L}\p{N}]/gu;
const SENTENCE_REG_EXP = /[^.!?…]+[.!?…]*\s*/g;

// Cap on how many occurrences of the same passage text get highlighted, so a
// passage consisting of boilerplate repeated hundreds of times stays cheap.
const MAX_PASSAGE_OCCURRENCES = 50;
// Fragments shorter than this (in shadow characters) are too ambiguous to
// match on their own and get merged with their neighbors.
const MIN_FRAGMENT_SHADOW_LENGTH = 15;

/**
 * Reduces text to its letters and digits only (NFKC-folded, lowercased) and
 * keeps a per-character map back to the input coordinates. NFKC folding makes
 * ligatures ("ﬁ" vs. "fi"), full-width forms and similar compatibility
 * characters comparable across the converter fulltext and the PDF text layer.
 *
 * @param {string} text
 * @returns {{text: string, mapStart: number[], mapEnd: number[]}} the shadow
 *   text plus, per shadow character, the start (inclusive) and end
 *   (exclusive) offsets of the source character in `text`.
 */
export function buildShadow(text) {
  const parts = [];
  const mapStart = [];
  const mapEnd = [];
  let index = 0;
  for (const char of text) {
    const charLength = char.length;
    if (SHADOW_CHAR_REG_EXP.test(char)) {
      const folded = char.normalize('NFKC').toLowerCase().replace(NON_ALPHANUMERIC_REG_EXP, '');
      for (let j = 0; j < folded.length; j += 1) {
        mapStart.push(index);
        mapEnd.push(index + charLength);
      }
      parts.push(folded);
    }
    index += charLength;
  }
  return { text: parts.join(''), mapStart, mapEnd };
}

function shadowLength(text) {
  return buildShadow(text).text.length;
}

function findAllOccurrences(haystack, needle) {
  const positions = [];
  let pos = haystack.indexOf(needle);
  while (pos !== -1 && positions.length < MAX_PASSAGE_OCCURRENCES) {
    positions.push(pos);
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return positions;
}

/**
 * Splits a normalized passage into sentence-like fragments suitable for
 * partial matching. Sentences too short to be unambiguous are merged with the
 * following sentence; fragments that still fail to match are subdivided
 * further by {@link computePassageMatches}.
 *
 * @param {string} normalizedText
 * @returns {string[]}
 */
export function splitIntoFragments(normalizedText) {
  const sentences = normalizedText.match(SENTENCE_REG_EXP) || [normalizedText];

  const fragments = [];
  let pending = '';
  for (const sentence of sentences) {
    pending = pending ? `${pending} ${sentence}` : sentence;
    if (shadowLength(pending) >= MIN_FRAGMENT_SHADOW_LENGTH) {
      fragments.push(pending);
      pending = '';
    }
  }
  if (pending) {
    if (fragments.length) {
      fragments[fragments.length - 1] += ` ${pending}`;
    } else {
      fragments.push(pending);
    }
  }
  return fragments;
}

function shadowRangeToPageRanges(start, end, pages, pageShadowOffsets) {
  const result = [];
  let pageIdx = binarySearchFirstItem(pageShadowOffsets, x => x > start) - 1;
  if (pageIdx < 0) {
    pageIdx = 0;
  }
  for (let p = pageIdx; p < pages.length; p += 1) {
    const base = pageShadowOffsets[p];
    if (base >= end) {
      break;
    }
    const { text, mapStart, mapEnd } = pages[p].shadow;
    const localStart = Math.max(0, start - base);
    const localEnd = Math.min(end - base, text.length);
    if (localEnd <= localStart) {
      continue;
    }
    const normalizedStart = mapStart[localStart];
    const normalizedLength = mapEnd[localEnd - 1] - normalizedStart;
    const [rawStart, rawLength] = getOriginalIndex(
      pages[p].diffs,
      normalizedStart,
      normalizedLength
    );
    if (rawLength > 0) {
      result.push({ pageIdx: p, start: rawStart, length: rawLength });
    }
  }
  return result;
}

/**
 * Finds one or more passages in the extracted page texts.
 *
 * Each passage is first searched as a whole in the concatenated shadow text
 * (cross-page matches included). If it cannot be found — typically because
 * headers/footers of the generated PDF interrupt it at a page break, or
 * because converter fulltext and PDF text layer genuinely diverge — it falls
 * back to matching sentence-like fragments individually, preferring
 * occurrences in reading order.
 *
 * @param {string[]} passages passage texts as delivered by the backend.
 * @param {Array<{shadow: {text: string, mapStart: number[], mapEnd: number[]},
 *   diffs: Array<[number, number]>|null}>} pages per-page shadow (built from
 *   the normalized page content via {@link buildShadow}) and normalization
 *   diffs of the page.
 * @returns {{pageMatches: number[][], pageMatchesLength: number[][],
 *   total: number, firstMatchPageIdx: number}} match positions/lengths per
 *   page in original text-layer coordinates.
 */
export function computePassageMatches(passages, pages) {
  const pageShadowOffsets = [];
  let offset = 0;
  for (const page of pages) {
    pageShadowOffsets.push(offset);
    offset += page.shadow.text.length;
  }
  const documentShadow = pages.map(page => page.shadow.text).join('');

  const rawRanges = [];
  for (const passage of passages) {
    const [normalized] = normalize(passage);
    const needle = buildShadow(normalized).text;
    if (!needle) {
      continue;
    }
    const occurrences = findAllOccurrences(documentShadow, needle);
    if (occurrences.length > 0) {
      for (const pos of occurrences) {
        rawRanges.push(
          ...shadowRangeToPageRanges(pos, pos + needle.length, pages, pageShadowOffsets)
        );
      }
      continue;
    }
    // Fallback: match sentence-like fragments individually. Fragments that
    // fail (e.g. because they cross a page break interrupted by a footer)
    // are halved at word boundaries and retried. The cursor prefers
    // occurrences in reading order so repeated phrases resolve to the
    // occurrence closest to the previously matched fragment.
    const matchFragment = (fragment, cursor) => {
      const fragmentNeedle = buildShadow(fragment).text;
      if (fragmentNeedle.length < MIN_FRAGMENT_SHADOW_LENGTH) {
        return cursor;
      }
      let pos = documentShadow.indexOf(fragmentNeedle, cursor);
      if (pos === -1) {
        pos = documentShadow.lastIndexOf(fragmentNeedle, cursor);
      }
      if (pos !== -1) {
        rawRanges.push(
          ...shadowRangeToPageRanges(pos, pos + fragmentNeedle.length, pages, pageShadowOffsets)
        );
        return pos + fragmentNeedle.length;
      }
      if (fragmentNeedle.length >= 2 * MIN_FRAGMENT_SHADOW_LENGTH) {
        const words = fragment.split(/\s+/).filter(Boolean);
        if (words.length >= 2) {
          const mid = words.length >> 1;
          const nextCursor = matchFragment(words.slice(0, mid).join(' '), cursor);
          return matchFragment(words.slice(mid).join(' '), nextCursor);
        }
      }
      return cursor;
    };
    let cursor = 0;
    for (const fragment of splitIntoFragments(normalized)) {
      cursor = matchFragment(fragment, cursor);
    }
  }

  const perPage = pages.map(() => []);
  for (const range of rawRanges) {
    perPage[range.pageIdx].push(range);
  }

  const pageMatches = pages.map(() => []);
  const pageMatchesLength = pages.map(() => []);
  let total = 0;
  let firstMatchPageIdx = -1;
  perPage.forEach((ranges, pageIdx) => {
    ranges.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.start + last.length) {
        last.length = Math.max(last.length, range.start + range.length - last.start);
      } else {
        merged.push({ start: range.start, length: range.length });
      }
    }
    for (const match of merged) {
      pageMatches[pageIdx].push(match.start);
      pageMatchesLength[pageIdx].push(match.length);
    }
    total += merged.length;
    if (merged.length && firstMatchPageIdx === -1) {
      firstMatchPageIdx = pageIdx;
    }
  });

  return { pageMatches, pageMatchesLength, total, firstMatchPageIdx };
}

export { normalize, getOriginalIndex, binarySearchFirstItem };
