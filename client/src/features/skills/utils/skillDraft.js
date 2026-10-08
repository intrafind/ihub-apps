/**
 * A skill drafted in a chat answer — what "Save as skill" puts into the
 * skill editor.
 *
 * The `skill-builder` skill (and any answer written the same way) hands over a
 * skill as a `SKILL.md` in a fenced code block: YAML frontmatter with `name`
 * and `description`, then the Markdown instructions. Reference files follow
 * in code blocks of their own, labelled with their path after the language
 * (```` ```markdown references/template.md ````) or on the line just above.
 *
 * Only `name` and `description` are read from the frontmatter, with the YAML
 * forms a model writes for them (plain, quoted, folded or literal block); any
 * other key is ignored. The editor validates the result like a skill typed by
 * hand, and the server stays the authority on what can be saved.
 */

/** A skill file path, as `server/validators/userSkillSchema.js` accepts it. */
const SKILL_FILE_PATH =
  /^(references|assets|scripts)\/[A-Za-z0-9][A-Za-z0-9._-]*\.(md|txt|csv|json|ya?ml)$/;

/** An opening code fence: three or more backticks or tildes, then the info string. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A closing code fence. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** A top-level frontmatter key. */
const FRONTMATTER_KEY = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/;

/**
 * The fenced code blocks of a Markdown text, in order. A fence closes with
 * the same character, at least as long as it opened — so a SKILL.md wrapped
 * in four backticks keeps the three-backtick blocks inside it. A block left
 * open runs to the end of the text, as in CommonMark.
 *
 * @param {string} text
 * @returns {Array<{info: string, content: string, precedingLine: string}>}
 */
export function fencedBlocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const blocks = [];
  let open = null;
  let lastNonEmpty = '';
  for (const line of lines) {
    if (!open) {
      const match = FENCE_OPEN.exec(line);
      const info = match ? match[2].trim() : '';
      if (match && !(match[1][0] === '`' && info.includes('`'))) {
        open = { char: match[1][0], length: match[1].length, info, lines: [], lastNonEmpty };
      } else if (line.trim()) {
        lastNonEmpty = line.trim();
      }
      continue;
    }
    const close = FENCE_CLOSE.exec(line);
    if (close && close[1][0] === open.char && close[1].length >= open.length) {
      blocks.push({
        info: open.info,
        content: open.lines.join('\n'),
        precedingLine: open.lastNonEmpty
      });
      open = null;
      lastNonEmpty = '';
    } else {
      open.lines.push(line);
    }
  }
  if (open) {
    blocks.push({
      info: open.info,
      content: open.lines.join('\n'),
      precedingLine: open.lastNonEmpty
    });
  }
  return blocks;
}

/** Unescape a YAML double-quoted scalar. */
function unescapeDoubleQuoted(value) {
  return value.replaceAll(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escape) => {
    if (escape[0] === 'u' && escape.length === 5) {
      return String.fromCharCode(parseInt(escape.slice(1), 16));
    }
    return { n: '\n', t: '\t', r: '\r', 0: '\0' }[escape] ?? escape;
  });
}

/**
 * A quoted scalar that may continue on the next lines; YAML folds its line
 * breaks into spaces.
 */
function readQuoted(first, rest, quote) {
  const text = [first, ...rest.map(line => line.trim())].join(' ');
  if (quote === "'") {
    const match = /^'((?:[^']|'')*)'/.exec(text);
    return match ? match[1].replaceAll("''", "'") : text.slice(1);
  }
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(text);
  return unescapeDoubleQuoted(match ? match[1] : text.slice(1));
}

/** A `|` (literal) or `>` (folded) block scalar from its indented lines. */
function readBlock(indicator, rest) {
  const indents = rest.filter(line => line.trim()).map(line => line.match(/^\s*/)[0].length);
  const indent = indents.length ? Math.min(...indents) : 0;
  const lines = rest.map(line => line.slice(indent));
  if (indicator.startsWith('|')) return lines.join('\n');
  // Folded: a single line break becomes a space, an empty line a line break.
  return lines
    .join('\n')
    .replaceAll(/([^\n])\n(?=[^\n])/g, '$1 ')
    .replaceAll('\n\n', '\n');
}

/** A plain scalar, possibly continued on indented lines, without a trailing comment. */
function readPlain(first, rest) {
  return [first, ...rest.map(line => line.trim())]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+#.*$/, '');
}

/**
 * The top-level string fields of a frontmatter block. Nested maps (such as
 * `metadata:`) and lists are skipped.
 *
 * @param {string[]} lines - The lines between the two `---`.
 * @returns {Object<string, string>}
 */
function readFrontmatterFields(lines) {
  const fields = {};
  for (let i = 0; i < lines.length; i++) {
    const match = FRONTMATTER_KEY.exec(lines[i]);
    if (!match) continue;
    const [, key, raw = ''] = match;
    const rest = [];
    while (i + 1 < lines.length && (!lines[i + 1].trim() || /^\s/.test(lines[i + 1]))) {
      rest.push(lines[++i]);
    }
    while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
    const first = raw.trim();
    if (first.startsWith('"') || first.startsWith("'")) {
      fields[key] = readQuoted(first, rest, first[0]);
    } else if (/^[|>][+-]?\d?$/.test(first)) {
      fields[key] = readBlock(first, rest);
    } else if (first) {
      fields[key] = readPlain(first, rest);
    }
  }
  return fields;
}

/**
 * Read a SKILL.md: its `name` and `description` and the instructions after
 * the frontmatter. Null when the text is not one — no frontmatter, a missing
 * name or description, or no instructions.
 *
 * @param {string} text
 * @returns {{name: string, description: string, body: string}|null}
 *
 * @example
 * parseSkillMarkdown('---\nname: weekly-report\ndescription: "Drafts it."\n---\n# Weekly\n…');
 * // → { name: 'weekly-report', description: 'Drafts it.', body: '# Weekly\n…' }
 */
export function parseSkillMarkdown(text) {
  const lines = String(text || '')
    .replace(/^﻿/, '')
    .split(/\r?\n/);
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  if (lines[start]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > start && /^(---|\.\.\.)\s*$/.test(line));
  if (end === -1) return null;
  const fields = readFrontmatterFields(lines.slice(start + 1, end));
  const name = typeof fields.name === 'string' ? fields.name.trim() : '';
  const description = typeof fields.description === 'string' ? fields.description.trim() : '';
  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  if (!name || !description || !body) return null;
  return { name, description, body };
}

/** The path a code block is labelled with, or null. */
function filePathOf(block) {
  for (const token of block.info.split(/\s+/)) {
    const path = token.replace(/^(title|file|filename|path)=/i, '').replaceAll(/^["']|["']$/g, '');
    if (SKILL_FILE_PATH.test(path)) return path;
  }
  const label = block.precedingLine
    .replace(/^[#>*\-\s]+/, '')
    .replaceAll(/[*_`]/g, '')
    .replace(/:$/, '')
    .trim();
  const words = label.split(/\s+/);
  const last = words[words.length - 1];
  return words.length <= 3 && SKILL_FILE_PATH.test(last) ? last : null;
}

/**
 * The skill drafted in a chat answer: the last `SKILL.md` in it (a block
 * labelled `SKILL.md` wins over unlabelled ones), with the reference files
 * labelled by path. An answer that is a bare SKILL.md counts too.
 *
 * @param {string} text - The answer's Markdown.
 * @returns {{name: string, description: string, body: string,
 *   files: Array<{path: string, content: string}>}|null}
 */
export function findSkillDraft(text) {
  if (typeof text !== 'string' || !text.includes('---')) return null;
  const blocks = fencedBlocks(text);
  let found = null;
  blocks.forEach((block, index) => {
    if (filePathOf(block)) return;
    const skill = parseSkillMarkdown(block.content);
    if (!skill) return;
    const labelled = /(^|[\s/"'=])SKILL\.md\b/i.test(block.info);
    if (!found || labelled || !found.labelled) found = { skill, index, labelled };
  });

  if (!found) {
    const skill = parseSkillMarkdown(text);
    return skill ? { ...skill, files: [] } : null;
  }

  const files = [];
  const seen = new Set();
  blocks.forEach((block, index) => {
    if (index === found.index) return;
    const path = filePathOf(block);
    if (!path || seen.has(path.toLowerCase()) || !block.content.trim()) return;
    seen.add(path.toLowerCase());
    files.push({ path, content: block.content });
  });
  return { ...found.skill, files };
}
