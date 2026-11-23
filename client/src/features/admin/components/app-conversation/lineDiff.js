// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The line diff of the change card: which lines of a text a change removes,
 * which it adds and which stay. Every removed and added line is kept in full;
 * only runs of unchanged lines are folded (plan 3.1: "unchanged runs longer
 * than 6 lines fold; removed and added lines are always shown in full").
 *
 * Pure: no React, no browser API, and no function modifies its argument.
 *
 * @module features/admin/components/app-conversation/lineDiff
 */

/** A run of unchanged lines longer than this folds. */
export const FOLD_THRESHOLD = 6;
/** How many unchanged lines stay visible next to a change when a run folds. */
export const FOLD_CONTEXT = 2;
/**
 * Above this many cells (lines before × lines after, after the common start
 * and end are taken off) the diff gives up on matching lines in the middle and
 * shows it as removed and added. 8,000 characters of instructions are far
 * below it.
 */
const MAX_CELLS = 4_000_000;

/**
 * The lines of a text. An empty or missing text has none; a final line break
 * does not make an empty last line.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function splitLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * @typedef {object} DiffLine
 * @property {'same'|'del'|'ins'} type
 * @property {string} text
 */

/**
 * The line diff of two texts (longest common subsequence of lines).
 *
 * @param {string|string[]} before - The text, or its lines.
 * @param {string|string[]} after - The text, or its lines.
 * @returns {DiffLine[]} In reading order; at a changed place the removed
 *   lines come before the added ones.
 *
 * @example
 * diffLines('a\nb\nc', 'a\nB\nc');
 * // → [{ type: 'same', text: 'a' }, { type: 'del', text: 'b' },
 * //     { type: 'ins', text: 'B' }, { type: 'same', text: 'c' }]
 */
export function diffLines(before, after) {
  const a = Array.isArray(before) ? before : splitLines(before);
  const b = Array.isArray(after) ? after : splitLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const head = a.slice(0, start).map(text => ({ type: 'same', text }));
  const tail = a.slice(endA).map(text => ({ type: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  return [...head, ...diffMiddle(midA, midB), ...tail];
}

/** The diff of the part that differs: a table of common-subsequence lengths, read forwards. */
function diffMiddle(a, b) {
  if (a.length === 0) return b.map(text => ({ type: 'ins', text }));
  if (b.length === 0) return a.map(text => ({ type: 'del', text }));
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map(text => ({ type: 'del', text })), ...b.map(text => ({ type: 'ins', text }))];
  }

  const width = b.length + 1;
  // lengths[i * width + j]: the longest common subsequence of a[i..] and b[j..].
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'ins', text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] });
  while (j < b.length) out.push({ type: 'ins', text: b[j++] });
  return out;
}

/**
 * @typedef {object} DiffFold
 * @property {'fold'} type
 * @property {number} at - The position of its first line in the diff.
 * @property {Array<{at: number, text: string}>} lines - The unchanged lines the fold stands for.
 */

/**
 * The diff with long runs of unchanged lines folded. A run longer than
 * {@link FOLD_THRESHOLD} keeps {@link FOLD_CONTEXT} lines next to each change
 * it touches and folds the rest into one entry. Removed and added lines are
 * never folded. Every row carries `at`, its position in the diff, which stays
 * the same for the same diff (a key for a list).
 *
 * @param {DiffLine[]} diff - The result of {@link diffLines}.
 * @returns {Array<(DiffLine & {at: number})|DiffFold>}
 */
export function foldUnchanged(diff) {
  const lines = diff.map((line, at) => ({ ...line, at }));
  const out = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].type !== 'same') {
      out.push(lines[index]);
      index++;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end].type === 'same') end++;
    const run = lines.slice(index, end);
    if (run.length <= FOLD_THRESHOLD) {
      out.push(...run);
    } else {
      const keepBefore = index > 0 ? FOLD_CONTEXT : 0;
      const keepAfter = end < lines.length ? FOLD_CONTEXT : 0;
      out.push(...run.slice(0, keepBefore));
      const folded = run.slice(keepBefore, run.length - keepAfter);
      out.push({
        type: 'fold',
        at: folded[0].at,
        lines: folded.map(line => ({ at: line.at, text: line.text }))
      });
      out.push(...run.slice(run.length - keepAfter));
    }
    index = end;
  }
  return out;
}
