/**
 * @jest-environment node
 */
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Wording lint: the words iHub does not use (docs/glossary.md, "Words iHub does not use") must not
 * appear in text a user or an admin reads.
 *
 * The list is `shared/retired-words.json`. It is not in `shared/i18n/`, because the server reads
 * every JSON file in that folder as a UI language. For each word the test reads
 *
 * - scope `ui`: every text in `shared/i18n/en.json` and `de.json` (the files named by the word's
 *   `lang`), and `name` and `description` of every feature in `server/featureRegistry.js`;
 * - scope `docs`: the prose of every page under `docs/` (not code blocks, inline code or link
 *   targets), except the release notes and the glossary itself. Only words with one meaning carry
 *   this scope: "worker", "job" and "thread" are ordinary words in technical docs.
 *
 * A word matches at word boundaries and without regard to case: "job" finds "Jobs" and "job-id",
 * not "jobless". `{{placeholders}}` are not text and are skipped. Keys are not checked, nor are
 * code identifiers or the tool descriptions a model reads.
 *
 * When this fails on a text you wrote: use the word the message names. If the word has another
 * meaning in that text ("Job title"), add the key to the word's `allowKeys`.
 *
 * Text that predates the list is recorded in `retired-words-baseline.json`, by word and place.
 * That file can only shrink:
 *
 * - a hit that is not listed fails;
 * - a listed place that no longer has the word fails, so it cannot come back unnoticed;
 * - the number of listed places must equal `BASELINE_SIZE`. Removing an entry therefore means
 *   lowering that number in the same commit, and the freed place cannot be filled again later.
 *   Never raise the number.
 *
 * After rewording a listed text, write the file again and lower `BASELINE_SIZE` to the number the
 * failing size test names:
 *
 *   UPDATE_RETIRED_WORDS_BASELINE=1 npx jest --config tests/config/jest.config.js \
 *     tests/unit/client/retired-words.test.jsx
 *
 * The run only removes places: it writes nothing while a text holds a word in a place the file
 * does not list. What no test can see is a hand edit that removes one place and adds another in
 * the same commit; that shows in the diff of the file, where a new line is never right.
 *
 * The glossary shows the same list; the last tests keep page and file identical and check that
 * every term the glossary defines is on a page of the product.
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import retiredWords from '../../../shared/retired-words.json';
import { featureRegistry } from '../../../server/featureRegistry.js';
import { listDocPages } from '../../../server/utils/docsLibrary.js';
import { appRoutes, matchRoute } from '../../utils/appRoutes.js';
import baselineOnDisk from './retired-words-baseline.json';

/** The number of places the baseline lists. It only goes down, together with the file. */
const BASELINE_SIZE = 26;

const repoRoot = path.resolve(__dirname, '../../..');
const docsDir = path.join(repoRoot, 'docs');
const baselinePath = path.join(__dirname, 'retired-words-baseline.json');

const LANGS = ['en', 'de'];
const SCOPES = ['ui', 'docs'];
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const LETTER = '[\\p{L}\\p{N}_]';

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byCodeUnit = (a, b) => Number(a > b) - Number(a < b);

/** The expression that finds a word: its `match`, or the word and its plural with "s". */
function matcher(entry) {
  const body = entry.match ?? `${escapeRegExp(entry.word)}s?`;
  return new RegExp(`(?<!${LETTER})(?:${body})(?!${LETTER})`, 'iu');
}

const langsOf = entry => (entry.lang === '*' ? LANGS : [entry.lang]);

/** Every text of a locale object as `[dotted.key, text]`. */
function leafTexts(node, prefix = '') {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    leafTexts(value, prefix ? `${prefix}.${key}` : key)
  );
}

/** A UI text without its `{{placeholders}}`, which name variables and are never shown. */
const shownText = text => text.replace(/\{\{[^}]*\}\}/g, ' ');

/**
 * A line without its HTML comments. Each comment is cut out by its position, so
 * that no opening mark can be left over from two that overlapped.
 */
function withoutHtmlComments(line) {
  let text = line;
  let start = text.indexOf('<!--');
  while (start !== -1) {
    const end = text.indexOf('-->', start + 4);
    if (end === -1) break;
    text = `${text.slice(0, start)} ${text.slice(end + 3)}`;
    start = text.indexOf('<!--');
  }
  return text;
}

/** The prose lines of a Markdown page with the heading each one stands under. */
function proseWithHeadings(markdown) {
  const lines = [];
  let fence = null;
  let heading = '';
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1].startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const text = withoutHtmlComments(line.replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, '] '));
    // The heading names the place, so it keeps the words of its inline code.
    const headingMatch = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (headingMatch) {
      heading = headingMatch[1]
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[`*]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    lines.push({ heading, text });
  }
  return lines;
}

/**
 * Where the retired words occur.
 *
 * @param {Array<object>} words entries of `shared/retired-words.json`
 * @param {{ locales: Record<string, object>, features: Array<object>, docs: Array<[string, string]> }} sources
 *   `docs` as `[page, markdown]`
 * @returns {Record<string, string[]>} word → sorted places: `en:some.key`,
 *   `features:<id>.description.de`, `docs:<page>#<heading>`
 */
function findHits(words, { locales = {}, features = [], docs = [] }) {
  const hits = {};
  for (const entry of words) {
    const expression = matcher(entry);
    const allowed = new Set(entry.allowKeys ?? []);
    const places = new Set();
    if (entry.scopes.includes('ui')) {
      for (const lang of langsOf(entry)) {
        for (const [key, text] of leafTexts(locales[lang])) {
          if (!allowed.has(key) && expression.test(shownText(text))) places.add(`${lang}:${key}`);
        }
        for (const feature of features) {
          for (const field of ['name', 'description']) {
            const text = feature[field]?.[lang];
            if (typeof text === 'string' && expression.test(text)) {
              places.add(`features:${feature.id}.${field}.${lang}`);
            }
          }
        }
      }
    }
    if (entry.scopes.includes('docs')) {
      for (const [page, markdown] of docs) {
        for (const { heading, text } of proseWithHeadings(markdown)) {
          if (expression.test(text)) places.add(`docs:${page}${heading ? `#${heading}` : ''}`);
        }
      }
    }
    if (places.size > 0) hits[entry.word] = [...places].sort(byCodeUnit);
  }
  return hits;
}

/** Hits the baseline does not list, as one line each. */
function unlistedHits(hits, listed, words) {
  return Object.entries(hits).flatMap(([word, places]) => {
    const use = words.find(entry => entry.word === word)?.use;
    return places
      .filter(place => !(listed[word] ?? []).includes(place))
      .map(place => `"${word}" in ${place}. Write instead: ${use}`);
  });
}

/** Baseline entries that no longer have the word, as one line each. */
function staleEntries(hits, listed) {
  return Object.entries(listed).flatMap(([word, places]) =>
    places
      .filter(place => !(hits[word] ?? []).includes(place))
      .map(place => `${word}: remove ${place} from retired-words-baseline.json`)
  );
}

/** A baseline as the text of its file, laid out the way Prettier keeps it. */
function baselineText(record) {
  const entries = Object.entries(record);
  if (entries.length === 0) return '{}\n';
  const lines = entries.map(([word, places], i) => {
    const comma = i < entries.length - 1 ? ',' : '';
    const oneLine = `  ${JSON.stringify(word)}: [${places.map(place => JSON.stringify(place)).join(', ')}]${comma}`;
    if (oneLine.length <= 100) return oneLine;
    const each = places.map(place => `    ${JSON.stringify(place)}`).join(',\n');
    return `  ${JSON.stringify(word)}: [\n${each}\n  ]${comma}`;
  });
  return `{\n${lines.join('\n')}\n}\n`;
}

const placeCount = record => Object.values(record).reduce((sum, places) => sum + places.length, 0);

/**
 * What is wrong with the size of a baseline, or null. The size is pinned, not capped: a cap that
 * stays behind when the file shrinks leaves room for new places.
 */
function sizeProblem(record, size) {
  const count = placeCount(record);
  if (count === size) return null;
  return count < size
    ? `The baseline lists ${count} places, BASELINE_SIZE is ${size}. Lower BASELINE_SIZE to ${count}.`
    : `The baseline lists ${count} places, BASELINE_SIZE is ${size}. The baseline does not grow: ` +
        'reword the new texts and take their places out of retired-words-baseline.json.';
}

/**
 * The baseline an update run may write: today's hits, which is the file on disk without the
 * places that were reworded. Throws when a hit is not in the file, so the run cannot add a place.
 */
function shrunkBaseline(hits, listed, words) {
  const added = unlistedHits(hits, listed, words);
  if (added.length > 0) {
    throw new Error(
      'Not written: the baseline only loses places. Reword these texts instead of listing them:\n' +
        added.map(line => `  ${line}`).join('\n')
    );
  }
  return hits;
}

/** The rows of the first table under a `## heading` of a Markdown page, without the header. */
function tableUnder(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `## ${heading}`);
  if (start === -1) throw new Error(`heading "## ${heading}" not found`);
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (line.trim().startsWith('|')) rows.push(line);
    else if (rows.length > 0) break;
  }
  return rows.slice(2).map(row =>
    row
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map(cell => cell.trim().replace(/\\\|/g, '|'))
  );
}

const LANG_LABEL = { en: 'English', de: 'German', '*': 'English and German' };
const scopeLabel = scopes => (scopes.includes('docs') ? 'UI text and docs' : 'UI text');

const words = retiredWords.words;

describe('retired words', () => {
  let hits;
  let glossary;
  let baseline = baselineOnDisk;

  beforeAll(async () => {
    const pages = (await listDocPages(docsDir)).filter(page => page !== 'glossary.md');
    const docs = pages.map(page => [
      page,
      readFileSync(path.join(docsDir, ...page.split('/')), 'utf8')
    ]);
    hits = findHits(words, { locales: { en, de }, features: featureRegistry, docs });
    glossary = readFileSync(path.join(docsDir, 'glossary.md'), 'utf8');

    if (process.env.UPDATE_RETIRED_WORDS_BASELINE) {
      baseline = shrunkBaseline(hits, baselineOnDisk, words);
      writeFileSync(baselinePath, baselineText(baseline));
    }
  });

  test('the list is well-formed', () => {
    expect(words.length).toBeGreaterThan(0);
    const texts = { en: Object.fromEntries(leafTexts(en)), de: Object.fromEntries(leafTexts(de)) };
    const problems = [];
    for (const entry of words) {
      const name = entry.word;
      if (typeof name !== 'string' || !name.trim()) problems.push('an entry without a word');
      if (!Object.hasOwn(LANG_LABEL, entry.lang)) problems.push(`${name}: lang "${entry.lang}"`);
      if (typeof entry.use !== 'string' || !entry.use.trim()) problems.push(`${name}: no use`);
      if (
        !Array.isArray(entry.scopes) ||
        entry.scopes.length === 0 ||
        entry.scopes.some(scope => !SCOPES.includes(scope))
      ) {
        problems.push(`${name}: scopes ${JSON.stringify(entry.scopes)}`);
      }
      const unknown = Object.keys(entry).filter(
        key => !['word', 'lang', 'match', 'use', 'scopes', 'allowKeys'].includes(key)
      );
      if (unknown.length > 0) problems.push(`${name}: unknown fields ${unknown.join(', ')}`);
      let expression;
      try {
        expression = matcher(entry);
      } catch (error) {
        problems.push(`${name}: match does not compile (${error.message})`);
        continue;
      }
      if (!expression.test(name)) problems.push(`${name}: match does not find the word itself`);
      // An allowed key that is gone, or no longer holds the word, allows nothing: remove it.
      for (const key of entry.allowKeys ?? []) {
        const used = langsOf(entry).some(lang => expression.test(texts[lang][key] ?? ''));
        if (!used) problems.push(`${name}: allowKeys entry ${key} does not hold the word`);
      }
    }
    const names = words.map(entry => entry.word.toLowerCase());
    problems.push(
      ...names.filter((name, i) => names.indexOf(name) !== i).map(name => `${name}: listed twice`)
    );
    expect(problems).toEqual([]);
  });

  test('are not in UI text, the feature list or the docs, apart from the baseline', () => {
    expect(unlistedHits(hits, baseline, words)).toEqual([]);
  });

  test('have a baseline that lists only places that still hold the word', () => {
    expect(staleEntries(hits, baseline)).toEqual([]);
  });

  test('have a baseline kept sorted, one entry per place, for words on the list', () => {
    const known = new Set(words.map(entry => entry.word));
    expect(Object.keys(baseline).filter(word => !known.has(word))).toEqual([]);
    for (const [word, places] of Object.entries(baseline)) {
      expect(places.length).toBeGreaterThan(0);
      expect([word, places]).toEqual([word, [...new Set(places)].sort(byCodeUnit)]);
    }
  });

  // After an update run this fails until BASELINE_SIZE is lowered to the new size.
  test('have a baseline of exactly BASELINE_SIZE places, so it cannot grow back', () => {
    expect(sizeProblem(baseline, BASELINE_SIZE)).toBeNull();
  });

  test('are the same list as "Words iHub does not use" in docs/glossary.md', () => {
    expect(tableUnder(glossary, 'Words iHub does not use')).toEqual(
      words.map(entry => [entry.word, LANG_LABEL[entry.lang], entry.use, scopeLabel(entry.scopes)])
    );
  });

  // "The glossary describes no feature an admin cannot find in the product": a term is one the
  // UI shows in both languages, and the page the row names is a route of the client. Write one
  // term per cell, and a path in backticks in the last column.
  test('glossary terms are used in the UI in both languages and name a page that exists', () => {
    const routes = appRoutes();
    const texts = { en: leafTexts(en), de: leafTexts(de) };
    const usedIn = (lang, term) => {
      const expression = new RegExp(`(?<!${LETTER})${escapeRegExp(term)}(?!${LETTER})`, 'iu');
      return texts[lang].some(([, text]) => expression.test(text));
    };
    const rows = tableUnder(glossary, 'Terms');
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const problems = [];
    for (const [english, german, meaning, where] of rows) {
      if (!english || !usedIn('en', english)) problems.push(`"${english}" is in no English text`);
      if (!german || !usedIn('de', german)) problems.push(`"${german}" is in no German text`);
      if (!meaning) problems.push(`"${english}" has no meaning`);
      const pages = [...(where ?? '').matchAll(/`(\/[^`]*)`/g)].map(match => match[1]);
      if (pages.length === 0) problems.push(`"${english}" names no page`);
      for (const page of pages) {
        const route = matchRoute(page, routes);
        if (!route || route.redirectTo) problems.push(`"${english}": ${page} is not a page`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('glossary terms are not retired words', () => {
    const retired = words.map(matcher);
    const terms = tableUnder(glossary, 'Terms').flatMap(([english, german]) => [english, german]);
    expect(terms.filter(term => retired.some(expression => expression.test(term)))).toEqual([]);
  });
});

describe('the wording lint itself', () => {
  const entry = (word, extra = {}) => ({ word, lang: '*', use: 'x', scopes: ['ui'], ...extra });

  test.each(['thread', 'job', 'lease', 'steer', 'helper'])(
    'a new UI string with "%s" fails, in English and in German',
    word => {
      const locales = {
        en: { chat: { fresh: `Open the ${word} to continue` } },
        de: { chat: { fresh: `Den ${word[0].toUpperCase()}${word.slice(1)} öffnen` } }
      };
      const found = findHits(words, { locales });
      expect(found[word]).toEqual(['de:chat.fresh', 'en:chat.fresh']);
      expect(unlistedHits(found, baselineOnDisk, words)).toEqual([
        expect.stringContaining(`"${word}" in de:chat.fresh. Write instead: `),
        expect.stringContaining(`"${word}" in en:chat.fresh. Write instead: `)
      ]);
    }
  );

  test('the German words of the list fail in German text only', () => {
    const texts = {
      a: 'Ein Helfer übernimmt die Teilaufgaben',
      b: 'Der Geplante Agent und seine Workflow-Instanzen',
      c: 'Automatisierungen für alle'
    };
    const found = findHits(words, { locales: { en: texts, de: texts } });
    expect(found).toEqual({
      Helfer: ['de:a'],
      Teilaufgabe: ['de:a'],
      'Workflow-Instanz': ['de:b'],
      'Geplanter Agent': ['de:b'],
      Automatisierung: ['de:c']
    });
  });

  test('matches whole words in any case, with their plural, and across a hyphen', () => {
    const found = text => Boolean(findHits([entry('job')], { locales: { en: { key: text } } }).job);
    for (const text of ['Job', 'JOBS', 'the job.', 'job-id', '(jobs)', 'Hintergrund-Job']) {
      expect([text, found(text)]).toEqual([text, true]);
    }
    for (const text of ['jobless', 'Jobcenter', 'kojob', 'job_id', 'Aufgabe']) {
      expect([text, found(text)]).toEqual([text, false]);
    }
  });

  test('does not find a word inside another, such as lease in "release"', () => {
    const locales = { en: { a: 'Release notes', b: 'A worker thread', c: 'It steered the run' } };
    expect(findHits(words, { locales })).toEqual({
      thread: ['en:b'],
      steer: ['en:c'],
      worker: ['en:b']
    });
  });

  test('skips placeholders, which are variable names', () => {
    const locales = { en: { a: '{{worker}} of {{ job.count }}', b: '{{count}} workers' } };
    expect(findHits(words, { locales })).toEqual({ worker: ['en:b'] });
  });

  test('a key on allowKeys passes, the same text under another key does not', () => {
    const job = entry('job', { allowKeys: ['people.fields.jobTitle'] });
    const locales = {
      en: { people: { fields: { jobTitle: 'Job title' } }, runs: { title: 'Job title' } }
    };
    expect(findHits([job], { locales })).toEqual({ job: ['en:runs.title'] });
  });

  test('reads name and description of every feature', () => {
    const features = [
      { id: 'a', name: { en: 'Jobs', de: 'Läufe' }, description: { en: 'Runs', de: 'Jobs' } },
      { id: 'b', name: { en: 'Runs', de: 'Läufe' }, description: { en: 'Runs', de: 'Läufe' } }
    ];
    expect(findHits([entry('job')], { features })).toEqual({
      job: ['features:a.description.de', 'features:a.name.en']
    });
  });

  test('checks docs only for words with the docs scope, and only their prose', () => {
    const page = [
      '---',
      'description: "About a sub-task."',
      '---',
      '',
      '# Page',
      '',
      'A worker runs the job.',
      '',
      '## How it **works**',
      '',
      'Each subtask reports back. See [the list](sub-task.md) and `sub-task`.',
      '',
      '```json',
      '{ "sub-task": true }',
      '```',
      '',
      '### Later',
      '',
      'Nothing here.'
    ].join('\n');
    expect(findHits(words, { docs: [['guide/page.md', page]] })).toEqual({
      'sub-task': ['docs:guide/page.md', 'docs:guide/page.md#How it works']
    });
  });

  test('a listed place passes, a new place for the same word fails, a fixed place is stale', () => {
    const listed = { lease: ['en:abortCauses.lease_lost'] };
    const lease = [entry('lease', { use: 'plain words' })];
    const today = { lease: ['en:abortCauses.lease_lost'] };
    expect(unlistedHits(today, listed, lease)).toEqual([]);
    expect(staleEntries(today, listed)).toEqual([]);

    const grown = { lease: ['en:abortCauses.lease_lost', 'en:runs.takenOver'] };
    expect(unlistedHits(grown, listed, lease)).toEqual([
      '"lease" in en:runs.takenOver. Write instead: plain words'
    ]);

    expect(staleEntries({}, listed)).toEqual([
      'lease: remove en:abortCauses.lease_lost from retired-words-baseline.json'
    ]);
  });

  test('the size of the baseline is pinned: a shrink lowers the number, growth fails', () => {
    const listed = { lease: ['en:a', 'en:b'], job: ['de:c'] };
    expect(sizeProblem(listed, 3)).toBeNull();
    expect(sizeProblem({}, 0)).toBeNull();
    // One place was reworded and removed: the number has to follow, or it would be slack.
    expect(sizeProblem({ lease: ['en:a'], job: ['de:c'] }, 3)).toBe(
      'The baseline lists 2 places, BASELINE_SIZE is 3. Lower BASELINE_SIZE to 2.'
    );
    expect(sizeProblem({ ...listed, job: ['de:c', 'en:runs.title'] }, 3)).toMatch(
      /^The baseline lists 4 places, BASELINE_SIZE is 3\. The baseline does not grow/
    );
  });

  test('an update run only removes places from the baseline', () => {
    const lease = [entry('lease', { use: 'plain words' }), entry('job', { use: 'run' })];
    const listed = { lease: ['en:abortCauses.lease_lost', 'en:runs.takenOver'], job: ['en:a'] };

    // Nothing changed, one place reworded, a whole word reworded: the rest is written.
    expect(shrunkBaseline(listed, listed, lease)).toEqual(listed);
    const reworded = { lease: ['en:abortCauses.lease_lost'], job: ['en:a'] };
    expect(shrunkBaseline(reworded, listed, lease)).toEqual(reworded);
    expect(shrunkBaseline({ job: ['en:a'] }, listed, lease)).toEqual({ job: ['en:a'] });
    expect(shrunkBaseline({}, listed, lease)).toEqual({});

    // A new place is refused, also when a reworded one makes room for it under the old size.
    const traded = { lease: ['en:abortCauses.lease_lost'], job: ['en:a', 'en:runs.title'] };
    expect(placeCount(traded)).toBe(placeCount(listed));
    expect(() => shrunkBaseline(traded, listed, lease)).toThrow(
      'Not written: the baseline only loses places. Reword these texts instead of listing them:\n' +
        '  "job" in en:runs.title. Write instead: run'
    );
    // A word the file does not list at all.
    expect(() => shrunkBaseline({ job: ['en:a'] }, { lease: ['en:b'] }, lease)).toThrow(
      '"job" in en:a. Write instead: run'
    );
  });

  test('reads a glossary table, also with an escaped pipe in a cell', () => {
    const markdown = [
      '## Words',
      '',
      'Intro.',
      '',
      '| Word | Use |',
      '| ---- | --- |',
      '| job | run \\| Lauf |',
      '| lease |  |',
      '',
      'After.',
      '',
      '| not | this |'
    ].join('\n');
    expect(tableUnder(markdown, 'Words')).toEqual([
      ['job', 'run | Lauf'],
      ['lease', '']
    ]);
    expect(() => tableUnder(markdown, 'Missing')).toThrow('heading "## Missing" not found');
  });
});
