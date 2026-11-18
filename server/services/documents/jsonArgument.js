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
 * order, where the text first shows them missing. Nothing else is changed:
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
 * bracket that belongs to an outer container. Inside the text, each container
 * closed that way must sit in one of the other kind (an array in an object, an
 * object in an array): an array directly in an array could as well have ended
 * after any of its elements, so such text is refused, not guessed at.
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
    const opener = OPENER[ch];
    if (ch === '"') {
      const end = stringEnd(text, i);
      if (end === -1) return null;
      i = end - 1;
    } else if (CLOSER[ch]) {
      stack.push(ch);
    } else if (opener && stack.at(-1) === opener) {
      stack.pop();
    } else if (opener) {
      const closers = closersUntil(stack, opener);
      if (closers === null) return null;
      parts.push(text.slice(last, i), closers);
      last = i;
      closed += closers.length;
      // The containers just closed, and the one this bracket closes.
      stack.length -= closers.length + 1;
    }
  }
  parts.push(text.slice(last));
  if (stack.length === 0) return closed ? { text: parts.join(''), closed } : null;
  const closers = stack
    .reverse()
    .map(open => CLOSER[open])
    .join('');
  return { text: parts.join('').trimEnd() + closers, closed: closed + closers.length };
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

/**
 * The closing brackets for the containers above the innermost `opener` on the
 * stack, innermost first; null when there is no such opener, or when one of
 * those containers sits directly in one of its own kind.
 *
 * @param {string[]} stack - Open brackets, outermost first.
 * @param {string} opener
 * @returns {string|null}
 */
function closersUntil(stack, opener) {
  const at = stack.lastIndexOf(opener);
  if (at === -1) return null;
  for (let k = stack.length - 1; k > at; k--) {
    if (stack[k] === stack[k - 1]) return null;
  }
  return stack
    .slice(at + 1)
    .reverse()
    .map(open => CLOSER[open])
    .join('');
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
    message += `. The ${container.kind} ${pathText(root, container.path)} (opened at character ${formatNumber(container.start + 1)}) is not closed`;
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
