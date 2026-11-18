// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A structured tool argument a model sent as JSON text (`sheets`, `slides`,
 * `blocks`, a dashboard's `data`): parsed, with one repair, and when it cannot
 * be read, an error that says what is wrong and where.
 *
 * Models writing long JSON by hand most often drop a closing bracket: at the
 * very end, or just before the bracket of the container around it
 * (`…0.6]}]` where `…0.6]]}]` was meant). Both are closed here, in nesting
 * order, where the text first shows them missing, when that is the only
 * plausible place for them (see {@link closeMissingBrackets}). Nothing else is changed:
 * other damage is refused with its position, since a generic "must be JSON"
 * made the model send the same 5,000 characters again and again
 * (intrafind/ihub-apps#3831). The result is still checked like any argument.
 *
 * @module services/documents/jsonArgument
 */

const CLOSER = { '{': '}', '[': ']' };
const OPENER = { '}': '{', ']': '[' };
/** Nesting the error locator follows before it stops looking. */
const MAX_DEPTH = 512;
/** Characters of the text before the error that the message quotes. */
const CONTEXT_CHARS = 40;

/** JSON text that cannot be read, with what was expected where. */
export class JsonArgumentError extends Error {
  /**
   * @param {string} message
   * @param {{ position: number, expected: string, found: string, path: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'JsonArgumentError';
    Object.assign(this, details);
  }
}

/**
 * Close brackets the text leaves open: at its end, and before a closing
 * bracket that belongs to an outer container. A bracket is only added where no
 * other place for it is plausible; otherwise the text is refused, not guessed
 * at:
 *
 * - A container closed this way must not sit directly in one of its own kind:
 *   an array in an array could as well have ended after any of its elements.
 * - Its last item must not be able to have swallowed the items after it. Had
 *   that item's own bracket been dropped, everything after it would read as
 *   part of it, and the bracket found at its end would be the outer one. An
 *   object whose last value is an object is refused (any member fits in
 *   either), and so is an array whose last element is an array when that
 *   element holds an array or the outer one holds non-arrays (rows are arrays
 *   of values: a row inside a row is the sign of a dropped bracket).
 *
 * @param {string} text
 * @returns {{ text: string, closed: number }|null} null when nothing can be closed this way
 */
export function closeMissingBrackets(text) {
  if (typeof text !== 'string') return null;
  const stack = [];
  const parts = [];
  let last = 0;
  let closed = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (' \t\n\r'.includes(ch)) continue;
    const top = stack.at(-1);
    if (top?.expecting && !OPENER[ch]) startItem(top, ch);
    if (ch === '"') {
      const end = stringEnd(text, i);
      if (end === -1) return null;
      i = end - 1;
    } else if (ch === ',' || ch === ':') {
      if (top) top.expecting = ch === ':' || top.open === '[';
    } else if (CLOSER[ch]) {
      stack.push(openEntry(ch));
    } else if (OPENER[ch]) {
      const closers = closeUntil(stack, OPENER[ch]);
      if (closers === null) return null;
      if (closers) {
        parts.push(text.slice(last, i), closers);
        last = i;
        closed += closers.length;
      }
    }
  }
  parts.push(text.slice(last));
  if (stack.length === 0) return closed ? { text: parts.join(''), closed } : null;
  const closers = closeUntil(stack, null);
  if (closers === null) return null;
  return { text: parts.join('').trimEnd() + closers, closed: closed + closers.length };
}

/** A container the scan is inside. */
function openEntry(open) {
  return {
    open,
    // An item (array element, object value) starts at the next character.
    expecting: open === '[',
    // Arrays: holds an array element, holds any other element.
    hasArray: false,
    hasOther: false,
    // The last item is a container of this one's kind, and it holds an array.
    lastIsSame: false,
    lastHoldsArray: false
  };
}

/** An item of `entry` starts with `ch`. */
function startItem(entry, ch) {
  entry.expecting = false;
  entry.lastIsSame = false;
  if (entry.open !== '[') return;
  if (ch === '[') entry.hasArray = true;
  else entry.hasOther = true;
}

/** `entry` is closed; `parent` is the container it sits in. */
function closeEntry(entry, parent) {
  if (parent?.open !== entry.open) return;
  parent.lastIsSame = true;
  parent.lastHoldsArray = entry.hasArray;
}

/** Whether the last item of `entry` could have swallowed the items after it. */
function lastItemCouldHaveSwallowed(entry) {
  if (!entry.lastIsSame) return false;
  return entry.open === '{' || entry.lastHoldsArray || entry.hasOther;
}

/**
 * Close the containers above the innermost `opener` (all of them when it is
 * null) and, for an opener, that one too; return the brackets that had to be
 * added, innermost first: '' when the top is the opener itself, null when a
 * bracket cannot be added there (no such opener, or a place that is not the
 * only plausible one).
 *
 * @param {Object[]} stack - Open containers, outermost first.
 * @param {string|null} opener
 * @returns {string|null}
 */
function closeUntil(stack, opener) {
  const at = opener === null ? -1 : stack.findLastIndex(entry => entry.open === opener);
  if (opener !== null && at === -1) return null;
  let closers = '';
  for (let k = stack.length - 1; k > at; k--) {
    const entry = stack[k];
    if (stack[k - 1]?.open === entry.open || lastItemCouldHaveSwallowed(entry)) return null;
    closers += CLOSER[entry.open];
    stack.pop();
    closeEntry(entry, stack.at(-1));
  }
  if (opener !== null) closeEntry(stack.pop(), stack.at(-1));
  return closers;
}

/**
 * Index after the string whose opening quote is at `start`, or -1 when the
 * text ends inside it.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function stringEnd(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

/** `sheets[0].rows[3]` for a root name and a list of keys and indexes. */
function pathText(root, path) {
  let text = root;
  for (const key of path) {
    if (typeof key === 'number') text += `[${key}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(key)) text += text ? `.${key}` : key;
    else text += `[${JSON.stringify(key)}]`;
  }
  return text || 'the top level';
}

/**
 * Where JSON text stops being valid: the first character a JSON reader cannot
 * accept, what it expected instead, and the containers open there.
 *
 * @param {string} text
 * @returns {{ index: number, expected: string, path: Array<string|number>,
 *   open: Array<{ kind: string, start: number, path: Array<string|number> }> }|null}
 *   null when the text is valid JSON (or nested too deep to follow)
 */
export function locateJsonError(text) {
  let i = 0;
  const path = [];
  const open = [];
  const stop = expected => {
    const error = new Error('stop');
    error.located = {
      index: i,
      expected,
      path: [...path],
      open: open.map(c => ({ ...c, path: [...c.path] }))
    };
    throw error;
  };
  const skipSpace = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };

  /** One escape in a string; `i` is at its backslash. */
  function readEscape() {
    const next = text[i + 1];
    if (next === 'u') {
      if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        i += 2;
        stop(String.raw`four hex digits after "\u"`);
      }
      i += 6;
      return;
    }
    if (next && String.raw`"\/bfnrt`.includes(next)) {
      i += 2;
      return;
    }
    i++;
    stop(String.raw`one of " \ / b f n r t u after a backslash`);
  }

  function readString() {
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        i++;
        return;
      }
      if (ch === '\\') {
        readEscape();
        continue;
      }
      if (ch < ' ') {
        stop(String.raw`an escape such as "\n" instead of a control character in a string`);
      }
      i++;
    }
    stop('a closing quote (")');
  }

  function readNumber() {
    const re = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    re.lastIndex = i;
    const match = re.exec(text);
    if (!match) stop('a value');
    i += match[0].length;
  }

  /** A property name and its colon; returns the name. */
  function readKey(first) {
    skipSpace();
    if (text[i] !== '"') {
      stop(first ? 'a property name in double quotes, or "}"' : 'a property name in double quotes');
    }
    const keyStart = i;
    readString();
    const key = JSON.parse(text.slice(keyStart, i));
    skipSpace();
    if (text[i] !== ':') stop('":"');
    i++;
    return key;
  }

  function readContainer(depth, kind) {
    if (depth > MAX_DEPTH) throw new Error('too deep');
    open.push({ kind, start: i, path: [...path] });
    const closer = kind === 'array' ? ']' : '}';
    i++;
    skipSpace();
    if (text[i] === closer) {
      i++;
      open.pop();
      return;
    }
    for (let index = 0; ; index++) {
      path.push(kind === 'object' ? readKey(index === 0) : index);
      readValue(depth + 1);
      path.pop();
      skipSpace();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] !== closer) stop(`"," or "${closer}"`);
      i++;
      open.pop();
      return;
    }
  }

  function readValue(depth) {
    skipSpace();
    const ch = text[i];
    if (ch === '{') return readContainer(depth, 'object');
    if (ch === '[') return readContainer(depth, 'array');
    if (ch === '"') return readString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return readNumber();
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return;
      }
    }
    return stop('a value');
  }

  try {
    readValue(0);
    skipSpace();
    if (i < text.length) stop('the end of the text');
    return null;
  } catch (error) {
    return error.located || null;
  }
}

const formatNumber = n => n.toLocaleString('en-US');

/**
 * What is wrong with JSON text and where, for the model that sent it: the
 * position, what was expected and found, the text just before, and the
 * container that is not closed when a bracket is the problem.
 *
 * @param {string} text
 * @param {string} [root] - The argument's name, the root of the paths named.
 * @returns {{ message: string, position?: number, expected?: string, found?: string, path?: string }}
 */
export function describeJsonError(text, root = '') {
  const located = locateJsonError(text);
  if (!located) return { message: 'it could not be read (it is nested too deeply)' };
  const { index, expected, open } = located;
  const atEnd = index >= text.length;
  const found = atEnd ? 'the end of the text' : JSON.stringify(text[index]);
  const before = text.slice(Math.max(0, index - CONTEXT_CHARS), index).replace(/\s+/g, ' ');
  const lead = index > CONTEXT_CHARS ? '…' : '';
  const where = atEnd
    ? `at the end (character ${formatNumber(index + 1)})`
    : `at character ${formatNumber(index + 1)} of ${formatNumber(text.length)}`;
  let message = `expected ${expected} ${where}, but found ${found}`;
  if (before) message += `, after: ${lead}${before}`;
  const container = open.at(-1);
  const containerCloser = container?.kind === 'array' ? ']' : '}';
  const ch = atEnd ? '' : text[index];
  if (OPENER[ch] && !open.some(c => (c.kind === 'array' ? '[' : '{') === OPENER[ch])) {
    // A closing bracket with nothing of its kind open: one too many.
    message += `. This "${ch}" matches no bracket open here`;
  } else if (container && expected.includes(`"${containerCloser}"`) && (atEnd || OPENER[ch])) {
    // A bracket of the other kind, or the end: the container's own bracket
    // is what is missing.
    message += `. The ${container.kind} ${pathText(root, container.path)} (opened at character ${formatNumber(container.start + 1)}) is not closed there, or an item inside it is missing its own closing bracket`;
  }
  return {
    message,
    position: index + 1,
    expected,
    found,
    path: pathText(root, located.path)
  };
}

/**
 * Parse JSON text a model sent as an argument. Brackets left open are closed
 * (see {@link closeMissingBrackets}); any other damage is refused with where
 * it is.
 *
 * @param {string} text
 * @param {string} [root] - The argument's name, for the paths in the message.
 * @returns {{ value: unknown, closed: number }} `closed`: brackets added
 * @throws {JsonArgumentError}
 */
export function parseJsonArgument(text, root = '') {
  try {
    return { value: JSON.parse(text), closed: 0 };
  } catch {
    // Read below.
  }
  const repaired = closeMissingBrackets(text);
  if (repaired) {
    try {
      return { value: JSON.parse(repaired.text), closed: repaired.closed };
    } catch {
      // Not only brackets: say what is wrong in the text as sent.
    }
  }
  const { message, ...details } = describeJsonError(text, root);
  throw new JsonArgumentError(message, details);
}
