/**
 * Markdown front matter parsing, restricted to YAML.
 *
 * Skill files (`SKILL.md`) and marketplace content previews start with a block
 * of metadata between two `---` lines, followed by the Markdown body. The
 * `gray-matter` library splits that block from the body. Besides YAML it can
 * parse front matter written in other languages, chosen by a name written
 * directly after the opening `---` (for example `---json`), and one of its
 * built-in engines evaluates JavaScript. Front matter in iHub is plain data, so
 * this module is the only place that calls gray-matter, and it accepts YAML
 * front matter only.
 *
 * How "YAML only" is enforced — three independent layers:
 *
 * 1. **Language check before parsing.** The declared language is read with
 *    gray-matter's own `matter.language()` (the function gray-matter uses
 *    internally), following the same steps gray-matter takes before it calls
 *    it. Anything other than no language, `yaml` or `yml` (any case) is
 *    rejected with a {@link FrontMatterError}. Unknown names are rejected here
 *    as well, so they never reach gray-matter's engine lookup.
 * 2. **Non-YAML engines throw.** Every engine name gray-matter registers or
 *    aliases for another language (plus common third-party ones) is replaced by
 *    an engine that throws, so no other parser can run even if layer 1 were
 *    bypassed.
 * 3. **Safe YAML schema.** The YAML engine is gray-matter's built-in one —
 *    js-yaml 3 `safeLoad`, whose default schema has no `!!js/*` types — called
 *    with no options. gray-matter would otherwise forward its own options
 *    object to js-yaml, where a `schema` key replaces the safe default.
 *
 * Caching: gray-matter keeps a result cache keyed by file content, but only
 * reads and writes it when it is called *without* options. This module always
 * passes options, so it never returns a result that some other caller of
 * gray-matter cached, and it does not grow that cache.
 *
 * Importing `gray-matter` anywhere else is a lint error (see the
 * `no-restricted-syntax` block in `eslint.config.js`).
 *
 * @example
 * import { parseFrontMatter, FrontMatterError } from '../utils/frontMatter.js';
 *
 * const { data, content } = parseFrontMatter('---\nname: demo\n---\n# Body');
 * // data    → { name: 'demo' }
 * // content → '# Body'
 *
 * @module utils/frontMatter
 */

import matter from 'gray-matter';

/** The front matter delimiter. gray-matter's default, and the only one accepted. */
const DELIMITER = '---';

/** Byte-order mark. gray-matter strips exactly one from the start of the input. */
const BYTE_ORDER_MARK = '\uFEFF';

/** Language passed to gray-matter as the default when the block names none. */
const DEFAULT_LANGUAGE = 'yaml';

/** Lower-cased language names that select gray-matter's YAML engine. */
const YAML_LANGUAGES = new Set(['yaml', 'yml']);

/**
 * Engine names that select a non-YAML parser: the ones gray-matter registers
 * or aliases (`javascript`, `js`, `coffee`, `coffeescript`, `cson`, `json`)
 * and common third-party ones (`toml`). Each is replaced by a throwing engine.
 */
const NON_YAML_ENGINE_NAMES = Object.freeze([
  'javascript',
  'js',
  'coffee',
  'coffeescript',
  'cson',
  'json',
  'toml'
]);

/** Longest language name quoted in an error message; longer names are cut. */
const MAX_LANGUAGE_IN_MESSAGE = 64;

/**
 * gray-matter's built-in YAML parser (js-yaml 3 `safeLoad`, bound to js-yaml),
 * captured once when this module loads.
 */
const yamlSafeLoad = matter.engines.yaml.parse;

/**
 * Thrown when front matter declares a language other than YAML.
 *
 * Callers can tell it apart from a YAML syntax error (a js-yaml
 * `YAMLException`) by `error instanceof FrontMatterError` or by `error.code`.
 */
export class FrontMatterError extends Error {
  /**
   * @param {string} message - Human-readable reason, for logs
   * @param {string} language - The language name the front matter declared
   */
  constructor(message, language) {
    super(message);
    this.name = 'FrontMatterError';
    /** Stable machine-readable code. */
    this.code = 'FRONT_MATTER_LANGUAGE_NOT_ALLOWED';
    /** The declared language name, as written in the file (trimmed). */
    this.language = language;
  }
}

/**
 * Whether a declared front matter language selects the YAML engine.
 *
 * @param {string} language - Trimmed language name; `''` when none was declared
 * @returns {boolean} `true` for no language, `yaml` or `yml` (case-insensitive)
 */
function isYamlLanguage(language) {
  return language === '' || YAML_LANGUAGES.has(language.toLowerCase());
}

/**
 * Build the error for a front matter block in a language other than YAML.
 *
 * @param {string} language - The declared language name
 * @returns {FrontMatterError}
 */
function languageNotAllowed(language) {
  const shown =
    language.length > MAX_LANGUAGE_IN_MESSAGE
      ? `${language.slice(0, MAX_LANGUAGE_IN_MESSAGE)}…`
      : language;
  return new FrontMatterError(
    `Front matter language "${shown}" is not supported; only YAML front matter is accepted`,
    language
  );
}

/**
 * Read the language a front matter block declares, without parsing the block.
 *
 * Mirrors the steps gray-matter takes before it picks an engine, so both
 * always agree on the language:
 * strip one byte-order mark → require the opening `---` → a fourth `-` means
 * "not front matter" → the rest of the first line is the language name.
 *
 * @param {string} content - The full file content
 * @returns {string} The trimmed language name; `''` when the content has no
 *   front matter or the block names no language
 */
function detectDeclaredLanguage(content) {
  const text = content.startsWith(BYTE_ORDER_MARK) ? content.slice(1) : content;
  if (!text.startsWith(DELIMITER)) return '';
  if (text.charAt(DELIMITER.length) === DELIMITER.slice(-1)) return '';
  return matter.language(text.slice(DELIMITER.length)).name;
}

/**
 * Create a gray-matter engine that refuses to parse.
 *
 * @param {string} language - Engine name, quoted in the error
 * @returns {{ parse: () => never }}
 */
function rejectingEngine(language) {
  return {
    parse() {
      throw languageNotAllowed(language);
    }
  };
}

/**
 * Build the options object passed to gray-matter on every call.
 *
 * A fresh object per call, so nothing gray-matter does with it can leak into
 * the next parse. Passing any options object also keeps gray-matter's
 * content-keyed result cache out of the picture (see module docs).
 *
 * @returns {{ language: string, engines: Record<string, { parse: Function }> }}
 */
function buildParseOptions() {
  const engines = Object.fromEntries(
    NON_YAML_ENGINE_NAMES.map(name => [name, rejectingEngine(name)])
  );
  // Called with the block text only: gray-matter's options are not forwarded
  // to js-yaml, so the safe default schema always applies.
  engines.yaml = { parse: text => yamlSafeLoad(text) };
  return { language: DEFAULT_LANGUAGE, engines };
}

/**
 * Split Markdown into its YAML front matter and its body.
 *
 * Content without front matter is returned unchanged as `content`, with empty
 * `data`. Front matter that declares any language other than YAML is rejected
 * before it is parsed.
 *
 * @param {string} content - Full Markdown text, e.g. the contents of a SKILL.md
 * @returns {{ data: *, content: string }} `data` is the parsed YAML, exactly as
 *   gray-matter returns it — usually a plain object, `{}` for an empty or
 *   missing block, but a scalar, array or `null` if the YAML is one;
 *   `content` is the Markdown after the closing delimiter.
 * @throws {TypeError} When `content` is not a string
 * @throws {FrontMatterError} When the front matter declares a non-YAML language
 * @throws {Error} When the YAML itself is invalid or uses a tag outside the
 *   safe schema (a js-yaml `YAMLException`)
 *
 * @example
 * parseFrontMatter('---\ntitle: Hi\n---\nText'); // → { data: { title: 'Hi' }, content: 'Text' }
 * parseFrontMatter('---json\n{"title":"Hi"}\n---\nText'); // throws FrontMatterError
 */
export function parseFrontMatter(content) {
  if (typeof content !== 'string') {
    throw new TypeError('parseFrontMatter expects the Markdown content as a string');
  }

  const declaredLanguage = detectDeclaredLanguage(content);
  if (!isYamlLanguage(declaredLanguage)) {
    throw languageNotAllowed(declaredLanguage);
  }

  const file = matter(content, buildParseOptions());

  // Backstop: the block must have gone through the YAML engine. gray-matter
  // returns early for '' without setting a language, hence the default.
  const parsedLanguage = file.language || DEFAULT_LANGUAGE;
  if (!isYamlLanguage(parsedLanguage)) {
    throw languageNotAllowed(parsedLanguage);
  }

  return { data: file.data, content: file.content };
}
