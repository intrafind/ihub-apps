/**
 * Cuts a streaming answer into pieces worth sending to text-to-speech
 * (voice mode, issue #2868).
 *
 * The answer arrives token by token as Markdown. Speaking it sentence by
 * sentence starts the audio long before the answer is complete, but only if
 * the cuts fall where a listener expects a pause and where the server's
 * Markdown stripping (`server/tts/speechText.js`) still sees whole constructs:
 * a chunk that opens a code fence without closing it, or ends mid-table, would
 * make the server drop or mangle the rest of it.
 *
 * `update(fullText)` takes the CUMULATIVE text and returns the chunks that
 * became complete since the last call. A chunk is raw Markdown, cut at
 *
 * - a sentence end: `. ! ? …` (a run of them, plus closing quotes, brackets and
 *   emphasis marks) followed by whitespace,
 * - a paragraph break (a blank line),
 * - the end of a fenced code block or of a table.
 *
 * Never cut:
 *
 * - inside a code fence — also not while it is still open, which is why a fence
 *   that opens in one update and closes in a later one stays whole,
 * - inside a table (consecutive lines starting with `|`); the table only ends,
 *   and flushes, when a line without `|` follows,
 * - after an abbreviation ("e.g.", "z. B.", "Dr.", "etc."), a single letter
 *   ("U.S.", "J. Smith"), inside a number (`3.5`, `1,000.50`), after an ordinal
 *   or list marker (`3. Oktober`, `1. First step`), inside a URL, or before a
 *   lowercase word (the sentence evidently goes on).
 *
 * A missed cut only delays audio a little; a wrong cut breaks a sentence in two
 * with a pause in the middle. So every heuristic here errs on the side of not
 * cutting.
 *
 * The first chunk is short so audio starts early; later chunks are longer so
 * there are fewer requests and the prosody stays natural. A single run of text
 * longer than `maxChars` is split at a line break or space (never inside a
 * code fence or table, which are not read aloud anyway).
 *
 * Pure: no React, no DOM.
 */

/** Sentence-ending characters. */
const TERMINATORS = new Set(['.', '!', '?', '…']);

/** Characters that may close a sentence after its end mark: quotes, brackets, emphasis. */
const CLOSERS = new Set([
  '"',
  "'",
  '”',
  '“',
  '’',
  '‘',
  '»',
  '«',
  '›',
  '‹',
  ')',
  ']',
  '}',
  '*',
  '_',
  '~',
  '`'
]);

/**
 * Words (lower case, without the dot) after which a full stop does not end the
 * sentence. Single letters need no entry: see `continuesSentence`.
 */
const ABBREVIATIONS = new Set([
  // Both languages
  'etc',
  'vs',
  'ca',
  'dr',
  'nr',
  'prof',
  'approx',
  'incl',
  'fig',
  'cf',
  'al',
  'vol',
  'pp',
  'resp',
  // English
  'mr',
  'mrs',
  'ms',
  'st',
  'jr',
  'sr',
  'inc',
  'ltd',
  // German
  'bzw',
  'usw',
  'ggf',
  'ggfs',
  'evtl',
  'inkl',
  'zzgl',
  'vgl',
  'abb',
  'tab',
  'kap',
  'str',
  'tel',
  'hr',
  'fr',
  'mio',
  'mrd',
  'sog',
  'bspw',
  'dt',
  'engl',
  'geb',
  'jh',
  'jhd'
]);

/** A character of the word in front of a full stop ("e.g", "Peter's", "1,000"). */
const TOKEN_CHAR = /[\p{L}\p{N}.,'’-]/u;
const FENCE_LINE = /^[^\S\n]*(`{3,}|~{3,})/;

const isSpace = ch => ch !== undefined && /\s/.test(ch);
const isHorizontalSpace = ch => ch === ' ' || ch === '\t' || ch === ' ';
const isLowerLetter = ch => ch !== undefined && /\p{Ll}/u.test(ch);

/** Index of the first non-whitespace character at or after `from` (or the text length). */
function skipSpace(text, from) {
  let i = from;
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

/** Whether a line is a table row: its first non-blank character is `|`. */
function isTableRow(line) {
  return line.trimStart().startsWith('|');
}

/** Whether `line` closes the code fence opened with `fence` (same mark, at least as long). */
function closesFence(line, fence) {
  const marker = line.match(FENCE_LINE);
  return Boolean(
    marker &&
    marker[1][0] === fence[0] &&
    marker[1].length >= fence.length &&
    !line.slice(marker[0].length).trim()
  );
}

/**
 * Whether the full stop at `dot` does NOT end a sentence although whitespace
 * follows it (starting at `spaceAt`).
 */
function continuesSentence(text, dot, spaceAt) {
  let start = dot;
  while (start > 0 && TOKEN_CHAR.test(text[start - 1])) start--;
  const token = text.slice(start, dot);
  if (token) {
    const last = token.slice(token.lastIndexOf('.') + 1);
    // Initials and the pieces of "e.g.", "z. B.", "d. h.", "U.S.".
    if (/^\p{L}$/u.test(last)) return true;
    if (ABBREVIATIONS.has(last.toLowerCase())) return true;
    // An ordinal ("am 3. Oktober") or list marker ("1. First"): a whole number
    // of up to three digits, followed by a space on the same line. A year or a
    // decimal at the end of a sentence ("in 2024.", "version 3.5.") still ends it.
    if (/^\d{1,3}$/.test(token) && isHorizontalSpace(text[spaceAt])) return true;
  }
  return startsLowercase(text, spaceAt);
}

/**
 * Whether the next word, after the horizontal whitespace at `spaceAt`, starts
 * in lower case: the sentence evidently goes on ("approx. five", "Well... it
 * depends"). A line break in between is a break, whatever follows.
 */
function startsLowercase(text, spaceAt) {
  let next = spaceAt;
  while (isHorizontalSpace(text[next])) next++;
  return isLowerLetter(text[next]);
}

/**
 * Walk the text from `from` and find every place a chunk may end, plus the code
 * fences and tables that must stay whole.
 *
 * @param {string} text
 * @param {number} from - Start of the not yet consumed text (outside any block).
 * @returns {{ ends: number[], blocks: Array<[number, number]> }} `ends`: ascending
 *   positions just after a unit; `blocks`: `[start, end)` of each fence/table
 *   (`end` is `Infinity` while it is still open).
 */
function scan(text, from) {
  const ends = [];
  const blocks = [];
  let lastEnd = from;
  const addEnd = pos => {
    if (pos > lastEnd) {
      ends.push(pos);
      lastEnd = pos;
    }
  };

  let state = 'text'; // 'text' | 'fence' | 'table'
  let fence = '';
  let tableEnd = 0;
  // End of the last non-blank line of the current paragraph; -1 after a break.
  let contentEnd = -1;

  let lineStart = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const complete = newline !== -1;
    const lineEnd = complete ? newline : text.length;
    const line = text.slice(lineStart, lineEnd);
    const blank = !line.trim();

    if (state === 'table' && !isTableRow(line)) {
      // The next line may still turn out to be another row.
      if (blank && !complete) break;
      blocks[blocks.length - 1][1] = tableEnd;
      addEnd(tableEnd);
      state = 'text';
      contentEnd = -1;
    }

    if (state === 'fence') {
      // A closing fence only counts once its line is complete: "```" may still
      // grow into "```js" (an opening fence is never a closing one).
      if (complete && closesFence(line, fence)) {
        blocks[blocks.length - 1][1] = lineEnd;
        addEnd(lineEnd);
        state = 'text';
        contentEnd = -1;
      }
    } else if (state === 'table') {
      tableEnd = lineEnd;
    } else {
      const marker = line.match(FENCE_LINE);
      if (marker) {
        state = 'fence';
        fence = marker[1];
        blocks.push([lineStart, Infinity]);
      } else if (isTableRow(line)) {
        state = 'table';
        tableEnd = lineEnd;
        blocks.push([lineStart, Infinity]);
      } else if (blank) {
        // A complete blank line is a paragraph break.
        if (complete && contentEnd !== -1) addEnd(contentEnd);
        if (complete) contentEnd = -1;
      } else {
        scanSentences(text, Math.max(lineStart, from), lineEnd, complete, addEnd);
        contentEnd = lineStart + line.trimEnd().length;
      }
    }

    if (!complete) break;
    lineStart = lineEnd + 1;
  }
  return { ends, blocks };
}

/** Report every sentence end in `text[from, lineEnd)` through `addEnd`. */
function scanSentences(text, from, lineEnd, complete, addEnd) {
  let i = from;
  while (i < lineEnd) {
    if (!TERMINATORS.has(text[i])) {
      i++;
      continue;
    }
    let runEnd = i + 1;
    while (runEnd < lineEnd && TERMINATORS.has(text[runEnd])) runEnd++;
    let end = runEnd;
    while (end < lineEnd && CLOSERS.has(text[end])) end++;

    // At the end of the line only a complete line (newline follows) counts: the
    // last line of the text may still be growing ("3." may become "3.5").
    const followedBySpace = end === lineEnd ? complete : isSpace(text[end]);
    if (followedBySpace) {
      const run = text.slice(i, runEnd);
      // "?!" and "!!" end a sentence for sure; a full stop needs the checks
      // above; an ellipsis only gives way to a lowercase word after it.
      const continues =
        run === '.'
          ? continuesSentence(text, i, end)
          : /^[.…]+$/.test(run) && startsLowercase(text, end);
      if (!continues) addEnd(end);
    }
    i = end;
  }
}

/** Whether `pos` lies strictly inside a code fence or table. */
function insideBlock(blocks, pos) {
  return blocks.some(([start, end]) => pos > start && pos < end);
}

/**
 * Where to split a run of text that is longer than `maxChars` without a
 * sentence end: at the last line break in the second half of the window, else
 * the last space, else (one huge word) at the limit. Never inside a block.
 *
 * @returns {number} Cut position, or -1 when the window lies inside a block.
 */
function findHardCut(text, start, maxChars, blocks) {
  const limit = start + maxChars;
  let space = -1;
  let newline = -1;
  for (let pos = limit; pos > start; pos--) {
    if (!isSpace(text[pos]) || insideBlock(blocks, pos)) continue;
    if (space === -1) space = pos;
    if (text[pos] === '\n') {
      newline = pos;
      break;
    }
  }
  if (newline !== -1 && newline - start >= maxChars / 2) return newline;
  if (space !== -1) return space;
  return insideBlock(blocks, limit) ? -1 : limit;
}

/**
 * @param {Object} [opts]
 * @param {number} [opts.firstMinChars=30] - The first chunk ends at the first
 *   sentence end after this many characters, so audio starts early.
 * @param {number} [opts.laterMinChars=250] - Every later chunk, so there are
 *   fewer requests and the prosody stays natural.
 * @param {number} [opts.maxChars=1500] - Longest chunk. A longer run of text is
 *   split at a space; a code fence or table is kept whole however long.
 * @returns {{
 *   update: (fullText: string, opts?: { final?: boolean }) => string[],
 *   reset: () => void
 * }}
 */
export function createSpeakableChunker({
  firstMinChars = 30,
  laterMinChars = 250,
  maxChars = 1500
} = {}) {
  /** How much of the cumulative text has been handed out (or skipped). */
  let consumed = 0;
  let emitted = 0;

  return {
    /**
     * Feed the cumulative answer text. Returns only the chunks completed since
     * the last call; with `final: true` the unfinished rest is flushed too (a
     * second `final` returns nothing). Text that got shorter than what was
     * already consumed (content replaced) clamps the offset instead of throwing.
     *
     * @param {string} fullText
     * @param {{ final?: boolean }} [opts]
     * @returns {string[]}
     */
    update(fullText, { final = false } = {}) {
      const text = typeof fullText === 'string' ? fullText : '';
      consumed = Math.min(consumed, text.length);
      let start = skipSpace(text, consumed);
      if (start >= text.length) {
        consumed = start;
        return [];
      }

      const { ends, blocks } = scan(text, start);
      const chunks = [];
      const emit = (from, to) => {
        const chunk = text.slice(from, to).trim();
        if (!chunk) return;
        chunks.push(chunk);
        emitted++;
      };

      // Each end is a place a chunk may stop. `prev` is the last one that was
      // too early to use; it is the cut when the next unit would overflow.
      // The text's end is the last pseudo-end: with `final` it flushes (any
      // length), without it only splits an overlong unfinished run.
      let prev = -1;
      const points = ends.map(pos => ({ pos, kind: 'sentence' }));
      points.push({ pos: text.length, kind: final ? 'final' : 'tail' });
      for (const { pos, kind } of points) {
        if (pos - start > maxChars && prev > start) {
          emit(start, prev);
          start = skipSpace(text, prev);
          prev = -1;
        }
        while (pos - start > maxChars) {
          const cut = findHardCut(text, start, maxChars, blocks);
          if (cut === -1) break;
          emit(start, cut);
          start = skipSpace(text, cut);
        }
        if (kind === 'tail') break;
        const needed = kind === 'final' ? 1 : emitted ? laterMinChars : firstMinChars;
        if (pos - start >= needed) {
          emit(start, pos);
          start = skipSpace(text, pos);
          prev = -1;
        } else {
          prev = pos;
        }
      }

      consumed = start;
      return chunks;
    },

    /** Forget everything: the next `update` starts a new answer. */
    reset() {
      consumed = 0;
      emitted = 0;
    }
  };
}

export default createSpeakableChunker;
