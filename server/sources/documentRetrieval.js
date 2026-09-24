/**
 * Section retrieval for text sources exposed as tools.
 *
 * A source tool used to return the whole source on every call. That breaks
 * as soon as the content is larger than one tool result may be: the agent
 * loop replaces a result above `policies.context.spillThresholdBytes` (64 KB)
 * with a 16 KB preview, so for the ~2 MB iHub Documentation the model only
 * ever saw the book's front matter. The whole document (~500K tokens) would
 * not fit most context windows anyway.
 *
 * Content that fits {@link RESULT_BUDGET_CHARS} is still returned whole.
 * Larger content is split into sections at its Markdown headings, and the
 * tool returns what the model asks for: the sections that best match `query`
 * (BM25 keyword ranking), one `section` by id, or, with neither, an outline
 * to choose from.
 *
 * @module sources/documentRetrieval
 */
import crypto from 'crypto';
import { estimateTokens } from '../../shared/tokenEstimator.js';

/**
 * Most characters one tool result carries. Stays below the loop's 64 KB spill
 * threshold with room for JSON escaping, multi-byte characters and metadata.
 */
export const RESULT_BUDGET_CHARS = 40000;

/** Roughly the tokens a result of {@link RESULT_BUDGET_CHARS} holds (chars / 4). */
export const RESULT_BUDGET_TOKENS = Math.round(RESULT_BUDGET_CHARS / 4);

/** Sections longer than this are searched (and paged) in parts. */
const MAX_PART_CHARS = 6000;
/** Most hits one search result returns. */
const MAX_SEARCH_RESULTS = 8;
/** A hit shorter than this also brings its subsections (up to one part's size). */
const EXPAND_BELOW_CHARS = 1500;
/** Parts scoring below this share of the best match are left out. */
const MIN_RELATIVE_SCORE = 0.2;
/** Headings deeper than this stay inside their parent section. */
const MAX_SECTION_LEVEL = 4;

// BM25 parameters, and the extra weight a term carries in a section's own
// heading and in its parents' headings.
const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 3;
const PATH_WEIGHT = 1;
/** Weight of a document term that only starts with the query term. */
const PREFIX_WEIGHT = 0.5;
const MAX_PREFIX_EXPANSIONS = 30;

const INDEX_CACHE_SIZE = 4;
const STATS_CACHE_SIZE = 64;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
// Written by scripts/export-docs-markdown.js before each consolidated file.
const SOURCE_MARKER_RE = /^<!--\s*Source:\s*(.+?)\s*-->\s*$/;
const WORD_RE = /[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu;
const CAMEL_SPLIT_RE = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})/u;
const LETTERS_ONLY_RE = /^\p{L}+$/u;
const PART_SUFFIX_RE = /^(.*)#(\d+)$/;

// English and German function words; they match nearly every section.
const STOPWORDS = new Set(
  (
    'a an and are as at be by can could do does for from has have how i if in into is it its ' +
    'me my no not of on or our should so than that the their them then there these they this ' +
    'those to was we were what when where which who why will with would you your ' +
    'am auch auf aus bei bin da das dass dem den der des die ein eine einem einen einer es ' +
    'für gibt hat ich im ist kann kein keine man mein meine mit nicht noch nur oder sich ' +
    'sie sind so um und uns von was welche welcher welches wenn wie wir wird zu zum zur über'
  ).split(' ')
);

// Stripped once, longest first, so inflected forms share a term
// ("configure", "configured", "configuration" → "configur").
const SUFFIXES = [
  'ations',
  'ation',
  'ungen',
  'ings',
  'ing',
  'ies',
  'ied',
  'ung',
  'ers',
  'ed',
  'es',
  'er',
  'en',
  'e'
];

function stem(term) {
  if (!LETTERS_ONLY_RE.test(term)) return term;
  for (const suffix of SUFFIXES) {
    if (term.length - suffix.length >= 4 && term.endsWith(suffix)) {
      return suffix === 'ies' || suffix === 'ied'
        ? `${term.slice(0, -3)}y`
        : term.slice(0, -suffix.length);
    }
  }
  if (term.length >= 4 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

/**
 * Split text into search terms: lower-cased, stemmed, without stop words.
 * Compound words keep their whole form next to their parts, so `exposeAs`,
 * `ihub-documentation` and `5.5.11` match both as written and piece by piece.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const terms = [];
  const push = raw => {
    const lower = raw.toLowerCase();
    if (lower.length < 2 || STOPWORDS.has(lower)) return;
    terms.push(stem(lower));
  };
  for (const [word] of String(text ?? '').matchAll(WORD_RE)) {
    const parts = word.split(/[._-]/);
    if (parts.length > 1) push(word);
    for (const part of parts) {
      const pieces = part.split(CAMEL_SPLIT_RE);
      if (pieces.length > 1) push(part);
      for (const piece of pieces) push(piece);
    }
  }
  return terms;
}

/**
 * URL-style id for a heading ("Sources System" → "sources-system").
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'section';
}

// Titles keep any `<…>` they contain (`<content>` blocks, `<appId>`): they
// are escaped wherever they are written out, never rendered as HTML.
function cleanHeading(raw) {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .trim();
}

/**
 * Split Markdown into sections at its headings (levels 1–4). Headings inside
 * fenced code blocks (`# comment` lines in shell snippets) are not headings.
 *
 * @param {string} content
 * @returns {Array<{id: string, title: string, level: number, path: string[],
 *   file: string|null, text: string}>} Sections in document order; `path`
 *   holds the titles of the enclosing sections, `file` the consolidated
 *   source file named by the last `<!-- Source: … -->` marker.
 */
export function splitSections(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const sections = [];
  const idCounts = new Map();
  const stack = [];
  let fence = null;
  let file = null;
  let current = { title: '', level: 0, path: [], file: null, lines: [] };

  const flush = () => {
    const text = current.lines.join('\n').trim();
    if (!text) return;
    const title = current.title || 'Introduction';
    const base = slugify(title);
    const count = (idCounts.get(base) || 0) + 1;
    idCounts.set(base, count);
    sections.push({
      id: count === 1 ? base : `${base}-${count}`,
      title,
      level: current.level,
      path: current.path,
      file: current.file,
      text
    });
  };

  for (const line of lines) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      current.lines.push(line);
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      fence = open[1];
      current.lines.push(line);
      continue;
    }
    const marker = SOURCE_MARKER_RE.exec(line);
    if (marker) {
      file = marker[1];
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading && heading[1].length <= MAX_SECTION_LEVEL) {
      flush();
      const level = heading[1].length;
      const title = cleanHeading(heading[2]) || 'Untitled';
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      current = { title, level, path: stack.map(s => s.title), file, lines: [line] };
      stack.push({ level, title });
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return sections;
}

/** Split text into blocks at blank lines, keeping fenced code blocks whole. */
function splitBlocks(text) {
  const blocks = [];
  let block = [];
  let fence = null;
  for (const line of text.split('\n')) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else {
      const open = FENCE_OPEN_RE.exec(line);
      if (open) fence = open[1];
      else if (!line.trim()) {
        if (block.length) blocks.push(block.join('\n'));
        block = [];
        continue;
      }
    }
    block.push(line);
  }
  if (block.length) blocks.push(block.join('\n'));
  return blocks;
}

/** Split a block that is longer than `maxChars` at line ends. */
function splitLongBlock(block, maxChars) {
  const pieces = [];
  let piece = '';
  for (const line of block.split('\n')) {
    if (line.length > maxChars) {
      if (piece) pieces.push(piece);
      piece = '';
      for (let i = 0; i < line.length; i += maxChars) pieces.push(line.slice(i, i + maxChars));
      continue;
    }
    if (piece && piece.length + line.length + 1 > maxChars) {
      pieces.push(piece);
      piece = '';
    }
    piece = piece ? `${piece}\n${line}` : line;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * Split one section's text into parts of at most `maxChars`, at paragraph
 * boundaries where possible.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function splitIntoParts(text, maxChars = MAX_PART_CHARS) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let part = '';
  for (const block of splitBlocks(text)) {
    const pieces = block.length > maxChars ? splitLongBlock(block, maxChars) : [block];
    for (const piece of pieces) {
      if (part && part.length + piece.length + 2 > maxChars) {
        parts.push(part);
        part = '';
      }
      part = part ? `${part}\n\n${piece}` : piece;
    }
  }
  if (part) parts.push(part);
  return parts;
}

function hashContent(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

/** Small insertion-ordered LRU on a Map. */
function cacheGet(cache, key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(cache, key, value, maxSize) {
  cache.set(key, value);
  if (cache.size > maxSize) cache.delete(cache.keys().next().value);
}

const statsCache = new Map();

/**
 * Size of a piece of source content, cached by content hash (tokenizing a
 * 2 MB document takes a few hundred milliseconds).
 * @param {string} content
 * @returns {{tokens: number, characters: number}}
 */
export function getContentStats(content) {
  const text = typeof content === 'string' ? content : '';
  const key = hashContent(text);
  const cached = cacheGet(statsCache, key);
  if (cached) return cached;
  const stats = { tokens: estimateTokens(text), characters: text.length };
  cacheSet(statsCache, key, stats, STATS_CACHE_SIZE);
  return stats;
}

const indexCache = new Map();

/**
 * Sections, searchable parts and an inverted index for `content`, cached by
 * content hash so a document is indexed once, not on every tool call.
 * @param {string} content
 */
export function getDocumentIndex(content) {
  const key = hashContent(content);
  const cached = cacheGet(indexCache, key);
  if (cached) return cached;

  const sections = splitSections(content);
  const parts = [];
  const postings = new Map();
  let totalLength = 0;

  sections.forEach((section, sectionIndex) => {
    const texts = splitIntoParts(section.text);
    const titleTerms = tokenize(section.title);
    const pathTerms = tokenize(section.path.join(' '));
    texts.forEach((text, i) => {
      const bodyTerms = tokenize(text);
      const tf = new Map();
      const add = (term, weight) => tf.set(term, (tf.get(term) || 0) + weight);
      for (const term of bodyTerms) add(term, 1);
      for (const term of titleTerms) add(term, TITLE_WEIGHT);
      for (const term of pathTerms) add(term, PATH_WEIGHT);

      const partIndex = parts.length;
      const length = bodyTerms.length + titleTerms.length;
      totalLength += length;
      parts.push({ sectionIndex, part: i + 1, partCount: texts.length, text, length });
      for (const [term, weight] of tf) {
        let list = postings.get(term);
        if (!list) postings.set(term, (list = []));
        list.push(partIndex, weight);
      }
    });
  });

  const index = {
    sections,
    parts,
    postings,
    avgLength: parts.length ? totalLength / parts.length : 0,
    ...getContentStats(content)
  };
  cacheSet(indexCache, key, index, INDEX_CACHE_SIZE);
  return index;
}

/** The query term itself plus the indexed terms it is a prefix of. */
function expandTerm(index, term) {
  const expansions = [];
  if (index.postings.has(term)) expansions.push([term, 1]);
  if (term.length < 4) return expansions;
  const prefixed = [];
  for (const [candidate, list] of index.postings) {
    if (candidate !== term && candidate.startsWith(term)) prefixed.push([candidate, list.length]);
  }
  prefixed
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PREFIX_EXPANSIONS)
    .forEach(([candidate]) => expansions.push([candidate, PREFIX_WEIGHT]));
  return expansions;
}

/**
 * Rank the document's parts for `query` with BM25; parts that match more of
 * the query's terms get up to twice their score.
 * @returns {Array<{partIndex: number, score: number}>} best first
 */
export function searchDocument(index, query) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !index.parts.length) return [];

  const count = index.parts.length;
  const scores = new Float64Array(count);
  const matchedTerms = new Uint16Array(count);

  for (const term of terms) {
    const hit = new Set();
    for (const [docTerm, weight] of expandTerm(index, term)) {
      const list = index.postings.get(docTerm);
      const df = list.length / 2;
      const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
      for (let i = 0; i < list.length; i += 2) {
        const partIndex = list[i];
        const tf = list[i + 1];
        const norm = 1 - B + (B * index.parts[partIndex].length) / (index.avgLength || 1);
        scores[partIndex] += (weight * idf * tf * (K1 + 1)) / (tf + K1 * norm);
        hit.add(partIndex);
      }
    }
    for (const partIndex of hit) matchedTerms[partIndex]++;
  }

  const results = [];
  for (let i = 0; i < count; i++) {
    if (scores[i] > 0) {
      results.push({ partIndex: i, score: scores[i] * (1 + matchedTerms[i] / terms.length) });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.partIndex - b.partIndex);
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function partId(section, part, partCount) {
  return partCount > 1 && part > 1 ? `${section.id}#${part}` : section.id;
}

function renderPart(index, partIndex) {
  const { sectionIndex, part, partCount, text } = index.parts[partIndex];
  const section = index.sections[sectionIndex];
  const attributes = [
    `id="${escapeAttribute(partId(section, part, partCount))}"`,
    `path="${escapeAttribute([...section.path, section.title].join(' › '))}"`
  ];
  if (partCount > 1) attributes.push(`part="${part}/${partCount}"`);
  if (section.file) attributes.push(`file="${escapeAttribute(section.file)}"`);
  return `<section ${attributes.join(' ')}>\n${text}\n</section>`;
}

/**
 * Indented list of section ids and titles, as deep as fits `budgetChars`.
 * @returns {string}
 */
export function renderOutline(index, budgetChars) {
  const line = s => `${'  '.repeat(Math.max(0, s.level - 1))}- ${s.id}: ${s.title}`;
  for (const maxLevel of [2, 1]) {
    const lines = index.sections.filter(s => s.level <= maxLevel).map(line);
    const text = lines.join('\n');
    if (text.length <= budgetChars) return text;
    if (maxLevel === 1) {
      let used = 0;
      const kept = [];
      for (const entry of lines) {
        if (used + entry.length + 1 > budgetChars - 40) break;
        kept.push(entry);
        used += entry.length + 1;
      }
      return `${kept.join('\n')}\n… ${lines.length - kept.length} more sections`;
    }
  }
  return '';
}

/**
 * Find the first part of the section `ref` names: a section id, optionally
 * with `#n` for its n-th part, or a heading title.
 * @returns {number} part index, or -1
 */
function findPart(index, ref) {
  const wanted = String(ref).trim();
  const match = PART_SUFFIX_RE.exec(wanted);
  const name = match ? match[1] : wanted;
  const partNumber = match ? Number(match[2]) : 1;

  const lower = name.toLowerCase();
  const slug = slugify(name);
  const candidates = [
    s => s.id === name,
    s => s.id === slug,
    s => s.title.toLowerCase() === lower,
    s => s.title.toLowerCase().includes(lower)
  ];
  for (const matches of candidates) {
    const sectionIndex = index.sections.findIndex(matches);
    if (sectionIndex === -1) continue;
    const first = index.parts.findIndex(p => p.sectionIndex === sectionIndex);
    const part = Math.min(Math.max(partNumber, 1), index.parts[first].partCount);
    return first + part - 1;
  }
  return -1;
}

const formatNumber = n => Math.round(n).toLocaleString('en-US');

function tooLargeNote(name, index) {
  return (
    `"${name}" is too large to return in full ` +
    `(~${formatNumber(index.tokens)} tokens in ${formatNumber(index.sections.length)} sections).`
  );
}

const USAGE_NOTE =
  'Call this tool again with `query` set to other keywords to search for something else, ' +
  'or with `section` set to a section id to read that section and its subsections ' +
  '(an id ending in "#2", "#3", … continues a long section).';

function outlineResult(index, lead, budgetChars) {
  const header =
    `${lead}\n\nPass \`query\` with keywords from the question to get the sections that ` +
    'match it, or `section` with an id from this outline to read that section.\n\nOutline:\n';
  return {
    text: header + renderOutline(index, budgetChars - header.length),
    sections: []
  };
}

/** Id of a part, as the model passes it back in `section`. */
function idOfPart(index, partIndex) {
  const { sectionIndex, part, partCount } = index.parts[partIndex];
  return partId(index.sections[sectionIndex], part, partCount);
}

/**
 * Index after the last part of the section that `start` belongs to and of its
 * subsections: the next heading of the same or a higher level.
 */
function subtreeEnd(index, start) {
  const { level } = index.sections[index.parts[start].sectionIndex];
  let end = start + 1;
  while (end < index.parts.length) {
    const { part, sectionIndex } = index.parts[end];
    if (part === 1 && index.sections[sectionIndex].level <= level) break;
    end++;
  }
  return end;
}

function searchResult(index, name, query, budgetChars) {
  const ranked = searchDocument(index, query);
  if (!ranked.length) {
    return outlineResult(
      index,
      `${tooLargeNote(name, index)} No section matches "${query}". Try other keywords ` +
        '(synonyms, English terms, configuration keys) or pick a section from the outline.',
      budgetChars
    );
  }

  const best = ranked[0].score;
  const included = new Set();
  const groups = [];
  let used = 0;
  for (const { partIndex, score } of ranked) {
    if (groups.length >= MAX_SEARCH_RESULTS || score < best * MIN_RELATIVE_SCORE) break;
    if (included.has(partIndex)) continue;

    // A short hit is mostly a heading ("Version 5.5.11 › Breaking Changes")
    // whose content sits in its subsections, so bring those along.
    const members = [partIndex];
    const hit = index.parts[partIndex];
    let note = '';
    if (hit.partCount === 1 && hit.text.length < EXPAND_BELOW_CHARS) {
      let chars = hit.text.length;
      const end = subtreeEnd(index, partIndex);
      for (let i = partIndex + 1; i < end; i++) {
        if (included.has(i)) continue;
        if (chars + index.parts[i].text.length > MAX_PART_CHARS) {
          note =
            `\n\n(More subsections follow: call this tool again with \`section\` set to ` +
            `"${idOfPart(index, partIndex)}" to read all of them.)`;
          break;
        }
        members.push(i);
        chars += index.parts[i].text.length;
      }
    }

    const rendered = members.map(i => renderPart(index, i)).join('\n\n') + note;
    if (used + rendered.length + 2 > budgetChars) continue;
    members.forEach(i => included.add(i));
    groups.push({ members, rendered });
    used += rendered.length + 2;
  }

  const header =
    `${tooLargeNote(name, index)} These are the parts of it that best match "${query}", ` +
    `best match first. ${USAGE_NOTE}`;
  return {
    text: `${header}\n\n${groups.map(g => g.rendered).join('\n\n')}`,
    sections: groups.flatMap(g => g.members.map(i => idOfPart(index, i)))
  };
}

function sectionResult(index, name, ref, budgetChars) {
  const start = findPart(index, ref);
  if (start === -1) {
    return outlineResult(
      index,
      `${tooLargeNote(name, index)} There is no section "${ref}".`,
      budgetChars
    );
  }

  const end = subtreeEnd(index, start);
  const rendered = [];
  const ids = [];
  let used = 0;
  let next = start;
  while (next < end) {
    const text = renderPart(index, next);
    if (rendered.length && used + text.length + 2 > budgetChars) break;
    rendered.push(text);
    ids.push(idOfPart(index, next));
    used += text.length + 2;
    next++;
  }

  let footer = '';
  if (next < end) {
    const id = idOfPart(index, next);
    footer = `\n\nThe section continues: call this tool again with \`section\` set to "${id}".`;
  }
  return {
    text: `${tooLargeNote(name, index)} ${USAGE_NOTE}\n\n${rendered.join('\n\n')}${footer}`,
    sections: ids
  };
}

/**
 * Pick what one tool call returns from a text source.
 *
 * @param {string} content - The source's full text
 * @param {Object} [options]
 * @param {string} [options.query] - Keywords to search for
 * @param {string} [options.section] - Section id (or title) to read
 * @param {string} [options.name] - Source name, used in the result's notes
 * @param {number} [options.budgetChars] - Most characters to return
 * @returns {{content: string, retrieval: Object}} The text to return and a
 *   description of how it was chosen (`mode`: full, search, section, outline)
 */
export function selectContent(content, options = {}) {
  const text = typeof content === 'string' ? content : '';
  const { name = 'This source', budgetChars = RESULT_BUDGET_CHARS } = options;
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  const section = typeof options.section === 'string' ? options.section.trim() : '';

  if (text.length <= budgetChars) {
    return { content: text, retrieval: { mode: 'full' } };
  }

  const index = getDocumentIndex(text);
  let mode;
  let result;
  if (section) {
    mode = 'section';
    result = sectionResult(index, name, section, budgetChars);
  } else if (query) {
    mode = 'search';
    result = searchResult(index, name, query, budgetChars);
  } else {
    mode = 'outline';
    result = outlineResult(index, `${tooLargeNote(name, index)} This is its outline.`, budgetChars);
  }

  return {
    content: result.text,
    retrieval: {
      mode: result.sections.length ? mode : 'outline',
      ...(query ? { query } : {}),
      ...(section ? { section } : {}),
      sections: result.sections,
      totalSections: index.sections.length,
      totalTokens: index.tokens,
      returnedTokens: estimateTokens(result.text)
    }
  };
}
